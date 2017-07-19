// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var async = require('async')
const _ = require('lodash')

const rules = require('./homeautomation-js-lib/rules.js')
const logging = require('./homeautomation-js-lib/logging.js')

require('./homeautomation-js-lib/devices.js')
require('./homeautomation-js-lib/mqtt_helpers.js')
require('./homeautomation-js-lib/redis_helpers.js')

const utilities = require('./lib/utilities.js')
const schedule = require('./lib/scheduled-jobs.js')
const evaluation = require('./lib/evaluation.js')

const config_path = process.env.TRANSFORM_CONFIG_PATH

// Setup MQTT
global.client = mqtt.setupClient(function() {
    logging.info('MQTT Connected', {
        action: 'mqtt-connected'
    })
    global.client.subscribe('#')

}, function() {
    logging.error('Disconnected', {
        action: 'mqtt-disconnected'
    })
})

global.publishEvents = []

global.publish = function(rule_name, expression, valueOrExpression, topic, message) {
    global.client.publish(topic, message)
        // var event = {}

    // event.rule_name = rule_name
    // event.expression = expression
    // event.valueOrExpression = valueOrExpression
    // event.topic = topic
    // event.message = message
    // event.date = new Date()

    // global.publishEvents.push(event)
}

global.devices_to_monitor = []

var global_value_cache = {}

global.client.on('message', (topic, message) => {
    if (!global.devices_to_monitor.includes(topic))
        return

    message = utilities.convertToNumberIfNeeded(message)

    // //logging.info(' ' + topic + ':' + message)
    // var cachedValue = global_value_cache[topic]

    // if (!_.isNil(cachedValue)) {
    //     if (('' + message).localeCompare(cachedValue) === 0) {
    //         logging.info(' => value not updated', {
    //             action: 'skipped-processing',
    //             reason: 'value-not-updated',
    //             topic: topic,
    //             message: message
    //         })
    //         return
    //     }
    // }
    // global_value_cache[topic] = message

    const redisStartTime = new Date().getTime()
    logging.info(' redis query', {
        action: 'redis-query-start',
        start_time: redisStartTime
    })

    global.redis.mget(global.devices_to_monitor, function(err, values) {
        logging.info(' redis query done', {
            action: 'redis-query-done',
            query_time: ((new Date().getTime()) - redisStartTime)
        })
        var context = {}

        for (var index = 0; index < global.devices_to_monitor.length; index++) {
            const key = global.devices_to_monitor[index]
            const value = values[index]
            const newKey = utilities.update_topic_for_expression(key)
            if (key === topic)
                context[newKey] = utilities.convertToNumberIfNeeded(message)
            else
                context[newKey] = utilities.convertToNumberIfNeeded(value)
        }

        context[utilities.update_topic_for_expression(topic)] = message

        const ruleStartTime = new Date().getTime()
        logging.info(' rule processing start ', {
            action: 'rule-processing-start',
            start_time: ruleStartTime
        })


        var ruleProcessor = function(rule, rule_name, callback) {
            //logging.debug('rule processor for rule: ' + rule_name)
            const watch = rule.watch

            if (!_.isNil(watch) && !_.isNil(watch.devices)) {
                if (watch.devices.indexOf(topic) !== -1) {

                    logging.info('matched topic to rule', {
                        action: 'rule-match',
                        rule_name: rule_name,
                        topic: topic,
                        message: utilities.convertToNumberIfNeeded(message),
                        rule: rule,
                        context: context
                    })

                    evaluation.evalulateValue(topic, context, rule_name, rule)
                }
            }

            callback()
        }

        var configProcessor = function(config, callback) {
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

global.redis = Redis.setupClient(function() {
    logging.info('redis connected ', {
        action: 'redis-connected'
    })
    rules.load_path(config_path)
})

rules.on('rules-loaded', () => {
    global.devices_to_monitor = []

    rules.ruleIterator(function(rule_name, rule) {
        const watch = rule.watch
        if (!_.isNil(watch)) {
            const devices = watch.devices
            if (!_.isNil(devices)) {
                devices.forEach(function(device) {
                    global.devices_to_monitor.push(device)
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
                        global.devices_to_monitor.push(device)
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
                        global.devices_to_monitor.push(device)
                    }, this)
                }
            }, this)
        }

    })

    global.devices_to_monitor = utilities.unique(global.devices_to_monitor)

    logging.info('rules loaded ', {
        action: 'rules-loaded',
        devices_to_monitor: global.devices_to_monitor
    })

    global.redis.mget(global.devices_to_monitor, function(err, values) {
        logging.debug('devices :' + JSON.stringify(global.devices_to_monitor))
        logging.debug('values :' + JSON.stringify(values))
    })

    schedule.scheduleJobs()
})