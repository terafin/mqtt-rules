// Requirements
const mqtt = require('mqtt')
const Redis = require('redis')
const async = require('async')
const _ = require('lodash')
const mqtt_wildcard = require('mqtt-wildcard')

const rules = require('homeautomation-js-lib/rules.js')
const logging = require('homeautomation-js-lib/logging.js')
const metrics = require('homeautomation-js-lib/stats.js')

require('homeautomation-js-lib/devices.js')
require('homeautomation-js-lib/mqtt_helpers.js')
require('homeautomation-js-lib/redis_helpers.js')

var collectedMQTTTChanges = null

const api = require('./lib/api.js')
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

const startCollectingMQTTChanges = function() {
	if ( _.isNil(collectedMQTTTChanges) ) {
		collectedMQTTTChanges = {} 
	}
}

const stopCollectingMQTTChanges = function() {
	collectedMQTTTChanges = null
}

const handleRedisConnection = function() {
	logging.info(' Redis Connected')
	handleConnectionEvent()
}

const handleMQTTConnection = function() {
	startCollectingMQTTChanges()

	handleSubscriptions()

	logging.info(' MQTT Connected')
	handleConnectionEvent()
}

const disconnectionEvent = function() {
	if ( global.client.connected && global.redis.connected ) {
		return
	}
    
	logging.error(' Disconnected from redis or MQTT')
	startCollectingMQTTChanges()
}

