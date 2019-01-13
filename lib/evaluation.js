const _ = require('lodash')
const moment = require('moment-timezone')
const logging = require('homeautomation-js-lib/logging.js')
const queue = require('./queue.js')
var async = require('async')

const utilities = require('./utilities.js')
const actions = require('./actions.js')
const metrics = require('homeautomation-js-lib/stats.js')
const TIMEZONE = utilities.getCurrentTimeZone()

const isGoodTime = function(allowedTimes) {
	if ( global.isTestMode() ) {
		return true
	}

	var isOKTime = false
	const currentDate = moment(new Date()).tz(TIMEZONE)

	allowedTimes.forEach(function(timeRange) {
		if (isOKTime) {
			return
		}
		const split = timeRange.split('-')
		const startDate = moment(new Date()).tz(TIMEZONE)
		const endDate = moment(new Date()).tz(TIMEZONE)

		const startHours = split[0].split(':')[0]
		const startMinutes = split[0].split(':')[1]

		const endHours = split[1].split(':')[0]
		const endMinutes = split[1].split(':')[1]

		startDate.hours(Number(startHours))
		startDate.minutes(Number(startMinutes))
		endDate.hours(Number(endHours))
		endDate.minutes(Number(endMinutes))
		const result = currentDate.isBetween(startDate, endDate)
		if (result == true) {
			isOKTime = true
		}

		// logging.info('good time: ' + isOKTime)
		// logging.info('     current date: ' + currentDate.format('MMMM Do YYYY, h:mm:ss a'))
		// logging.info('tz startDate date: ' + startDate.tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a'))
		// logging.info('tz   endDate date: ' + endDate.tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a'))

		// logging.info('     current date: ' + currentDate.format('MMMM Do YYYY, h:mm:ss a'))
		// logging.info('   startDate date: ' + startDate.format('MMMM Do YYYY, h:mm:ss a'))
		// logging.info('     endDate date: ' + endDate.format('MMMM Do YYYY, h:mm:ss a'))
	})

	return isOKTime
}

const evaluateProcessor = function(job, doneEvaluate) {
	const queue_time = job.data.queue_time
	const name = job.data.name
	const topic = job.data.topic
	const context = job.data.context_value
	const rule = job.data.rule
	const options = rule.options
	var rule_actions = rule.actions
	const conditional_actions = !_.isNil(rule_actions) ? rule_actions.if : null
	const allowed_times = rule.allowed_times
	const startTime = new Date().getTime()
	var quiet = false

	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	var logResult = {
		action: 'rule-time-evaluation',
		rule_name: name,
		rule: rule,
		topic: topic,
		allowed_times: allowed_times
	}
	var isOKTime = true

	if ( !quiet ) {
		logging.debug(' evaluation queue: starting: ' + name + ' context: ' + JSON.stringify({
			action: 'evaluate-process-start',
			rule_name: name,
			queue_time: (startTime - queue_time)
		}))
	}
	const currentDate = moment(new Date()).tz(TIMEZONE)

	if (!_.isNil(allowed_times)) {
		isOKTime = isGoodTime(allowed_times)
	}

	if (!isOKTime) {
		if ( !quiet && !global.isTestMode() ) {
			logging.info('not evaluating: ' + name + ' bad time (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ')')
			logging.debug('not evaluating, bad time (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ')  =>(' + name + ')', logResult)
			logging.debug('eval queue: ' + name + '    end - not a good time')
			logging.debug(' evaluation queue: ' + name + ' data:' + JSON.stringify({
				action: 'evaluate-process-done',
				rule_name: name,
				queue_time: ((new Date().getTime()) - startTime)
			}))
		}

		if (!_.isNil(doneEvaluate)) {
			doneEvaluate() 
		}

		return
	}

	if ( !quiet && !global.isTestMode() ) { 
		logging.info('evaluating: ' + name + '   (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ')' + '  topic: ' + topic) 
		logging.debug('evaluating, good time  (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ') =>(' + name + ')', logResult) 
	}

	if (!_.isNil(conditional_actions)) {
		var conditionalProcessor = function(conditional_rule, conditional_rule_name, callback) {
			var newJob = {}
			newJob.data = job.data
			newJob.data.rule = conditional_rule
			newJob.data.name = conditional_rule_name
			
			evaluateProcessor(newJob, null)

			return callback()
		}

		async.eachOf(conditional_actions, conditionalProcessor)
	}

	if (!_.isNil(rule.rules) && !_.isNil(rule.rules.expression)) {
		const expressionHandler = function(expressionString, callback) {
			utilities.resolveValueOrExpression(name, topic, context, expressionString, options).then(result => {
				actions.performAction(result, context, name, rule, logResult)
				if ( !quiet && !global.isTestMode() ) { 
					logging.debug('eval queue: ' + name + '    end expression') 
				}
			})
        
			if ( !_.isNil(callback)) {
				return callback()
			}
		}

		if (!_.isNil(rule.rules.expression.if)) {
			async.each(rule.rules.expression.if, expressionHandler)
		} else {
			expressionHandler(rule.rules.expression, null)
		}
	} else {
		if ( !quiet && !global.isTestMode() ) { 
			logging.debug('  =>(' + name + ') skipped evaluated expression, no expression to evaluate (no rule)') 
		}

		actions.performAction(true, context, name, rule, logResult)

		if ( !quiet && !global.isTestMode() ) { 
			logging.debug('eval queue: ' + name + '    end expression - no expression/rules') 
		}
	}

	const evaluation_queue_time = ((new Date().getTime()) - startTime)
	
	if ( !quiet && !global.isTestMode() ) { 
		logging.debug(' evaluation queue: ' + name  + ' data:' + JSON.stringify( {
			action: 'evaluate-process-done',
			rule_name: name,
			queue_time: evaluation_queue_time
		}))
	}

	metrics.submit('evaluation_queue_time', evaluation_queue_time)

	if (!_.isNil(doneEvaluate)) {
		doneEvaluate()
	}
}

