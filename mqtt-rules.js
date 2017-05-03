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

const syslogHost = process.env.SYSLOG_HOST
const syslogPort = process.env.SYSLOG_PORT

// Config
const host = process.env.MQTT_HOST

// Set up modules
logging.set_enabled(true)
logging.setRemoteHost(syslogHost, syslogPort)

// Setup MQTT
var client = mqtt.connect(host)

// MQTT Observation

client.on('connect', () => {
    logging.log('Reconnecting...\n')
    client.subscribe('#')
})

client.on('disconnect', () => {
    logging.log('Reconnecting...\n')
    client.connect(host)
})

function update_topic_for_expression(topic) {
    topic = topic.replace(/\//g, '________')
    topic = topic.replace(/-/g, '_')
    return topic
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

    logging.log('action queue: ' + name + '    begin')
    if (actions !== null && actions !== undefined) {
        Object.keys(actions).forEach(function(resultTopic) {
            const publishValue = actions[resultTopic]
            logging.log('evaluating for publish: ' + resultTopic + '  value: ' + publishValue)

            const publishExpression = update_topic_for_expression(publishValue)
            var jexl = new Jexl.Jexl()

            jexl.eval(publishExpression, context, function(error, publishResult) {
                logging.log('  =>(' + name + ') evaluated expression: ' + publishExpression + '   result: ' + publishResult + '   error: ' + error)
                client.publish(resultTopic, '' + publishResult)
            })
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
            if (err !== null && err !== undefined) {
                logging.log('notify error: ' + err)
                logging.log('result: ' + result)
            } else {
                logging.log(' => Successfully notified')
            }
        })
    }
    logging.log('action queue: ' + name + '    end')
    doneAction()
}

var evalQueues = {}

function evaluateProcessor(job, doneEvaluate) {
    const name = job.data.name
    const context = job.data.context_value
    const rule = job.data.rule
    const allowed_times = rule.allowed_times

    var isOKTime = true

    logging.log('eval queue: ' + name + '    begin')

    if (allowed_times !== null && allowed_times !== undefined) {
        isOKTime = false

        allowed_times.forEach(function(timeRange) {
            const split = timeRange.split('-')
            logging.log(' time range from: ' + split[0] + '   to: ' + split[1])

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
        logging.log('eval queue: ' + name + '    end - not a good time')
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
                logging.log('removed existing action queue: ' + queueName)
                actionQueue.empty()
            }

            actionQueue = Queue(queueName, redisPort, redisHost)
            actionQueues[queueName] = actionQueue

            actionQueue.process(jobProcessor)

            actionQueue.add({
                name: name,
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
        if (rule.rules.expression.includes('/')) {

            const expression = update_topic_for_expression(rule.rules.expression)
            var jexl = new Jexl.Jexl()

            jexl.eval(expression, context, function(error, result) {
                logging.log('  =>(' + name + ') evaluated expression: ' + expression + '   result: ' + result + '   error: ' + error)
                performAction(result, context, name, rule)
                logging.log('eval queue: ' + name + '    end expression')
                doneEvaluate()
            })
        } else {
            performAction(true, context, name, rule)
            logging.log('eval queue: ' + name + '    end expression - no /')
            doneEvaluate
        }
    } else {
        performAction(true, context, name, rule)
        logging.log('eval queue: ' + name + '    end expression - skip rule')
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

    evalQueue.add(job, {
        removeOnComplete: true,
        removeOnFail: true,
        delay: (evaluateAfter * 1000), // milliseconds
    })
}

var global_value_cache = {}

client.on('message', (topic, message) => {
    //logging.log(' ' + topic + ':' + message)

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
                    logging.log('found watch: ' + rule_name)
                    var cachedValues = global_value_cache[rule_name]
                    if (cachedValues === null || cachedValues === undefined) {
                        cachedValues = {}
                    }
                    var cachedValue = cachedValues[topic]

                    if (cachedValue !== null && cachedValue !== undefined) {
                        if (('' + message).localeCompare(cachedValue) === 0) {
                            logging.log(' => value not updated')
                                //return
                        }
                    }
                    cachedValues[topic] = message
                    global_value_cache[rule_name] = cachedValues

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
    logging.log('redis error ' + err)
})

redis.on('connect', function() {
    logging.log('redis connected')
    rules.load_path(config_path)
})

rules.on('rules-loaded', () => {
    logging.log('rules-loaded!')
    scheduleJobs()
})


var scheduled_jobs = []

function doSchedule(rule_name, jobName, cronSchedule, rule) {
    var newJob = schedule.scheduleJob(cronSchedule, function(rule_value) {
        logging.log(' rule: ' + rule_value)

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

                logging.log('matching rule: ' + rule_name)

                evalulateValue(
                    context,
                    rule_name,
                    rule)
            })
        })
    }.bind(null, rule))

    if (newJob !== null && newJob !== undefined) {
        logging.log(' scheduled: ' + cronSchedule)
        scheduled_jobs.push(newJob)
    }
}

function scheduleJobs() {
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
                logging.log(jobKey + ' = ' + cronSchedule)
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


                logging.log(jobKey + ' offset: ' + offset)
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

    logging.log('Scheduling Daily Job')

    dailyJob = schedule.scheduleJob('00 00 00 * * * ', function() {
        logging.log('** Daily Job **')
        scheduleJobs()
    })
}