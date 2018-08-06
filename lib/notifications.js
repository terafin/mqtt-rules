const _ = require('lodash')
const pushover = require('pushover-notifications')
const utilities = require('./utilities.js')
const logging = require('homeautomation-js-lib/logging.js')

exports.handleNotification = function(name, topic, context, notify_config) {
	logging.debug(' ** notifying: ' + JSON.stringify(notify_config))

	const baseAppToken = process.env.PUSHOVER_APP_TOKEN
	const baseUserToken = process.env.PUSHOVER_USER_TOKEN
	var p = new pushover({
		user: (notify_config.user ? notify_config.user : baseUserToken),
		token: (notify_config.token ? notify_config.token : baseAppToken),
		onerror: function(error) {
			logging.error(' pushover error: ', error)
		},
		update_sounds: true // update the list of sounds every day - will
	})


	if (_.isNil(notify_config.message)) {
		logging.warn(' Empty notification message', notify_config)
		return
	}
	var notify_message = notify_config.message
	var notify_title = notify_config.title


	utilities.resolveValueOrExpression(name, topic, context, notify_config.message, null).then(result => {
		notify_message = result
		logging.debug(' resolved message: ' + result)

		utilities.resolveValueOrExpression(name, topic, context, notify_config.title, null).then(result => {
			logging.debug(' resolved title: ' + result)
			notify_title = result

			var msg = {
				// These values correspond to the parameters detailed on https://pushover.net/api
				// 'message' is required. All other values are optional.
				message: notify_message,
				title: notify_title,
				sound: notify_config.sound,
				device: notify_config.device,
				priority: notify_config.priority,
				url: notify_config.url,
				url_title: notify_config.url_title,
			}
        
			p.send(msg, function(err, result) {
				var json = notify_config
				json.action = 'notify'
				json.result = result
				json.rule_name = name
				if (!_.isNil(err)) {
					json.error = err
					logging.error(' failed notification', json)
				} else {
					logging.info(' successfully notified', json)
				}
			})
		})
	})
}

exports.notificationProcessor = function(options, context, rule_name, notify_config, notify_name, callback) { // ISOLATED
	logging.debug('evaluating for notify: ' + notify_name + '  notify_config: ' + notify_config)
	var expression = notify_config.expression
	const publishExpression = utilities.prepareExpression(null, utilities.update_topic_for_expression(expression), context)

	utilities.resolveValueOrExpression(rule_name, '', context, publishExpression, null).then(publishResult => {
		logging.debug(' should notify: ' + publishExpression)
		if (publishResult == true) {
			exports.handleNotification(rule_name, '', context, notify_config)
		}
	})

	callback()
}