exports.evalulateValue = function(topic, in_context, name, rule, isScheduledJob) {
	var queueName = name
	const options = rule.options
	const customQueueName = rule.queue
	var evaluateAfter = rule.evaluate_after
	var quiet = false

	if ( global.isTestMode() && !_.isNil(evaluateAfter) ) {
		evaluateAfter = 1
	}
	
	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	if ( isScheduledJob ) {
		evaluateAfter = 0 
	}

	if (!_.isNil(customQueueName)) {
		queueName = customQueueName
	}

	var job = {
		rule: rule,
		options: options,
		name: '' + name,
		topic: topic,
		queue_time: (new Date().getTime()),
		context_value: {}
	}

	Object.keys(in_context).forEach(function(key) {
		job.context_value[key] = '' + in_context[key]
	}, this)

	job.context_value['TRIGGER_STRING'] = topic
	job.context_value['TRIGGER_TIME_UNIX'] = moment(new Date()).tz(TIMEZONE).unix()
	job.context_value['TRIGGER_TIME_STRING'] = moment(new Date()).tz(TIMEZONE).toDate()

	if ( !_.isNil(topic) ) {
		job.context_value['TRIGGER_TOPIC'] = topic

		var topicComponents = topic.split('/')
		if ( topicComponents[0] == '' ) { 
			topicComponents.shift() 
		}
            
		job.context_value['TRIGGER_COMPONENTS'] = topicComponents
	}
	if (evaluateAfter > 0) { 
		if ( !quiet && !global.isTestMode() ) { 
			logging.info('enqueued expression evaluation =>(' + name + ')    for: ' + evaluateAfter) 
		}
	}

	if ( !quiet && !global.isTestMode() ) { 
		logging.debug('enqueued expression evaluation =>(' + queueName + ')'  + 'data:' + JSON.stringify({
			action: 'enqueued-evaluation',
			delay: evaluateAfter,
			rule_name: name,
			rule: rule,
			queue_name: queueName
		})) 
	}

	queue.enqueue('evaluation', queueName, evaluateProcessor, job, evaluateAfter * 1000, true, null)
}

exports.clearQueue = function(name) {
	queue.clearQueue('evaluation', name)
}

exports.clearQueues = function() {
	queue.clearQueues('evaluation')
}
