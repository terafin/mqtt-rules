// Requirements
// eslint-disable-next-line no-unused-vars
const mqtt = require('mqtt')
const async = require('async')
const _ = require('lodash')
const mqtt_wildcard = require('mqtt-wildcard')
const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')

const logging = require('homeautomation-js-lib/logging.js')
const health = require('homeautomation-js-lib/health.js')

require('homeautomation-js-lib/devices.js')
require('homeautomation-js-lib/redis_helpers.js')

var collectedMQTTTChanges = null

const rule_loader = require('./lib/loading.js')
const api = require('./lib/api.js')
const queue = require('./lib/queue.js')
const variables = require('./lib/variables.js')
const utilities = require('./lib/utilities.js')
const schedule = require('./lib/scheduled-jobs.js')
const evaluation = require('./lib/evaluation.js')
const TIMEZONE = utilities.getCurrentTimeZone()
const moment = require('moment-timezone')

const config_path = process.env.RULE_PATH
const connectionProcessorDelay = 10

const startCollectingMQTTChanges = function() {
    if (_.isNil(collectedMQTTTChanges)) {
        collectedMQTTTChanges = {}
    }
}

const isCollectingMQTTChanges = function() {
    return !_.isNil(collectedMQTTTChanges)
}

const collectChange = function(topic, message) {
    collectedMQTTTChanges[topic] = message
}

const stopCollectingMQTTChanges = function() {
    collectedMQTTTChanges = null
}

const handleMQTTConnection = function() {
    if (utilities.testMode() === false) {
        global.client.on('message', (topic, message) => {
            if (isCollectingMQTTChanges()) {
                logging.debug(' * pending processing update for: ' + topic + '  => (handling in bulk)')
                collectChange(topic, message)
                return
            }

            var foundMatch = global.devices_to_monitor.includes(topic)

            if (_.isNil(foundMatch)) {
                global.devices_to_monitor.forEach(deviceToMontor => {
                    if (!_.isNil(foundMatch)) {
                        return
                    }

                    const match = mqtt_wildcard(topic, deviceToMontor)
                    if (!_.isNil(match)) {
                        foundMatch = match
                    }
                })
            }

            if (_.isNil(foundMatch)) {
                return
            }

            logging.debug('incoming topic message: ' + topic + '  message: ' + message)

            const data = {
                incoming_topic: topic,
                incoming_message: message
            }
            queue.enqueue('mqtt-incoming', topic, function(job, doneEvaluate) {
                const queued_topic = job.data.incoming_topic
                const queued_message = job.data.incoming_message
                logging.debug('handling queued incoming topic message: ' + queued_topic + ' message: ' + queued_message)

                global.generateContext(queued_topic, queued_message, function(outTopic, outMessage, context) {
                    global.changeProcessor(null, context, queued_topic, queued_message)
                })

                if (!_.isNil(doneEvaluate)) {
                    doneEvaluate()
                }

            }, data, 50, true, null)

        })
    }

    startCollectingMQTTChanges()

    handleSubscriptions()

    logging.info(' MQTT Connected')
    handleConnectionEvent()
}

const disconnectionEvent = function() {
    if (!_.isNil(global.client) && global.client.connected) {
        return
    }

    health.unhealthyEvent()
    logging.error(' Disconnected from redis or MQTT')
    startCollectingMQTTChanges()
}

const connectionProcessor = function() {
    logging.info(' * Processing bulk connection setup start')

    // need to capture everything that comes in, and process it as such
    const changedTopics = Object.keys(collectedMQTTTChanges)

    changedTopics.forEach(topic => {
        const message = collectedMQTTTChanges[topic]

        global.generateContext(topic, message, function(outTopic, outMessage, context) {
            if (_.isNil(outTopic) || _.isNil(outMessage)) {
                logging.error(' *** NOT Processing rules for: ' + topic)
                logging.error('                     outTopic: ' + outTopic)
                logging.error('                   outMessage: ' + outMessage)
            } else {
                context['firstRun'] = true
                global.changeProcessor(null, context, outTopic, outMessage)
            }
        })
    })

    stopCollectingMQTTChanges()
    logging.info(' => Done!')
}

