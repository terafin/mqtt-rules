// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var Jexl = require('jexl')

const rules = require('./homeautomation-js-lib/rules.js')
const logging = require('./homeautomation-js-lib/logging.js')

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
    // logging.setRemoteHost(syslogHost, syslogPort)

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

function update_value(value) {
    return value
}

function evalulateValue(in_expression, in_context, in_name, in_topic, in_message, in_actions) {
    var jexl = new Jexl.Jexl()
    jexl.eval(in_expression, in_context, function(error, in_res) {
        if (in_res === true) {
            Object.keys(in_actions).forEach(function(resultTopic) {
                client.publish(resultTopic, in_actions[resultTopic])
            }, this)
        }
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
                    context[newKey] = update_value(message)
                else
                    context[newKey] = update_value(value)
            }

            rules.ruleIterator(function(rule_name, rule) {
                logging.log('rule_name:' + rule_name)
                const watch = rule.watch
                const rules = rule.rules
                const actions = rule.actions

                if (watch.devices.indexOf(topic) !== -1) {
                    evalulateValue(update_topic_for_expression(rules.expression),
                        context,
                        rule_name,
                        update_topic_for_expression(topic),
                        update_value(message),
                        actions)
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