// Requirements
const mqtt = require('mqtt')
const async = require('async')
const _ = require('lodash')
const mqtt_wildcard = require('mqtt-wildcard')

const logging = require('homeautomation-js-lib/logging.js')
const health = require('homeautomation-js-lib/health.js')

require('homeautomation-js-lib/devices.js')
require('homeautomation-js-lib/mqtt_helpers.js')
require('homeautomation-js-lib/redis_helpers.js')

var collectedMQTTTChanges = null

const rules = require('./lib/loading.js')
const api = require('./lib/api.js')
const variables = require('./lib/variables.js')
const utilities = require('./lib/utilities.js')
const schedule = require('./lib/scheduled-jobs.js')
const evaluation = require('./lib/evaluation.js')

const config_path = process.env.TRANSFORM_CONFIG_PATH
const connectionProcessorDelay = 10

var is_test_mode = process.env.TEST_MODE

if (is_test_mode == 'true') {
	is_test_mode = true
} else if (is_test_mode != true) {
	is_test_mode = false
}


global.isTestMode = function() {
	return is_test_mode
}
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
	if (is_test_mode === false) {
		global.client.on('message', (topic, message) => {
			if (isCollectingMQTTChanges()) {
				logging.info(' * pending processing update for: ' + topic + '  => (handling in bulk)')
				collectChange(topic, message)
				return
			}
			var foundMatch = null
			global.devices_to_monitor.forEach(deviceToMontor => {
				if (!_.isNil(foundMatch)) {
					return
				}

				const match = mqtt_wildcard(topic, deviceToMontor)
				if (!_.isNil(match)) {
					foundMatch = match
				}
			})

			if (_.isNil(foundMatch)) {
				return
			}

			logging.debug('incoming topic message: ' + topic)

			global.generateContext(topic, message, function(outTopic, outMessage, context) {
				global.changeProcessor(rules.get_configs(), context, topic, message)
			})
		})
	}

	startCollectingMQTTChanges()

	handleSubscriptions()

	logging.info(' MQTT Connected')
	handleConnectionEvent()
}

const disconnectionEvent = function() {
	if (!_.isNil(global.client) && global.client.connected ) {
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
				global.changeProcessor(rules.get_configs(), context, outTopic, outMessage)
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

	if (is_test_mode === false) {
		if (_.isNil(global.client) || !global.client.connected) {
			return
		}

		global.client.unsubscribe('#')

		global.devices_to_monitor.forEach(topic => {
			logging.debug(' => subscribing to: ' + topic)
			global.client.subscribe(topic)
		})
	}
}

const setupMQTT = function() {
	if (!_.isNil(global.client)) {
		return
	}

	if (is_test_mode === false) {
		global.client = mqtt.setupClient(function() {
			handleMQTTConnection()
		}, function() {
			disconnectionEvent()
		})
	}
}

global.publishEvents = []

global.publish = function(rule_name, expression, valueOrExpression, topic, message, inOptions) {
	var options = {
		retain: false
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

	if (!quiet && !global.isTestMode()) {
		logging.info('=> rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(inOptions))
	}

	if (_.isNil(global.client)) {
		logging.error('=> (client not initialized, not publishing) rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(inOptions))
	} else {
		global.client.publish(topic, message, options)
	}
}

global.devices_to_monitor = []

global.changeProcessor = function(rules, context, topic, message) {
	variables.update(topic, message)

	if (_.isNil(context)) {
		context = {}
	}
	
	context[utilities.update_topic_for_expression(topic)] = message

	const firstRun = context['firstRun']
	const ruleStartTime = new Date().getTime()
	logging.debug(' rule processing start ', {
		action: 'rule-processing-start',
		start_time: ruleStartTime
	})

	var ruleProcessor = function(rule, rule_name, callback) {
		if (_.isNil(rule)) {
			logging.error('empty rule passed, with name: ' + rule_name)
			return
		}
		const skipFirstRun = _.isNil(rule.skip_first_run) ? false : rule.skip_first_run

		if (firstRun && skipFirstRun) {
			logging.debug(' skipping rule, due to first run skip: ' + rule_name)
			return
		}

		const disabled = rule.disabled

		if (disabled == true) {
			logging.info(' skipping rule, rule disabled: ' + rule_name)
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
					foundMatch = match
				}
			})


			if (!_.isNil(foundMatch)) {
				logging.debug('matched topic to rule', {
					action: 'rule-match',
					rule_name: rule_name,
					topic: topic,
					message: utilities.convertToNumberIfNeeded(message),
					rule: rule
					// context: context
				})

				evaluation.evalulateValue(topic, context, rule_name, rule, false)
			} else {
				logging.debug(' skipping rule, no match for devices in : ' + rule_name)
			}
		} else {
			logging.debug(' skipping rule, no devices to watch: ' + JSON.stringify(rule))
		}

		callback()
	}

	var configProcessor = function(config, callback) {
		async.eachOf(config, ruleProcessor)
		callback()
	}

	async.each(rules, configProcessor)

	logging.debug(' rule processing done ', {
		action: 'rule-processing-done',
		processing_time: ((new Date().getTime()) - ruleStartTime)
	})
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

	if ( !_.isNil(valueMap) ) {
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
			logging.debug('invalid json')
		}
	}

	if ( !_.isNil(callback) ) {
		return callback(topic, message, context)
	}
}

const getDevicesToWatchForRule = function(rule) {
	if ( _.isNil(rule) ) { 
		return
	}


	const watch = rule.watch
	if (!_.isNil(watch)) {
		var associatedDevices = []

		const devices = watch.devices
		if (!_.isNil(devices)) {
			devices.forEach(function(device) {
				associatedDevices.push(device)
			})
		}

		return associatedDevices
	}

	return getAssociatedDevicesFromRule(rule)
}

const getAssociatedDevicesFromRule = function(rule) {
	if ( _.isNil(rule) ) { 
		return
	}

	var associatedDevices = []

	const watch = rule.watch
	if (!_.isNil(watch)) {
		const devices = watch.devices
		if (!_.isNil(devices)) {
			devices.forEach(function(device) {
				global.devices_to_monitor.push(device)
			})
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
					associatedDevices.push(device)
				})
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
					associatedDevices.push(device)
				})
			}
		})
	}

	return associatedDevices
}

rules.on('rules-loaded', () => {
	if (is_test_mode == true) {
		logging.debug('test mode, not loading rules')
		return
	}

	logging.info('Loading rules')

	global.devices_to_monitor = []
	global.ruleToDevicesMap = {}

	rules.ruleIterator(function(rule_name, rule) {
		var associatedDevices = getAssociatedDevicesFromRule(rule)
		if ( !_.isNil(associatedDevices) ) {
			global.devices_to_monitor = _.concat(associatedDevices, global.devices_to_monitor)
		}
	})

	global.devices_to_monitor = utilities.unique(global.devices_to_monitor)

	logging.debug('rules loaded ', {
		action: 'rules-loaded',
		devices_to_monitor: global.devices_to_monitor
	})

	logging.info(' => Rules loaded')

	variables.updateObservedTopics(global.devices_to_monitor, function() {
		setupMQTT()
		schedule.scheduleJobs()
		api.updateRules(rules)
	})
})

global.clearQueues = function() {
	evaluation.clearQueues()
}

if (is_test_mode == false) {
	logging.debug('loading rules')
	rules.load_path(config_path)
} else {
	logging.debug('not - loading rules')
}
