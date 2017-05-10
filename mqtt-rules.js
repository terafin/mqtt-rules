// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var Jexl = require('jexl')
var async = require('async')
const _ = require('lodash')

const rules = require('./homeautomation-js-lib/rules.js')
const logging = require('./homeautomation-js-lib/logging.js')
const pushover = require('pushover-notifications')
const Queue = require('bull')
const schedule = require('node-schedule')
const SolarCalc = require('solar-calc')
const moment = require('moment')

require('./homeautomation-js-lib/devices.js')
require('./homeautomation-js-lib/mqtt_helpers.js')
require('./homeautomation-js-lib/redis_helpers.js')

const solarLat = process.env.LOCATION_LAT
const solarLong = process.env.LOCATION_LONG
const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT

const config_path = process.env.TRANSFORM_CONFIG_PATH

// Setup MQTT
var client = mqtt.setupClient(function() {
    logging.info('MQTT Connected', {
        action: 'mqtt-connected'
    })
    client.subscribe('#')

}, function() {
    logging.error('Disconnected', {
        action: 'mqtt-disconnected'
    })
})


function update_topic_for_expression(topic) {
    topic = topic.replace(/(\/)(?=\w+)/g, '_')
    topic = topic.replace(/[-,+]\w+/g, '_')

    return topic
}

function prepareExpression(expression, context) {
    if (_.isNil(context)) return expression

    const variables = Object.keys(context).sort(function(a, b) {
        // ASC  -> a.length - b.length
        // DESC -> b.length - a.length
        return b.length - a.length
    })
    var newExpression = expression

    variables.forEach(function(variable) {
        const value = context[variable]
        if (value.length == 1) return
        logging.debug('    variable: ' + variable + '   value: ' + value)

        newExpression = newExpression.replace(variable, value)
    }, this)

    return newExpression
}

function convertToNumberIfNeeded(value) {
    const numberValue = Number(value)
    if (!_.isNil(numberValue) && numberValue == value) {
        logging.debug('converting string: ' + value + ' to number: ' + numberValue)
        return numberValue
    }

    return value
}

function isValueAnExpression(value) {
    return (value.includes('/') || value.includes('?') || value.includes('+'))
}

var devices_to_monitor = []

var actionQueues = {}

var actionProcessor = function(context, rule_name, valueOrExpression, topic, callback) { // ISOLATED
    logging.debug('evaluating for publish: ' + topic + '  value: ' + valueOrExpression)

    if (isValueAnExpression(valueOrExpression)) {
        const publishExpression = prepareExpression(update_topic_for_expression(valueOrExpression), context)
        var jexl = new Jexl.Jexl()
        const startTime = new Date()
        logging.info('  start evaluating publish expression for =>(' + rule_name + ')', {
            action: 'publish-expression-evaluation-start',
            start_time: (startTime.getTime()),
            rule_name: rule_name,
            expression: publishExpression,
            topic: topic,
            value: valueOrExpression
        })
        jexl.eval(publishExpression, context,
            function(publishError, publishResult) {
                logging.info('  done evaluating publish expression for =>(' + rule_name + ')', {
                    action: 'publish-expression-evaluation-done',
                    evaluation_time: ((new Date().getTime()) - startTime.getTime()),
                    rule_name: rule_name,
                    expression: publishExpression,
                    context: context,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })

                client.publish(topic, '' + publishResult)
                logging.info(' published result', {
                    action: 'published-value',
                    rule_name: rule_name,
                    expression: publishExpression,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })

            })
    } else {
        logging.info(' published result', {
            action: 'published-value',
            rule_name: rule_name,
            topic: topic,
            value: valueOrExpression
        })
        client.publish(topic, '' + valueOrExpression)
    }


    callback()
}

function jobProcessor(job, doneAction) {
    const queueTime = job.data.queue_time
    const actions = job.data.actions
    const notify = job.data.notify
    const name = job.data.rule_name
    const context = job.data.context
        // const message = job.data.message
        // const topic = job.data.topic
        // const expression = job.data.expression
    const startTime = new Date().getTime()
    logging.debug('action queue: ' + name + '    begin')
    logging.info(' action queue: ' + name, {
        action: 'job-process-start',
        rule_name: name,
        actions: actions,
        queue_time: (startTime - queueTime)
    })

    if (!_.isNil(actions)) // name, context
        async.eachOf(actions, actionProcessor.bind(undefined, context, name))

    if (!_.isNil(notify)) {
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
            if (!_.isNil(err)) {
                json.error = err
                logging.info(' failed notification', json)
            } else {
                logging.info(' successfully notified', json)
            }
        })
    }
    logging.debug('action queue: ' + name + '    end')

    if (!_.isNil(doneAction))
        doneAction()

    logging.info(' processing done: ' + name, {
        action: 'job-process-done',
        rule_name: name,
        processing_time: ((new Date().getTime()) - startTime)
    })
}

