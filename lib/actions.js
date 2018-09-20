var async = require('async')
const _ = require('lodash')
const request = require('request')

const utilities = require('./utilities.js')
const notifications = require('./notifications.js')
const queue = require('./queue.js')
const logging = require('homeautomation-js-lib/logging.js')

const handleWebActions = function(web) {
	if ( _.isNil(web) ) {
		return
	}
	logging.debug('handleWebActions: ' + JSON.stringify(web))

	const getRequests = web.get

	if ( !_.isNil(getRequests) ) {
		// Format is name: url

		Object.keys(getRequests).forEach(urlName => {
			const urlString = getRequests[urlName]
            
			if ( _.isNil(urlString)) { 
				return
			}

			if ( global.isTestMode()  ) {
				return
			}
				
			logging.info('Handling get request: ' + urlName + '   url: ' + urlString)

			request.get({url: urlString},
				function(err, httpResponse, body) {
					if ( !_.isNil(err) ) {
						logging.error('_get url:' + urlString)
						logging.error('error:' + err)
						logging.error('httpResponse:' + httpResponse)
						logging.error('body:' + body)
					}
				})    
		})
	}
}

const actionProcessor = function(options, inContext, rule_name, valueOrExpression, topic, callback) { // ISOLATED
	var quiet = false
	var context = {}

	Object.keys(inContext).forEach(key => {
		context[key] = utilities.convertToNumberIfNeeded(inContext[key])
	})
	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	if ( !quiet && !global.isTestMode() ) { 
		logging.debug('evaluating for publish: ' + topic + '  value: ' + valueOrExpression + '  context: ' + JSON.stringify(context)+ '  options: ' + options) 
	}

	utilities.resolveValueOrExpression(rule_name, topic, context, valueOrExpression, options).then(resultString => {
		if ( !quiet && !global.isTestMode() ) { 
			logging.info(' => publishing rule: ' + rule_name + '   topic: ' + topic + '   value: ' + resultString) 

			logging.debug(' published result', {
				action: 'published-value',
				rule_name: rule_name,
				topic: topic,
				value: resultString
			})
		}

		global.publish(rule_name, '', valueOrExpression, topic, '' + resultString, options)
	})

	callback()
}

const jobProcessor = function(job, doneAction) {
	const queueTime = job.data.queue_time
	const actions = job.data.actions
	const notify = job.data.notify
	const web  = job.data.web
	const name = job.data.rule_name
	const options = job.data.options
	const context = job.data.context
	const startTime = new Date().getTime()

	logging.debug('action queue: ' + name + '    begin')
	logging.debug(' action queue: ' + name, {
		action: 'job-process-start',
		rule_name: name,
		actions: actions,
		queue_time: (startTime - queueTime)
	})

	if (!_.isNil(actions)) { // name, context
		async.eachOf(actions, actionProcessor.bind(undefined, options, context, name))
	}

	if (!_.isNil(notify)) {
		if (!_.isNil(notify.if)) {
			logging.debug(' checking notification evaluation')
			async.eachOf(notify.if, notifications.notificationProcessor.bind(undefined, options, context, name))
		} else {
			logging.debug(' directly notifying')
			notifications.handleNotification(name, '', context, notify)
		}
	} else {
		logging.debug(' nothing to notify about')
	}

	handleWebActions(web)

	logging.debug('action queue: ' + name + '    end')

	if (!_.isNil(doneAction)) {
		doneAction() 
	}

	logging.debug(' processing done: ' + name, {
		action: 'job-process-done',
		rule_name: name,
		processing_time: ((new Date().getTime()) - startTime)
	})
}

exports.performAction = function(eval_result, context, name, rule, logResult) {
	if (eval_result === true) {
		const actions = rule.actions
		const web = rule.web
		const options = rule.options
		const notify = rule.notify
		var delayed_actions = rule.delayed_actions
		var delayed_actions_delay = _.isNil(delayed_actions) ? -1 : delayed_actions['delay']

		if ( global.isTestMode() && delayed_actions > -1 ) {
			delayed_actions_delay = 1
		}

		var quiet = false

		if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
			quiet = options.quiet 
		}
		
		var perform_after = rule.perform_after

		if (_.isNil(perform_after)) {
			perform_after = 0
		} else if ( global.isTestMode() ) {
			perform_after = 1
		}

		if (perform_after > 0) {
			if ( !quiet && !global.isTestMode() ) { 
				logging.info('enqueued action =>(' + name + ')    for: ' + perform_after) 
			} 
		} else {
			if ( !quiet && !global.isTestMode() ) { 
				logging.debug('enqueued action =>(' + name + ')', Object.assign(logResult, {
					action: 'enqueued-action',
					delay: perform_after,
					actions: actions,
					web: web,
					delayed_actions: delayed_actions,
					notify: notify,
					queue_name: name
				})) 
			}
		}

		const data = {
			rule_name: name,
			options: options,
			notify: notify,
			web: web,
			actions: actions,
			queue_time: (new Date().getTime()),
			context: context
		}
		queue.enqueue('actions', name, jobProcessor, data, perform_after, true, logResult)

		if (delayed_actions_delay > 0) {
			var delayed_data = {
				rule_name: name,
				options: options,
				notify: notify,
				web: web,
				actions: delayed_actions.actions,
				queue_time: (new Date().getTime()),
				context: context
			}
			delete delayed_data['delay']

			queue.enqueue('actions', name, jobProcessor, delayed_data, delayed_actions_delay, false, logResult)
		}
	}
}

exports.clearQueue = function(name) {
	queue.clearQueue('actions', name)
}

exports.clearQueues = function() {
	queue.clearQueues('actions')
}
