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
    const message = job.data.message
    const topic = job.data.topic
    const expression = job.data.expression

    logging.log('action queue: ' + name + '    begin')
    Object.keys(actions).forEach(function(resultTopic) {
        logging.log('publishing: ' + resultTopic + '  value: ' + actions[resultTopic])
        client.publish(resultTopic, actions[resultTopic])
    }, this)

    if (notify !== null && notify !== undefined) {
        const baseAppToken = process.env.PUSHOVER_APP_TOKEN
        const baseUserToken = process.env.PUSHOVER_USER_TOKEN

        logging.log('****** notify: ' + JSON.stringify(notify))
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
            logging.log('notify error: ' + err)
            logging.log('notify result: ' + result)
        })

        logging.log('action queue: ' + name + '    end')
        doneAction()
    }
}

var evalQueues = {}

function evaluateProcessor(job, doneEvaluate) {
    const name = job.data.name
    const value = job.data.value
    const context = job.data.context
    const topic = job.data.topic
    const rule = job.data.rule

    logging.log('eval queue: ' + name + '    begin' + '    value: ' + JSON.stringify(value))
    logging.log('rule: ' + JSON.stringify(rule))
    const expression = update_topic_for_expression(rule.rules.expression)
    var jexl = new Jexl.Jexl()

    jexl.eval(expression, context, function(error, result) {
        logging.log('(' + name + ') evaluated expression: ' + expression + '   result: ' + result + '   error: ' + error)
        if (result === true) {
            const actions = rule.actions
            const notify = rule.notify
            var perform_after = rule.perform_after
            if (perform_after === undefined || perform_after === null) {
                perform_after = 0.001
            }
            const queueName = name + '_action'
            var actionQueue = actionQueues[queueName]
            if (actionQueue !== null && actionQueue !== undefined) {
                logging.log('removed existing action queue: ' + queueName)
                actionQueue.empty()
            }

            actionQueue = Queue(queueName, redisPort, redisHost)
            actionQueues[queueName] = actionQueue
            logging.log('created queue: ' + queueName + '   queue: ' + actionQueue)
            logging.log('perform_after: ' + perform_after)

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

function evalulateValue(context, name, topic, value, rule) {
    if (true) {
        var data = {
            rule: rule,
            name: name,
            value: '' + value,
            context: context,
            topic: topic,
        }
        var job = {
            data: data
        }
        evaluateProcessor(job, function() {

        })
        return
    }

    const queueName = name + '_eval'
    var evalQueue = evalQueues[queueName]
    if (evalQueue !== null && evalQueue !== undefined) {
        logging.log('removed existing evaluate queue: ' + queueName)
        evalQueue.empty()
    }

    const actionQueueName = name + '_action'
    var actionQueue = actionQueues[actionQueueName]
    if (actionQueue !== null && actionQueue !== undefined) {
        logging.log('removed existing action queue: ' + actionQueueName)
        actionQueue.empty()
    }

    var evaluateAfter = rule.evaluate_after

    logging.log('evaluateAfter: ' + evaluateAfter)
    evalQueue = Queue(queueName, redisPort, redisHost)
    evalQueues[queueName] = evalQueue

    evalQueue.process(evaluateProcessor)

    evalQueue.add({
        rule: rule,
        name: name,
        value: '' + value,
        context: context,
        topic: topic,
    }, {
        removeOnComplete: true,
        removeOnFail: true,
        delay: (evaluateAfter * 1000), // milliseconds
    })
}

client.on('message', (topic, message) => {
    logging.log(' ' + topic + ':' + message)

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
                    logging.log('checking hit: ' + rule_name)

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