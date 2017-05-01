// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var Jexl = require('jexl')

const rules = require('./homeautomation-js-lib/rules.js')
const logging = require('./homeautomation-js-lib/logging.js')
const pushover = require('pushover-notifications')
const Queue = require('bull')

require('./homeautomation-js-lib/devices.js')
require('./homeautomation-js-lib/mqtt_helpers.js')

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
    return topic
}

var actionQueues = {}

function jobProcessor(job, doneAction) {
    const actions = job.data.actions
    const notify = job.data.notify
    const name = job.data.name
        // const message = job.data.message
        // const topic = job.data.topic
        // const expression = job.data.expression

    logging.log('action queue: ' + name + '    begin')
    if (actions !== null && actions !== undefined) {
        Object.keys(actions).forEach(function(resultTopic) {
            logging.log('publishing: ' + resultTopic + '  value: ' + actions[resultTopic])
            client.publish(resultTopic, actions[resultTopic])
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
    const value = job.data.value
    const context = job.data.context_value
    const topic = job.data.topic
    const rule = job.data.rule

    logging.log('eval queue: ' + name + '    begin' + '    value: ' + JSON.stringify(value))

    const expression = update_topic_for_expression(rule.rules.expression)
    var jexl = new Jexl.Jexl()

    jexl.eval(expression, context, function(error, result) {
        logging.log('  =>(' + name + ') evaluated expression: ' + expression + '   result: ' + result + '   error: ' + error)
        if (result === true) {
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
                value: value,
                topic: topic,
                expression: expression
            }, {
                removeOnComplete: true,
                removeOnFail: true,
                delay: (perform_after * 1000), // milliseconds
            })
        }
        logging.log('eval queue: ' + name + '    end')

        doneEvaluate()
    })

}

function evalulateValue(in_context, name, topic, value, rule) {

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
        value: '' + value,
        context_value: {},
        topic: '' + topic,
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

                if (watch.devices.indexOf(topic) !== -1) {
                    logging.log('found watch: ' + rule_name)
                    var cachedValues = global_value_cache[rule_name]
                    if (cachedValues === null || cachedValues === undefined) {
                        cachedValues = {}
                    }
                    var cachedValue = cachedValues[topic]

                    if (cachedValue !== null && cachedValue !== undefined) {
                        if (('' + message).localeCompare(cachedValue) === 0) {
                            logging.log(' => value not updated')
                            return
                        }
                    }
                    cachedValues[topic] = message
                    global_value_cache[rule_name] = cachedValues

                    evalulateValue(
                        context,
                        rule_name,
                        update_topic_for_expression(topic),
                        message,
                        rule)

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
})