var evalQueues = {}

function evaluateProcessor(job, doneEvaluate) {
    const queue_time = job.data.queue_time
    const name = job.data.name
    const context = job.data.context_value
    const rule = job.data.rule
    const allowed_times = rule.allowed_times
    const startTime = new Date().getTime()

    var logResult = {
        action: 'rule-time-evaluation',
        rule_name: name,
        rule: rule,
        allowed_times: allowed_times,
        context: context
    }
    var isOKTime = true

    logging.info(' evaluation queue: ' + name, {
        action: 'evaluate-process-start',
        rule_name: name,
        queue_time: (startTime - queue_time)
    })

    logging.debug('eval queue: ' + name + '    begin')

    if (!_.isNil(allowed_times)) {
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
        logging.info(' evaluation queue: ' + name, {
            action: 'evaluate-process-done',
            rule_name: name,
            queue_time: ((new Date().getTime()) - startTime)
        })

        if (!_.isNil(doneEvaluate))
            doneEvaluate()


        return
    }

    const performAction = function(eval_result, context, name, rule) {
        if (eval_result === true) {
            const actions = rule.actions
            const notify = rule.notify
            var perform_after = rule.perform_after
            if (_.isNil(perform_after)) {
                perform_after = 0
            }
            const queueName = name + '_action'
            var actionQueue = actionQueues[queueName]
            if (!_.isNil(actionQueue)) {

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

            const data = {
                rule_name: name,
                notify: notify,
                actions: actions,
                queue_time: (new Date().getTime()),
                context: context
            }
            if (perform_after === 0) {
                job = {}
                job.data = data
                jobProcessor(job, null)
            } else {
                actionQueue.add(data, {
                    removeOnComplete: true,
                    removeOnFail: true,
                    delay: (perform_after * 1000), // milliseconds
                })
            }
        }
    }

    if (!_.isNil(rule.rules) && !_.isNil(rule.rules.expression)) {
        const expression = prepareExpression(update_topic_for_expression(rule.rules.expression), context)
        var jexl = new Jexl.Jexl()
        const beginTime = new Date()
        jexl.eval(expression, context, function(error, result) {
            logging.info('  =>(' + name + ') evaluated expression', Object.assign(logResult, {
                action: 'evaluated-expression',
                result: result,
                evaluation_time: ((new Date().getTime()) - beginTime.getTime()),
                error: error
            }))
            performAction(result, context, name, rule)
            logging.debug('eval queue: ' + name + '    end expression')
        })
    } else {
        logging.info('  =>(' + name + ') skipped evaluated expression', Object.assign(logResult, {
            action: 'no-expression-to-evaluate'
        }))
        performAction(true, context, name, rule)
        logging.debug('eval queue: ' + name + '    end expression - no expression')
    }

    logging.info(' evaluation queue: ' + name, {
        action: 'evaluate-process-done',
        rule_name: name,
        queue_time: ((new Date().getTime()) - startTime)
    })
    if (!_.isNil(doneEvaluate))
        doneEvaluate()
}

function evalulateValue(in_context, name, rule) {

    const queueName = name + '_eval'
    var evalQueue = evalQueues[queueName]

    if (!_.isNil(evalQueue)) {
        evalQueue.empty()
    }

    const actionQueueName = name + '_action'
    var actionQueue = actionQueues[actionQueueName]
    if (!_.isNil(actionQueue)) {
        actionQueue.empty()
    }

    var evaluateAfter = rule.evaluate_after
    if (_.isNil(evaluateAfter)) {
        evaluateAfter = 0
    }

    evalQueue = Queue(queueName, redisPort, redisHost)
    evalQueues[queueName] = evalQueue

    evalQueue.process(evaluateProcessor)

    var job = {
        rule: rule,
        name: '' + name,
        queue_time: (new Date().getTime()),
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

    if (evaluateAfter === 0) {
        job.data = job
        evaluateProcessor(job, null)
    } else {
        evalQueue.add(job, {
            removeOnComplete: true,
            removeOnFail: true,
            delay: (evaluateAfter * 1000), // milliseconds
        })
    }
}

var global_value_cache = {}

client.on('message', (topic, message) => {
    if (!devices_to_monitor.includes(topic))
        return

    message = convertToNumberIfNeeded(message)

    //logging.info(' ' + topic + ':' + message)
    var cachedValue = global_value_cache[topic]

    if (!_.isNil(cachedValue)) {
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

    const redisStartTime = new Date().getTime()
    logging.info(' redis query', {
        action: 'redis-query-start',
        start_time: redisStartTime
    })

    redis.mget(devices_to_monitor, function(err, values) {
        logging.info(' redis query done', {
            action: 'redis-query-done',
            query_time: ((new Date().getTime()) - redisStartTime)
        })
        var context = {}

        for (var index = 0; index < devices_to_monitor.length; index++) {
            const key = devices_to_monitor[index]
            const value = values[index]
            const newKey = update_topic_for_expression(key)
            if (key === topic)
                context[newKey] = convertToNumberIfNeeded(message)
            else
                context[newKey] = convertToNumberIfNeeded(value)
        }

        context[update_topic_for_expression(topic)] = message

        const ruleStartTime = new Date().getTime()
        logging.info(' rule processing start ', {
            action: 'rule-processing-start',
            start_time: ruleStartTime
        })


        var ruleProcessor = function(rule, rule_name, callback) {
            logging.debug('rule processor for rule: ' + rule_name)
            const watch = rule.watch

            if (!_.isNil(watch) && !_.isNil(watch.devices)) {
                if (watch.devices.indexOf(topic) !== -1) {
                    logging.info('matched topic to rule', {
                        action: 'rule-match',
                        rule_name: rule_name,
                        topic: topic,
                        message: convertToNumberIfNeeded(message),
                        rule: rule,
                        context: context
                    })

                    evalulateValue(context, rule_name, rule)
                }
            }

            callback()
        }

        var configProcessor = function(config, callback) {
            logging.debug('rule processor for config: ' + config)
            async.eachOf(config, ruleProcessor)
            callback()
        }

        async.each(rules.get_configs(), configProcessor)

        logging.info(' rule processing done ', {
            action: 'rule-processing-done',
            processing_time: ((new Date().getTime()) - ruleStartTime)
        })
    })
})

const redis = Redis.setupClient(function() {
    logging.info('redis connected ', {
        action: 'redis-connected'
    })
    rules.load_path(config_path)
})

function unique(list) {
    var result = []
    list.forEach(function(e) {
        if (!result.includes(e))
            result.push(e)
    })
    return result
}

rules.on('rules-loaded', () => {
    devices_to_monitor = []

    rules.ruleIterator(function(rule_name, rule) {
        const watch = rule.watch
        if (!_.isNil(watch)) {
            const devices = watch.devices
            if (!_.isNil(devices)) {
                devices.forEach(function(device) {
                    devices_to_monitor.push(device)
                }, this)
            }
        }

        const rules = rule.rules
        if (!_.isNil(rules)) {
            const expression = rules.expression
            logging.debug('expression :' + expression)
            if (!_.isNil(expression)) {

                var foundDevices = expression.match(/\/([a-z,0-9,\-,_,/])*/g)

                if (!_.isNil(foundDevices)) {
                    foundDevices.forEach(function(device) {
                        devices_to_monitor.push(device)
                    }, this)
                }
            }
        }

        const actions = rule.actions
        if (!_.isNil(actions)) {
            Object.keys(actions).forEach(function(action) {
                const action_value = actions[action]

                var foundDevices = action_value.match(/\/([a-z,0-9,\-,_,/])*/g)

                if (!_.isNil(foundDevices)) {
                    foundDevices.forEach(function(device) {
                        devices_to_monitor.push(device)
                    }, this)
                }
            }, this)
        }

    })

    devices_to_monitor = unique(devices_to_monitor)

    logging.info('rules loaded ', {
        action: 'rules-loaded',
        devices_to_monitor: devices_to_monitor
    })

    redis.mget(devices_to_monitor, function(err, values) {
        logging.debug('devices :' + JSON.stringify(devices_to_monitor))
        logging.debug('values :' + JSON.stringify(values))
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

        redis.mget(devices_to_monitor, function(err, values) {
            var context = {}

            for (var index = 0; index < devices_to_monitor.length; index++) {
                const key = devices_to_monitor[index]
                const value = values[index]
                const newKey = update_topic_for_expression(key)
                context[newKey] = convertToNumberIfNeeded(value)
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
    }.bind(null, rule))

    if (!_.isNil(newJob)) {
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

        if (!_.isNil(schedule)) {
            Object.keys(schedule).forEach(function(schedule_key) {
                var jobKey = rule_name + '.schedule.' + schedule_key
                const cronSchedule = schedule[schedule_key]
                logging.debug(jobKey + ' = ' + cronSchedule)

                doSchedule(rule_name, jobKey, cronSchedule, rule)
            }, this)
        }

        if (!_.isNil(daily)) {

            Object.keys(daily).forEach(function(daily_key) {
                var solar = new SolarCalc(new Date(), Number(solarLat), Number(solarLong))
                var jobKey = rule_name + '.daily.' + daily_key
                const dailyValue = daily[daily_key]
                var offset = 0
                if (!_.isNil(dailyValue)) {
                    if (_.isNil(dailyValue.offset))
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
                if (!_.isNil(date)) {
                    var newDate = moment(date).add(offset, 'minutes')
                    doSchedule(rule_name, jobKey, newDate.toDate(), rule)
                }

            }, this)
        }
    })
}

var dailyJob = null

function scheduleDailyJobs() {
    if (!_.isNil(dailyJob))
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