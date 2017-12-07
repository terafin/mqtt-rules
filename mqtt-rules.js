// Requirements
const mqtt = require('mqtt')
var Redis = require('redis')
var async = require('async')
const _ = require('lodash')
var is_test_mode = process.env.TEST_MODE

if (is_test_mode == 'true') {
    is_test_mode = true
} else if (is_test_mode != true) {
    is_test_mode = false
}

const rules = require('homeautomation-js-lib/rules.js')
const logging = require('homeautomation-js-lib/logging.js')

require('homeautomation-js-lib/devices.js')
require('homeautomation-js-lib/mqtt_helpers.js')
require('homeautomation-js-lib/redis_helpers.js')

const api = require('./lib/api.js')
const utilities = require('./lib/utilities.js')
const schedule = require('./lib/scheduled-jobs.js')
const evaluation = require('./lib/evaluation.js')
const metrics = require('homeautomation-js-lib/stats.js')

const config_path = process.env.TRANSFORM_CONFIG_PATH

// Setup MQTT
if (is_test_mode === false) {
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
}
global.publishEvents = []

global.publish = function(rule_name, expression, valueOrExpression, topic, message, inOptions) {
    logging.info('=> rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(inOptions))
    var options = { retain: true }

    if (!_.isNil(inOptions)) {
        Object.keys(inOptions).forEach(function(key) {
            options[key] = inOptions[key]
        })
    }

    global.client.publish(topic, message, options)
}

global.devices_to_monitor = []

global.changeProcessor = function(rules, context, topic, message) {
    context[utilities.update_topic_for_expression(topic)] = message

    const ruleStartTime = new Date().getTime()
    logging.verbose(' rule processing start ', {
        action: 'rule-processing-start',
        start_time: ruleStartTime
    })

    var ruleProcessor = function(rule, rule_name, callback) {
        const disabled = rule.disabled

        if (disabled == true) return

        const watch = rule.watch

        if (!_.isNil(watch) && !_.isNil(watch.devices)) {
            if (watch.devices.indexOf(topic) !== -1) {

                logging.verbose('matched topic to rule', {
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

    async.each(rules, configProcessor)

    logging.verbose(' rule processing done ', {
        action: 'rule-processing-done',
        processing_time: ((new Date().getTime()) - ruleStartTime)
    })
}


if (is_test_mode === false) {
    global.client.on('message', (topic, message) => {
        if (is_test_mode == true)
            return

        if (!global.devices_to_monitor.includes(topic))
            return

        message = utilities.convertToNumberIfNeeded(message)
        const redisStartTime = new Date().getTime()
        logging.verbose(' redis query', {
            action: 'redis-query-start',
            start_time: redisStartTime
        })

        global.redis.mget(global.devices_to_monitor, function(err, values) {
            const redisQueryTime = ((new Date().getTime()) - redisStartTime)
            logging.verbose(' redis query done', {
                action: 'redis-query-done',
                query_time: redisQueryTime
            })

            metrics.submit('redis_query_time', redisQueryTime)

            var context = {}

            for (var index = 0; index < global.devices_to_monitor.length; index++) {
                const key = global.devices_to_monitor[index]
                    // bug here with index
                const value = values[index]
                const newKey = utilities.update_topic_for_expression(key)
                if (key === topic)
                    context[newKey] = utilities.convertToNumberIfNeeded(message)
                else
                    context[newKey] = utilities.convertToNumberIfNeeded(value)
            }

            try {
                var jsonFound = JSON.parse(message)
                if (!_.isNil(jsonFound)) {
                    Object.keys(jsonFound).forEach(function(key) {
                        context[key] = jsonFound[key]
                    })
                }
            } catch (err) {
                logging.debug('invalid json')
            }

            global.changeProcessor(rules.get_configs(), context, topic, message)
        })
    })
}
global.redis = Redis.setupClient(function() {
    logging.info('redis connected ', {
        action: 'redis-connected'
    })
    if (is_test_mode == false) {
        logging.info('loading rules')
        rules.load_path(config_path)
    } else {
        logging.info('not - loading rules')

    }
})

rules.on('rules-loaded', () => {
    if (is_test_mode == true) {
        logging.info('test mode, not loading rules')
        return
    }
    logging.info('Loading rules')

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
    api.updateRules(rules)
})

global.clearQueues = function() {
    evaluation.clearQueues()
}