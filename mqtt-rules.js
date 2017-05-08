// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var Jexl = require('jexl')

const rules = require('./homeautomation-js-lib/rules.js')
const logging = require('./homeautomation-js-lib/logging.js')
const pushover = require('pushover-notifications')
const Queue = require('bull')
const schedule = require('node-schedule')
const SolarCalc = require('solar-calc')
const moment = require('moment')

require('./homeautomation-js-lib/devices.js')
require('./homeautomation-js-lib/mqtt_helpers.js')

const solarLat = process.env.LOCATION_LAT
const solarLong = process.env.LOCATION_LONG

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT
const redisDB = process.env.REDIS_DATABASE
const config_path = process.env.TRANSFORM_CONFIG_PATH

// Config
const host = process.env.MQTT_HOST

// Setup MQTT
var client = mqtt.connect(host)

// MQTT Observation

client.on('connect', () => {
    logging.info('MQTT Connected', {
        action: 'mqtt-connected'
    })
    client.subscribe('#')
})

client.on('disconnect', () => {
    logging.error('Disconnected', {
        action: 'mqtt-disconnected'
    })
    client.connect(host)
})

function update_topic_for_expression(topic) {
    topic = topic.replace(/\//g, '________')
    topic = topic.replace(/-/g, '_')
    return topic
}

function isValueAnExpression(value) {
    return (value.includes('/') || value.includes('?') || value.includes('+'))
}

var actionQueues = {}

function jobProcessor(job, doneAction) {
    const actions = job.data.actions
    const notify = job.data.notify
    const name = job.data.name
    const context = job.data.context
        // const message = job.data.message
        // const topic = job.data.topic
        // const expression = job.data.expression

    logging.debug('action queue: ' + name + '    begin')
    if (actions !== null && actions !== undefined) {
        Object.keys(actions).forEach(function(resultTopic) {
            const publishValue = actions[resultTopic]
            logging.debug('evaluating for publish: ' + resultTopic + '  value: ' + publishValue)

            if (isValueAnExpression(publishValue)) {
                const publishExpression = update_topic_for_expression(publishValue)
                var jexl = new Jexl.Jexl()

                jexl.eval(publishExpression, context, function(publishError, publishResult) {
                    logging.info('  done evaluating publish expression for =>(' + name + ')', {
                        action: 'publish-expression-evaluation-done',
                        rule_name: name,
                        expression: publishExpression,
                        result: publishResult,
                        topic: resultTopic,
                        error: publishError,
                        value: publishValue
                    })

                    client.publish(resultTopic, '' + publishResult)
                    logging.info(' published result', {
                        action: 'published-value',
                        rule_name: name,
                        expression: publishExpression,
                        result: publishResult,
                        topic: resultTopic,
                        error: publishError,
                        value: publishValue
                    })
                })

            } else {
                logging.info(' published result', {
                    action: 'published-value',
                    rule_name: name,
                    topic: resultTopic,
                    value: publishValue
                })
                client.publish(resultTopic, '' + publishValue)
            }
        }, this)
    }

    if (notify !== null && notify !== undefined) {
        const baseAppToken = process.env.PUSHOVER_APP_TOKEN
        const baseUserToken = process.env.PUSHOVER_USER_TOKEN

        var p = new pushover({
            user: (notify.user ? notify.user : baseUserToken),
            token: (notify.token ? notify.token : baseAppToken)
        })

        var msg = {
            // These values correspond to the parameters detailed on https://pushover.net/api
            // 'message' is required. All other values are optional.
            message: notify.message,
            title: notify.title,
            sound: notify.sound,
            device: notify.device,
            priority: notify.priority,
            url: notify.url,
            url_title: notify.url_title,
        }

        p.send(msg, function(err, result) {
            var json = notify
            json.action = 'notify'
            json.rule_name = name
            if (err !== null && err !== undefined) {
                json.error = err
                logging.info(' failed notification', json)
            } else {
                logging.info(' successfully notified', json)
            }
        })
    }
    logging.debug('action queue: ' + name + '    end')
    doneAction()
}

var evalQueues = {}

function evaluateProcessor(job, doneEvaluate) {
    const name = job.data.name
    const context = job.data.context_value
    const rule = job.data.rule
    const allowed_times = rule.allowed_times

    var logResult = {
        action: 'rule-time-evaluation',
        rule_name: name,
        rule: rule,
        allowed_times: allowed_times,
        context: context
    }
    var isOKTime = true

    logging.debug('eval queue: ' + name + '    begin')

    if (allowed_times !== null && allowed_times !== undefined) {
        isOKTime = false

        allowed_times.forEach(function(timeRange) {
            const split = timeRange.split('-')
            logging.debug(' time range from: ' + split[0] + '   to: ' + split[1])

            const startDate = moment(new Date())
            const endDate = moment(new Date())

            const startHours = split[0].split(':')[0]
            const startMinutes = split[0].split(':')[1]

            const endHours = split[1].split(':')[0]
            const endMinutes = split[1].split(':')[1]

            startDate.hours(Number(startHours))
            startDate.minutes(Number(startMinutes))
            endDate.hours(Number(endHours))
            endDate.minutes(Number(endMinutes))

            const result = moment(new Date()).isBetween(startDate, endDate)
            if (result == true) {
                isOKTime = true
            }
        }, this)
    }

    if (!isOKTime) {
        logging.info('not evaluating, bad time =>(' + name + ')', logResult)
        logging.debug('eval queue: ' + name + '    end - not a good time')
        doneEvaluate()
        return
    }

    const performAction = function(eval_result, context, name, rule) {
        if (eval_result === true) {
            const actions = rule.actions
            const notify = rule.notify
            var perform_after = rule.perform_after
            if (perform_after === undefined || perform_after === null) {
                perform_after = 0
            }
            const queueName = name + '_action'
            var actionQueue = actionQueues[queueName]
            if (actionQueue !== null && actionQueue !== undefined) {

                logging.info('cancelled existing action queue =>(' + queueName + ')', Object.assign(logResult, {
                    queue_name: queueName
                }))

                actionQueue.empty()
            }

            actionQueue = Queue(queueName, redisPort, redisHost)
            actionQueues[queueName] = actionQueue

            actionQueue.process(jobProcessor)

            logging.info('enqueued action =>(' + queueName + ')', Object.assign(logResult, {
                action: 'enqueued-action',
                delay: perform_after,
                actions: actions,
                notify: notify,
                queue_name: queueName
            }))
            actionQueue.add({
                rule_name: name,
                notify: notify,
                actions: actions,
                context: context
            }, {
                removeOnComplete: true,
                removeOnFail: true,
                delay: (perform_after * 1000), // milliseconds
            })
        }
    }

    if (rule.rules !== null && rule.rules !== undefined && rule.rules.expression !== undefined) {
        const expression = update_topic_for_expression(rule.rules.expression)
        var jexl = new Jexl.Jexl()

        jexl.eval(expression, context, function(error, result) {
            logging.info('  =>(' + name + ') evaluated expression', Object.assign(logResult, {
                action: 'evaluated-expression',
                result: result,
                error: error
            }))
            performAction(result, context, name, rule)
            logging.debug('eval queue: ' + name + '    end expression')
            doneEvaluate()
        })
    } else {
        logging.info('  =>(' + name + ') skipped evaluated expression', Object.assign(logResult, {
            action: 'no-expression-to-evaluate'
        }))
        performAction(true, context, name, rule)
        logging.debug('eval queue: ' + name + '    end expression - no expression')
        doneEvaluate()
    }
}

function evalulateValue(in_context, name, rule) {

    const queueName = name + '_eval'
    var evalQueue = evalQueues[queueName]

    if (evalQueue !== null && evalQueue !== undefined) {
        evalQueue.empty()
    }

    const actionQueueName = name + '_action'
    var actionQueue = actionQueues[actionQueueName]
    if (actionQueue !== null && actionQueue !== undefined) {
        actionQueue.empty()
    }

    var evaluateAfter = rule.evaluate_after
    if (evaluateAfter === undefined || evaluateAfter === null) {
        evaluateAfter = 0
    }

    evalQueue = Queue(queueName, redisPort, redisHost)
    evalQueues[queueName] = evalQueue

    evalQueue.process(evaluateProcessor)

    var job = {
        rule: rule,
        name: '' + name,
        context_value: {}
    }

    Object.keys(in_context).forEach(function(key) {
        job.context_value[key] = '' + in_context[key]
    }, this)

    logging.info('enqueued expression evaluation =>(' + queueName + ')', {
        action: 'enqueued-evaluation',
        delay: evaluateAfter,
        rule_name: name,
        rule: rule,
        queue_name: queueName
    })

    evalQueue.add(job, {
        removeOnComplete: true,
        removeOnFail: true,
        delay: (evaluateAfter * 1000), // milliseconds
    })
}

var global_value_cache = {}

client.on('message', (topic, message) => {
    //logging.info(' ' + topic + ':' + message)
    var cachedValue = global_value_cache[topic]

    if (cachedValue !== null && cachedValue !== undefined) {
        if (('' + message).localeCompare(cachedValue) === 0) {
            logging.info(' => value not updated', {
                action: 'skipped-processing',
                reason: 'value-not-updated',
                topic: topic,
                message: message
            })
            return
        }
    }
    global_value_cache[topic] = message

    redis.keys('*', function(err, result) {
        const keys = result.sort()
        redis.mget(keys, function(err, values) {
            var context = {}

            for (var index = 0; index < keys.length; index++) {
                const key = keys[index]
                const value = values[index]
                const newKey = update_topic_for_expression(key)
                if (key === topic)
                    context[newKey] = message
                else
                    context[newKey] = value
            }

            context[update_topic_for_expression(topic)] = message

            rules.ruleIterator(function(rule_name, rule) {
                const watch = rule.watch
                if (watch == null || watch == undefined)
                    return
                const devices = watch.devices
                if (devices == null || devices == undefined)
                    return

                if (devices.indexOf(topic) !== -1) {
                    logging.info('matched topic to rule', {
                        action: 'rule-match',
                        rule_name: rule_name,
                        topic: topic,
                        message: message,
                        rule: rule,
                        context: context
                    })

                    evalulateValue(context, rule_name, rule)
                }
            })
        })
    })
})

const redis = Redis.createClient({
    host: redisHost,
    port: redisPort,
    db: redisDB,
    retry_strategy: function(options) {
        if (options.error && options.error.code === 'ECONNREFUSED') {
            // End reconnecting on a specific error and flush all commands with a individual error
            return new Error('The server refused the connection')
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
            // End reconnecting after a specific timeout and flush all commands with a individual error
            return new Error('Retry time exhausted')
        }
        if (options.times_connected > 10) {
            // End reconnecting with built in error
            return undefined
        }
        // reconnect after
        return Math.min(options.attempt * 100, 3000)
    }
})

// redis callbacks

redis.on('error', function(err) {
    logging.error('redis error ' + err, {
        action: 'redis-error',
        error: err
    })
})

redis.on('connect', function() {
    logging.info('redis connected ', {
        action: 'redis-connected'
    })

    rules.load_path(config_path)
})

rules.on('rules-loaded', () => {
    logging.info('rules loaded ', {
        action: 'rules-loaded'
    })
    scheduleJobs()
})


var scheduled_jobs = []

function doSchedule(rule_name, jobName, cronSchedule, rule) {
    var newJob = schedule.scheduleJob(cronSchedule, function(rule_value) {
        logging.info('job fired ', {
            action: 'scheduled-job-fired',
            schedule: cronSchedule,
            job: jobName,
            rule_name: rule_name,
            rule: rule

        })

        redis.keys('*', function(err, result) {
            const keys = result.sort()
            redis.mget(keys, function(err, values) {
                var context = {}

                for (var index = 0; index < keys.length; index++) {
                    const key = keys[index]
                    const value = values[index]
                    const newKey = update_topic_for_expression(key)
                    context[newKey] = value
                }

                logging.info('evaluating ', {
                    action: 'scheduled-job-evaluate',
                    rule_name: rule_name,
                    rule: rule,
                    context: context
                })

                evalulateValue(
                    context,
                    rule_name,
                    rule)
            })
        })
    }.bind(null, rule))

    if (newJob !== null && newJob !== undefined) {
        logging.info('job scheduled ', {
            action: 'job-scheduled',
            schedule: cronSchedule,
            job: jobName,
            rule_name: rule_name,
            rule: rule

        })


        scheduled_jobs.push(newJob)
    }
}

function scheduleJobs() {
    logging.info('scheduling jobs ', {
        action: 'schedule-jobs'
    })

    scheduleDailyJobs()

    scheduled_jobs.forEach(function(job) {
        job.cancel()
    }, this)

    rules.ruleIterator(function(rule_name, rule) {
        const schedule = rule.schedule
        const daily = rule.daily

        if (schedule !== null && schedule !== undefined) {
            Object.keys(schedule).forEach(function(schedule_key) {
                var jobKey = rule_name + '.schedule.' + schedule_key
                const cronSchedule = schedule[schedule_key]
                logging.debug(jobKey + ' = ' + cronSchedule)

                doSchedule(rule_name, jobKey, cronSchedule, rule)
            }, this)
        }

        if (daily !== null && daily !== undefined) {

            Object.keys(daily).forEach(function(daily_key) {
                var solar = new SolarCalc(new Date(), Number(solarLat), Number(solarLong))
                var jobKey = rule_name + '.daily.' + daily_key
                const dailyValue = daily[daily_key]
                var offset = 0
                if (dailyValue !== null && dailyValue !== undefined) {
                    if (dailyValue.offset === null || dailyValue.offset === undefined)
                        offset = 0
                    else
                        offset = Number(dailyValue.offset)
                }

                var date = null

                if (daily_key === 'sunrise')
                    date = solar.sunrise
                else if (daily_key === 'sunset')
                    date = solar.sunset
                else if (daily_key === 'civilDawn')
                    date = solar.civilDawn
                else if (daily_key === 'nauticalDawn')
                    date = solar.nauticalDawn
                else if (daily_key === 'astronomicalDawn')
                    date = solar.astronomicalDawn
                else if (daily_key === 'civilDusk')
                    date = solar.civilDusk
                else if (daily_key === 'nauticalDusk')
                    date = solar.nauticalDusk
                else if (daily_key === 'astronomicalDusk')
                    date = solar.astronomicalDusk
                else if (daily_key === 'solarNoon')
                    date = solar.solarNoon


                logging.debug(jobKey + ' offset: ' + offset)
                if (date !== null) {
                    var newDate = moment(date).add(offset, 'minutes')
                    doSchedule(rule_name, jobKey, newDate.toDate(), rule)
                }

            }, this)
        }
    })
}

var dailyJob = null

function scheduleDailyJobs() {
    if (dailyJob !== null)
        return

    logging.info('Scheduling Daily Job ', {
        action: 'schedule-daily-job'
    })

    dailyJob = schedule.scheduleJob('00 00 00 * * * ', function() {
        logging.info('Daily job fired ', {
            action: 'scheduled-daily-job'
        })

        scheduleJobs()
    })
}