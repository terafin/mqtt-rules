// Requirements
const mqtt = require('mqtt')
var jexl = require('jexl')
var Redis = require('redis')

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

client.on('message', (topic, message) => {
    logging.log(' ' + topic + ':' + message)

    redis.keys('*', function(err, result) {
        const keys = result.sort()
        redis.mget(keys, function(err, values) {
            var context = {}

            for (var index = 0; index < keys.length; index++) {
                var key = keys[index]
                var value = values[index]
                context[update_topic_for_expression(key)] = value
            }

            rules.ruleIterator(function(rule_name, rule) {
                logging.log('rule_name:' + rule_name)
                const watch = rule.watch
                const rules = rule.rules
                const actions = rule.actions

                const observedDevices = watch.devices
                logging.log('   watch: ' + JSON.stringify(watch))
                logging.log('   rules: ' + JSON.stringify(rules))
                logging.log(' actions: ' + JSON.stringify(actions))

                if (observedDevices.indexOf(topic) !== -1) {
                    logging.log('   *** hit')
                    var expression = update_topic_for_expression(rules.expression)
                    logging.log('          expression: ' + expression)

                    jexl.eval(expression, context, function(err, res) {
                        logging.log(res)
                        if (res === true) {
                            logging.log('go!')
                            Object.keys(actions).forEach(function(topic) {
                                client.publish(topic, actions[topic])
                            }, this)

                        }
                    })
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