const handleConnectionEvent = function() {
    if (_.isNil(global.client) || !global.client.connected) {
        return
    }
    if (!variables.isInitialStateLoaded()) {
        return
    }

    logging.info(' Both are good to go - kicking connection processing in ' + connectionProcessorDelay)
    health.healthyEvent()

    setTimeout(connectionProcessor, (connectionProcessorDelay * 1000))
}

const handleSubscriptions = function() {
    if (utilities.testMode() === false) {
        if (_.isNil(global.client) || !global.client.connected) {
            return
        }

        global.client.unsubscribe('#')

        global.devices_to_monitor.forEach(topic => {
            logging.debug(' => subscribing to: ' + topic)
            global.client.subscribe(topic, { qos: 1 })
        })
    }
}

const setupMQTT = function() {
    if (!_.isNil(global.client)) {
        return
    }

    if (utilities.testMode() === false) {
        global.client = mqtt_helpers.setupClient(function() {
            handleMQTTConnection()
        }, function() {
            disconnectionEvent()
        })
    }
}

var timeLastRun = {}
var ruleHistory = []
var quietRuleHistory = []

const RULES_TO_REMEMBER = 2000
const QUIET_RULES_TO_REMEMBER = 4000

const resetRuleHistory = function() {
    timeLastRun = {}
}

global.addRuleToHistory = function(rule_name, expression, valueOrExpression, topic, message, inOptions, evaluate_job_data, result) {
    if (_.isNil(rule_name)) {
        return
    }

    var quiet = false

    if (!_.isNil(inOptions)) {
        if (!_.isNil(inOptions.quiet)) {
            quiet = inOptions.quiet
        }
    }


    const data = {
        date: moment(new Date()).tz(TIMEZONE).unix(),
        rule_name: rule_name,
        evaluate_job_data: evaluate_job_data,
        expression: expression,
        valueOrExpression: valueOrExpression,
        result: result,
        topic: topic,
        message: message,
        options: inOptions
    }

    if (quiet) {
        quietRuleHistory.unshift(data)
        quietRuleHistory = quietRuleHistory.slice(0, QUIET_RULES_TO_REMEMBER)
    } else {
        ruleHistory.unshift(data)
        ruleHistory = ruleHistory.slice(0, RULES_TO_REMEMBER)
    }

    timeLastRun[rule_name] = data.date
}

const timeLastRuleRun = function(rule_name) {
    const result = timeLastRun[rule_name]

    if (_.isNil(result)) {
        return 0
    }

    return result
}

const printRuleHistory = function() {
    logging.info('=== Rules Log ===')
    logging.info('')

    const printRule = function(data) {
        const rule_name = data.rule_name
        const date = data.date
        const topic = data.topic
        const message = data.message
        const expression = data.when ? data.when : 'simple'
        const valueOrExpression = data.valueOrExpression
        const result = data.result
        logging.info(' [' + moment.unix(date).format('DD.MM.YY - HH:mm:ss') + '] ' + rule_name + ' (' + result + '): ' + expression + ' | ' + valueOrExpression + ' | ' + topic + ':' + message)

    }
    ruleHistory.forEach(data => {
        printRule(data)
    })

    logging.info('=== Quiet     ===')
    logging.info('')
    quietRuleHistory.forEach(data => {
        printRule(data)
    })


    logging.info('=================')
}

global.getRuleHistory = function() {
    return ruleHistory
}

global.timeLastRuleRun = timeLastRuleRun
global.printRuleHistory = printRuleHistory

global.publishEvents = []

