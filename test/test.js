const utilities = require('../lib/utilities.js')
const rules = require('../lib/loading.js')

const TIMEZONE = utilities.getCurrentTimeZone()
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const read_directory = require('read-directory')

console.log('Running in timezone: ' + TIMEZONE)

process.env.TEST_MODE = true
const testYAMLPath = process.env.TEST_YAML_PATH
const yaml = require('js-yaml')

require('../mqtt-rules.js')
const variables = require('../lib/variables.js')

var targetTestActions = null
var targetCallback = null
var targetEarliestDate = null
var targetStartDate = null

var clearState = function() {
	targetTestActions = null
	targetCallback = null
	targetEarliestDate = null
	targetStartDate = null
}

var setupTest = function(actions, callback, minimumTime) {
	clearState()

	targetTestActions = actions
	targetCallback = callback
	if ((minimumTime != null) && minimumTime > 0) {
		targetEarliestDate = new Date(new Date().getTime() + (minimumTime * 1000))
		targetStartDate = new Date().getTime()
		// console.log('minimum fire date: ' + targetEarliestDate)
	}
}

global.publish = function(rule_name, expression, valueOrExpression, topic, message, options) {
	if (topic.startsWith('happy')) {
		return
	}

	// console.log('incoming: ' + topic + ':' + message)

	if ( _.isNil(targetTestActions)) {
		logging.error('fail, I was not expecting anything and I got: ' + topic + ' message: ' + message)
		return
	}

	const targetTestMessage = targetTestActions[topic]

	if (!_.isNil(targetTestMessage) && message == targetTestMessage) {
		delete(targetTestActions[topic])
		// console.log('clearing: ' + topic)

		if (Object.keys(targetTestActions).length == 0) {
			// console.log('all clear!')

			if ((targetCallback != null)) {
				//  console.log('incoming: ' + topic + ' : ' + message + '   (time: ' + (new Date().getTime()) / 1000 + ')')
				var tooEarly = false
				var howEarly = 0
				var desiredMinimum = 0
				if (targetEarliestDate != null) {
					const now = new Date()
					// console.log('minimum fire date: ' + targetEarliestDate + '   now: ' + now)

					// Fudge half a second, as sometimes timers early fire a little bit...
					if (now + 0.5 < targetEarliestDate) {
						tooEarly = true
						howEarly = targetEarliestDate - now
						desiredMinimum = (targetEarliestDate - targetStartDate) / 1000
					}
				}
				var oldCallBack = targetCallback

				clearState()

				setTimeout(function cb() {
					if (tooEarly) {
						oldCallBack('test finished too early (' + howEarly + 's vs ' + desiredMinimum + 's)')
					} else {
						oldCallBack()
					}
				})
			}
		} else {
			// console.log('remaining: ' + Object.keys(targetTestActions))
		}
	} else {
		logging.error('fail, I got: ' + topic + ' message: ' + message)
	}
}

const msForProcessing = 15

const testProcessor = function(rule, rule_name, test, test_name) {
	var test_timeout = test.timeout
	const context = test.context
	const input = test.input
	const target = test.target

	if (_.isNil(test_timeout)) {
		test_timeout = msForProcessing
	} else {
		test_timeout = test_timeout + msForProcessing
	}

	const inputTopic = Object.keys(input)[0]
	const inputValue = input[inputTopic]

	var formattedRule = {}
	formattedRule[rule_name] = rule

	var allTopics = []

	if (!_.isNil(context)) {
		allTopics = allTopics.concat(Object.keys(context))
	}

	if (!_.isNil(inputTopic)) {
		allTopics.push(inputTopic)
	}

	it(test_name, function(done) {
		this.slow(Number(test_timeout * 2))
		this.timeout(Number(test_timeout * 3))

		variables.clearState()
		variables.updateObservedTopics(allTopics, function() {
			global.devices_to_monitor = allTopics

			if (!_.isNil(context)) {
				Object.keys(context).forEach(topic => {
					variables.update(topic, context[topic])
				})
			}

			global.clearRuleMapCache()

			rules.set_override_configs([formattedRule])
			setupTest(target, done)

			global.generateContext(inputTopic, inputValue, function(outTopic, outMessage, generatedContext) {
				global.changeProcessor(null, generatedContext, outTopic, outMessage)
			})
		})
	})
}

const processRuleFile = function(doc) {
	if (_.isNil(doc)) {
		return
	}

	Object.keys(doc).forEach(rule_name => {
		const rule = doc[rule_name]

		const test = rule.test
		const tests = rule.tests

		if (_.isNil(test) && _.isNil(tests)) {
			return
		}

		var testsToRun = {}

		if (!_.isNil(test)) {
			testsToRun[rule_name] = test
		}

		if (!_.isNil(tests)) {
			Object.keys(tests).forEach(innerTest => {
				const key = rule_name + '_' + innerTest
				testsToRun[key] = tests[innerTest]
			})
		}

		Object.keys(testsToRun).forEach(testName => {
			testProcessor(rule, rule_name, testsToRun[testName], testName)
		})

	})
}

describe('quick trigger tests', function() {
	before(function() {
		// runs before all tests in this block
		global.clearQueues()
	})

	var documents = []
	const yamlPath = !_.isNil(testYAMLPath) ? testYAMLPath : './test/yaml'
	const files = read_directory.sync(yamlPath, {})

	const fileNames = Object.keys(files)

	fileNames.forEach(file => {
		if (file.includes('._')) {
			return
		}

		if (file.includes('.yml') || file.includes('.yaml')) {
			const doc = yaml.safeLoad(files[file])

			documents.push(doc)
		}
	})

	documents.forEach(doc => {
		processRuleFile(doc)
	})

})