const connectionProcessor = function() {
	logging.info(' => Processing bulk connection setup start')

	// need to capture everything that comes in, and process it as such
	const changedTopics = Object.keys(collectedMQTTTChanges)

	changedTopics.forEach(topic => {
		const message = collectedMQTTTChanges[topic]

		global.generateContext(topic, message, function(outTopic, outMessage, context) {
			if ( _.isNil(outTopic) || _.isNil(outMessage) ) {
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
	if ( !global.client.connected ) { 
		return 
	}
	if ( !global.redis.connected ) { 
		return
	}
    
	logging.info(' Both are good to go - kicking connection processing in ' + connectionProcessorDelay)

	setTimeout(connectionProcessor, (connectionProcessorDelay * 1000))
}

const handleSubscriptions = function() {
    
	if (is_test_mode === false) {
		if ( !global.client.connected ) { 
			return 
		}

		global.client.unsubscribe('#')

		global.devices_to_monitor.forEach(topic => {
			logging.debug(' => subscribing to: ' + topic)
			global.client.subscribe(topic)
		})
	}
}

// Setup MQTT
if (is_test_mode === false) {
	global.client = mqtt.setupClient(function() {
		handleMQTTConnection()
	}, function() {
		disconnectionEvent()
	})
}
global.publishEvents = []

global.publish = function(rule_name, expression, valueOrExpression, topic, message, inOptions) {
	var options = {retain: false}
	var quiet = false

	if (!_.isNil(inOptions)) {
		if ( !_.isNil(inOptions.quiet) ) { 
			quiet = inOptions.quiet 
		}

		Object.keys(inOptions).forEach(function(key) {
			options[key] = inOptions[key]
		})
	}
	
	if ( !quiet ) { 
		logging.info('=> rule: ' + rule_name + '  publishing: ' + topic + ':' + message + ' (expression: ' + expression + ' | value: ' + valueOrExpression + ')' + '  options: ' + JSON.stringify(inOptions)) 
	}

	global.client.publish(topic, message, options)
}

global.devices_to_monitor = []

global.changeProcessor = function(rules, context, topic, message) {
	context[utilities.update_topic_for_expression(topic)] = message

	const firstRun = context['firstRun']
	const ruleStartTime = new Date().getTime()
	logging.info(' rule processing start ', {
		action: 'rule-processing-start',
		start_time: ruleStartTime
	})

	var ruleProcessor = function(rule, rule_name, callback) {
		if ( _.isNil(rule) ) {
			logging.error('empty rule passed, with name: ' + rule_name)
			return
		}
		const skipFirstRun = _.isNil(rule.skip_first_run) ? false : rule.skip_first_run

		if ( firstRun && skipFirstRun ) {
			logging.info(' skipping rule, due to first run skip: ' + rule_name)
			return
		}

		const disabled = rule.disabled

		if (disabled == true) {
			return
		}

		const watch = rule.watch

		if (!_.isNil(watch) && !_.isNil(watch.devices)) {
			var foundMatch = null

			watch.devices.forEach(deviceToWatch => {
				if ( !_.isNil(foundMatch) ) {
					return 
				}
    
				const match = mqtt_wildcard(topic, deviceToWatch)
				if ( !_.isNil(match) ) {
					foundMatch = match
				}
			})
    
            
			if ( !_.isNil(foundMatch) ) {
				logging.info('matched topic to rule', {
					action: 'rule-match',
					rule_name: rule_name,
					topic: topic,
					message: utilities.convertToNumberIfNeeded(message),
					rule: rule
					// context: context
				})

				evaluation.evalulateValue(topic, context, rule_name, rule, false)
			}
		}

		callback()
	}

	var configProcessor = function(config, callback) {
		async.eachOf(config, ruleProcessor)
		callback()
	}

	async.each(rules, configProcessor)

	logging.info(' rule processing done ', {
		action: 'rule-processing-done',
		processing_time: ((new Date().getTime()) - ruleStartTime)
	})
}

var overrideContext = null
global.setOverrideContext = function(inContext) {
	overrideContext = inContext
}

global.generateContext = function(topic, inMessage, callback) {
	if ( _.isNil(callback)) {
		return 
	}
    
	var message = utilities.convertToNumberIfNeeded(inMessage)
	const redisStartTime = new Date().getTime()
	logging.info(' redis query', {
		action: 'redis-query-start',
		start_time: redisStartTime
	})

	var devices_to_monitor = global.devices_to_monitor

	if ( !_.isNil(topic) && !devices_to_monitor.includes(topic) ) {
		logging.debug('devices_to_monitor query missing: ' + topic)
		devices_to_monitor.push(topic)
	}

	if ( !_.isNil(overrideContext) ) {
		devices_to_monitor = Object.keys(overrideContext)
		logging.debug('generating context from override: ' + JSON.stringify(overrideContext))
	} else if ( is_test_mode == true ) {
		callback(topic, message, {})
		return
	}

	const processResults = function(err, values) {
		const redisQueryTime = ((new Date().getTime()) - redisStartTime)
		logging.info(' redis query done', {
			action: 'redis-query-done',
			query_time: redisQueryTime
		})

		metrics.submit('redis_query_time', redisQueryTime)

		var context = {}

		for (var index = 0; index < devices_to_monitor.length; index++) {
			const key = devices_to_monitor[index]
			// bug here with index
			const value = values[index]
			const newKey = utilities.update_topic_for_expression(key)

			// If for some reason we passed in a null message, let's see waht redis has to say here
			if (key === topic && _.isNil(message)) {
				message = utilities.convertToNumberIfNeeded(value)
			}
            
			if (key === topic) { 
				context[newKey] = utilities.convertToNumberIfNeeded(message)
			} else {
				context[newKey] = utilities.convertToNumberIfNeeded(value) 
			}
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

		if ( !_.isNil(overrideContext) ) {
			logging.debug('generated context from override: ' + JSON.stringify(context))
			logging.debug('             devices_to_monitor: ' + JSON.stringify(devices_to_monitor))
		}
    
		callback(topic, message, context)
	}
    
	if ( _.isNil(overrideContext)) {
		global.redis.mget(devices_to_monitor, processResults)
	} else {
		var keys = Object.keys(overrideContext)
		var values = keys.map(function(v) {
			return overrideContext[v] 
		})

		processResults(null, values)
	}
}

if (is_test_mode === false) {
	global.client.on('message', (topic, message) => {
		if ( !_.isNil(collectedMQTTTChanges) ) {
			logging.info(' * pending processing update for: ' + topic + '  => not yet connected to redis')
			collectedMQTTTChanges[topic] = message
			return
		}
		logging.info('incoming topic message: ' + topic)
		logging.info('   global.devices_to_monitor: ' + global.devices_to_monitor)
		var foundMatch = null
		global.devices_to_monitor.forEach(deviceToMontor => {
			if ( !_.isNil(foundMatch) ) {
				return 
			}

			const match = mqtt_wildcard(topic, deviceToMontor)
			if ( !_.isNil(match) ) {
				foundMatch = match
			}
		})
        
		if ( _.isNil(foundMatch) ) {
			logging.info('   ** NO MATCH FOUND FOR: ' + topic)
			return
		} else {
			logging.info(topic + ' matched with: ' + foundMatch)
		}

		global.generateContext(topic, message, function(outTopic, outMessage, context) {
			global.changeProcessor(rules.get_configs(), context, topic, message)
		})
	})
}

global.redis = Redis.setupClient(function() {
	if (is_test_mode == false) {
		logging.debug('loading rules')
		rules.load_path(config_path)
	} else {
		logging.debug('not - loading rules')
	}

	handleRedisConnection()
}, function() {
	logging.info('redis disconnected ', {
		action: 'redis-disconnected'
	})
	disconnectionEvent()
})

rules.on('rules-loaded', () => {
	if (is_test_mode == true) {
		logging.debug('test mode, not loading rules')
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
						global.devices_to_monitor.push(device)
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
						global.devices_to_monitor.push(device)
					})
				}
			})
		}

	})

	global.devices_to_monitor = utilities.unique(global.devices_to_monitor)

	logging.info('rules loaded ', {
		action: 'rules-loaded',
		devices_to_monitor: global.devices_to_monitor
	})
	logging.info('rules loaded')

	handleSubscriptions()

	schedule.scheduleJobs()
	api.updateRules(rules)
})

global.clearQueues = function() {
	evaluation.clearQueues()
}