global.publish = function(rule_name, expression, valueOrExpression, topic, message, inOptions, evaluate_job_data) {
    var options = {
        retain: false,
        qos: 1
    }
    var quiet = false

    if (!_.isNil(inOptions)) {
        if (!_.isNil(inOptions.quiet)) {
            quiet = inOptions.quiet
        }

        Object.keys(inOptions).forEach(function(key) {
            options[key] = inOptions[key]
        })
    }

    if (!quiet && !utilities.testMode()) {
        logging.info('=> rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(options))
    }

    if (_.isNil(global.client)) {
        logging.error('=> (client not initialized, not publishing) rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(options))
    } else {
        const data = {
            outgoing_topic: topic,
            outgoing_message: message,
            outgoing_options: options
        }
        logging.debug(' queue publish : ' + topic + '  message: ' + message + '  data: ' + JSON.stringify(data))

        queue.enqueue('mqtt-publish', topic, function(job, doneEvaluate) {
            const queued_topic = job.data.outgoing_topic
            const queued_message = job.data.outgoing_message
            const queued_options = job.data.outgoing_options
            logging.debug(' queued FIRE publish : ' + queued_topic + '  message: ' + queued_message + '   job: ' + JSON.stringify(job) + '   options: ' + JSON.stringify(queued_options))

            if (!quiet) {
                logging.info(' => MQTT publish: ' + queued_topic + '  message: ' + queued_message)
            }

            if (!utilities.dontPublish()) {
                global.client.publish(queued_topic, queued_message, queued_options)
            }

            global.addRuleToHistory(rule_name, expression, valueOrExpression, queued_topic, queued_message, queued_options, evaluate_job_data, true)

            if (!_.isNil(doneEvaluate)) {
                doneEvaluate()
            }
        }, data, 50, true, null)
    }
}

global.devices_to_monitor = []

global.clearRuleMapCache = function() {
    clearRuleMapCache()
}

var ruleMapCache = {}

const clearRuleMapCache = function() {
    ruleMapCache = {}
}

const cachedRulesForTopic = function(topic) {
    if (_.isNil(topic)) {
        return null
    }

    const simpleResult = ruleMapCache[topic]
    if (!_.isNil(simpleResult)) {
        logging.debug('returning simple match for: ' + topic)
        return simpleResult
    }

    var foundMatch = null
    Object.keys(ruleMapCache).forEach(key => {
        if (!_.isNil(foundMatch)) {
            return
        }

        if (key.includes('+')) {
            const match = mqtt_wildcard(topic, key)
            if (!_.isNil(match)) {
                logging.debug('found wildcard match for: ' + topic + ' + wildcard: ' + key)
                cacheRulesForTopic(topic, cachedRulesForTopic[key])
                foundMatch = key
            }
        }
    })

    return cachedRulesForTopic(foundMatch)
}

const isRuleQuiet = function(rule) {
    var quiet = false

    if (!_.isNil(rule) && !_.isNil(rule.options)) {
        quiet = rule.options.quiet
    }

    return quiet
}

const isAnyRuleQuiet = function(rules) {
    var quiet = false

    rules.forEach(rule => {
        quiet |= isRuleQuiet(rule)
    })

    return quiet
}

const cacheRulesForTopic = function(topic, rules) {
    if (_.isNil(topic)) {
        return null
    }

    ruleMapCache[topic] = rules
}

const getRulesArray = function(allRuleSets) {
    if (_.isNil(allRuleSets)) {
        logging.error('empty rules')
        return null
    }

    var foundRules = []
    allRuleSets.forEach(ruleSet => {
        if (_.isNil(ruleSet)) {
            logging.error('null rule set?')
            return
        }

        const configKeys = Object.keys(ruleSet)

        if (_.isNil(configKeys)) {
            return
        }

        configKeys.forEach(rule_name => {
            const rule = ruleSet[rule_name]
            if (_.isNil(rule)) {
                logging.error('empty rule for rule_name: ' + rule_name)
                return
            }

            foundRules.push(rule)
        })
    })

    return foundRules
}

const getRulesTriggeredBy = function(allRuleSets, topic) {

    if (_.isNil(allRuleSets)) {
        logging.error('empty rules')
        return null
    }

    const existingRecord = cachedRulesForTopic(topic)

    if (!_.isNil(existingRecord)) {
        return existingRecord
    }

    var foundRules = {}
    allRuleSets.forEach(ruleSet => {
        if (_.isNil(ruleSet)) {
            logging.error('null rule set?')
            return
        }

        const configKeys = Object.keys(ruleSet)

        logging.debug('rule set: ' + configKeys)

        if (_.isNil(configKeys)) {
            return
        }

        configKeys.forEach(rule_name => {
            const rule = ruleSet[rule_name]
            if (_.isNil(rule)) {
                logging.error('empty rule for rule_name: ' + rule_name)
                return
            }

            const devicesToWatch = getDevicesToWatchForRule(rule)
            logging.debug('rule: ' + rule_name + '   to watch: ' + devicesToWatch)

            if (!_.isNil(devicesToWatch)) {
                var foundMatch = null

                devicesToWatch.forEach(deviceToWatch => {
                    if (!_.isNil(foundMatch)) {
                        return
                    }

                    const match = mqtt_wildcard(topic, deviceToWatch)
                    if (!_.isNil(match)) {
                        foundRules[rule_name] = rule
                    }
                })
            }
        })
    })

    logging.debug('rules for: ' + topic + '   found: ' + foundRules)

    cacheRulesForTopic(topic, foundRules)

    return foundRules
}

global.changeProcessor = function(overrideRules, context, topic, message) {
    const ruleStartTime = new Date().getTime()
    var allRuleSets = overrideRules

    if (_.isNil(allRuleSets)) {
        allRuleSets = rule_loader.get_configs()
    }


    const quiet = isAnyRuleQuiet(getRulesArray(allRuleSets))

    if (!quiet) {
        logging.debug(' rule processing start ', {
            action: 'rule-processing-start',
            start_time: ruleStartTime
        })
    }
    if (_.isNil(context)) {
        context = {}
    }

    const foundRules = getRulesTriggeredBy(allRuleSets, topic)

    if (!quiet) {
        logging.debug('Begin Change Processor')
        logging.debug('      topic: ' + topic)
        logging.debug('    message: ' + message)
        logging.debug('      rules: ' + Object.keys(foundRules))
        logging.debug('    context: ' + JSON.stringify(context))
    }

    variables.update(topic, message)

    context[utilities.update_topic_for_expression(topic)] = message

    const firstRun = context['firstRun']
    var ruleProcessor = function(rule, rule_name, callback) {
        if (!quiet) {
            logging.debug('processing rule: ' + rule_name)
            logging.debug('    rule config: ' + JSON.stringify(rule))
        }

        if (_.isNil(rule)) {
            logging.error(' * empty rule passed, with name: ' + rule_name)
            callback()
            return
        }

        const skip_startup = _.isNil(rule.skip_startup) ? false : rule.skip_startup

        if (skip_startup && utilities.hasRecentlyStarted()) {
            logging.debug(' * skipping rule, due to startup skip: ' + rule_name)
            callback()
            return
        }

        if (firstRun) {
            const skipFirstRun = _.isNil(rule.skip_first_run) ? false : rule.skip_first_run

            if (skipFirstRun) {
                logging.debug(' * skipping rule, due to first run skip: ' + rule_name)
                callback()
                return
            }
        }

        const disabled = rule.disabled

        if (disabled == true) {
            logging.info(' * skipping rule, rule disabled: ' + rule_name)
            callback()
            return
        }

        if (!quiet) {
            logging.debug('matched topic to rule', {
                action: 'rule-match',
                rule_name: rule_name,
                topic: topic,
                message: utilities.convertToNumberIfNeeded(message),
                rule: rule
            })
        }

        evaluation.evalulateValue(topic, context, rule_name, rule, false, false, 'topic: ' + topic)

        if (!quiet) {
            logging.debug(' * done, dispatched rule: ' + rule_name)
        }

        callback()
    }

    async.eachOf(foundRules, ruleProcessor)

    if (!quiet) {
        logging.debug(' rule processing done ', {
            action: 'rule-processing-done',
            processing_time: ((new Date().getTime()) - ruleStartTime)
        })

        logging.debug(' => End Change Processor')
    }
}


global.generateContext = function(topic, inMessage, callback) {
    if (_.isNil(callback)) {
        return
    }

    var message = utilities.convertToNumberIfNeeded(inMessage)
    var devices_to_monitor = global.devices_to_monitor

    if (!_.isNil(topic) && !devices_to_monitor.includes(topic)) {
        logging.debug('devices_to_monitor query missing: ' + topic)
        devices_to_monitor.push(topic)
    }

    const valueMap = variables.valuesForTopics(devices_to_monitor)

    if (!_.isNil(valueMap)) {
        var context = {}

        Object.keys(valueMap).forEach(resultTopic => {
            const key = resultTopic
            const value = valueMap[resultTopic]
            const newKey = utilities.update_topic_for_expression(resultTopic)

            // If for some reason we passed in a null message, let's see waht redis has to say here
            if (key === topic && _.isNil(message)) {
                message = utilities.convertToNumberIfNeeded(value)
            }

            if (key === topic) {
                context[newKey] = utilities.convertToNumberIfNeeded(message)
            } else {
                context[newKey] = utilities.convertToNumberIfNeeded(value)
            }
        })

        try {
            var jsonFound = JSON.parse(message)
            if (!_.isNil(jsonFound)) {
                Object.keys(jsonFound).forEach(function(key) {
                    context[key] = jsonFound[key]
                })
            }
        } catch (err) {
            // eslint-disable-next-line
        }
    }

    if (!_.isNil(callback)) {
        return callback(topic, message, context)
    }
}

const getDevicesToWatchForRule = function(rule) {
    if (_.isNil(rule)) {
        return
    }


    const watch = rule.watch
    if (!_.isNil(watch)) {
        var associatedDevices = []

        watch.forEach(function(device) {
            associatedDevices.push(device)
        })

        return associatedDevices
    }

    return getAssociatedDevicesFromRule(rule)
}

global.getAssociatedDevicesFromRule = function(rule) {
    return getAssociatedDevicesFromRule(rule)
}

Array.prototype.unique = function() {
    return this.filter(function(value, index, self) {
        return self.indexOf(value) === index
    })
}


const getDevicesFromString = function(string) {
    if (_.isNil(string)) {
        return null
    }

    return string.match(/\/([a-z,0-9,\-,_,/])*/g)
}
const getAssociatedDevicesFromRule = function(rule) {
    if (_.isNil(rule)) {
        return []
    }

    var associatedDevices = []

    if (utilities.testMode() == false) {
        const testRuleOnly = rule.test_only

        if (!_.isNil(testRuleOnly) && testRuleOnly == true) {
            return []
        }
    }

    const watch = rule.watch

    if (!_.isNil(watch)) {
        watch.forEach(function(device) {
            associatedDevices.push(device)
        })
    }

    const expression = rule.when

    if (!_.isNil(expression)) {
        logging.debug('expression :' + expression)
        if (!_.isNil(expression)) {

            var foundDevices = getDevicesFromString(expression)

            if (!_.isNil(foundDevices)) {
                foundDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }
        }
    }

    const actions = rule.actions
    if (!_.isNil(actions)) {
        Object.keys(actions).forEach(function(action) {
            if (action == 'if') {
                const subExpressions = actions.if
                const subExpressionKeys = Object.keys(subExpressions)

                subExpressionKeys.forEach(key => {
                    const subExpression = subExpressions[key]
                    const subExpressionDevices = getAssociatedDevicesFromRule(subExpression)
                    subExpressionDevices.forEach(function(device) {
                        associatedDevices.push(device)
                    })

                })
                return
            }
            const action_value = actions[action]

            var foundDevices = getDevicesFromString(action_value)

            if (!_.isNil(foundDevices)) {
                foundDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }
        })
    }

    // Need to handle action key here....
    const otherwise = rule.otherwise
    if (!_.isNil(otherwise)) {
        Object.keys(otherwise).forEach(function(action) {
            if (action == 'if') {
                const subExpressions = otherwise.if
                const subExpressionKeys = Object.keys(subExpressions)

                subExpressionKeys.forEach(key => {
                    const subExpression = subExpressions[key]
                    const subExpressionDevices = getAssociatedDevicesFromRule(subExpression)
                    subExpressionDevices.forEach(function(device) {
                        associatedDevices.push(device)
                    })

                })
                return
            }
            const action_value = otherwise[action]

            var foundDevices = getDevicesFromString(action_value)

            if (!_.isNil(foundDevices)) {
                foundDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }
        })
    }

    const conditional_actions = !_.isNil(rule.actions) ? rule.actions.if : null
    if (!_.isNil(conditional_actions)) {
        Object.keys(conditional_actions).forEach(function(conditional_action_name) {
            const all_actions = conditional_actions[conditional_action_name].actions

            Object.keys(all_actions).forEach(function(action_name) {
                const action_value = all_actions[action_name]
                var foundDevices = getDevicesFromString(action_value)

                if (!_.isNil(foundDevices)) {
                    foundDevices.forEach(function(device) {
                        associatedDevices.push(device)
                    })
                }
            })
        })
    }
    const processNotifyBlock = function(notify) {
        if (!_.isNil(notify)) {
            const titleDevices = getDevicesFromString(notify.title)
            const messageDevices = getDevicesFromString(notify.message)
            const expressionDevices = getDevicesFromString(notify.when)

            if (!_.isNil(titleDevices)) {
                titleDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }

            if (!_.isNil(messageDevices)) {
                messageDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }

            if (!_.isNil(expressionDevices)) {
                expressionDevices.forEach(function(device) {
                    associatedDevices.push(device)
                })
            }
        }
    }

    if (!_.isNil(rule.notify)) {
        processNotifyBlock(rule.notify)

        if (!_.isNil(rule.notify.if)) {
            const allNotifyKeys = Object.keys(rule.notify.if)

            allNotifyKeys.forEach(notifyKey => {
                processNotifyBlock(rule.notify.if[notifyKey])
            })
        }
    }

    return associatedDevices.unique()
}

rule_loader.on('rules-loaded', () => {
    if (utilities.testMode() == true) {
        logging.debug('test mode, not loading rules')
        return
    }

    logging.info('Loading rules')

    global.devices_to_monitor = []
    clearRuleMapCache()

    var ruleCount = 0

    rule_loader.ruleIterator(function(rule_name, rule) {
        var triggerDevices = getDevicesToWatchForRule(rule)

        if (!_.isNil(triggerDevices)) {
            triggerDevices.forEach(topic => {
                var cachedRules = cachedRulesForTopic(topic)
                if (_.isNil(cachedRules)) {
                    cachedRules = {}
                }

                cachedRules[rule_name] = rule
                cacheRulesForTopic(topic, cachedRules)
            })
        }

        if (!_.isNil(triggerDevices)) {
            global.devices_to_monitor = _.concat(triggerDevices, global.devices_to_monitor)
        }

        var associatedDevices = getAssociatedDevicesFromRule(rule)
        if (!_.isNil(associatedDevices)) {
            global.devices_to_monitor = _.concat(associatedDevices, global.devices_to_monitor)
        }

        ruleCount = ruleCount + 1
    })

    global.devices_to_monitor = utilities.unique(global.devices_to_monitor)

    logging.debug('rules loaded ', {
        action: 'rules-loaded',
        devices_to_monitor: global.devices_to_monitor
    })

    logging.info(' => Rules loaded')
    logging.info('     Devices to monitor: ' + global.devices_to_monitor.length)
    logging.info('                  Rules: ' + ruleCount)

    variables.updateObservedTopics(global.devices_to_monitor, function() {
        setupMQTT()
        schedule.scheduleJobs()
        api.updateRules(rule_loader)
    })

    handleSubscriptions()
    resetRuleHistory()
})

global.clearQueues = function() {
    evaluation.clearQueues()
}

if (utilities.testMode() == false) {
    logging.debug('loading rules')
    rule_loader.load_path(config_path)
} else {
    logging.debug('not - loading rules')
}