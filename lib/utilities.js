const _ = require('lodash')
var Jexl = require('jexl')
const logging = require('homeautomation-js-lib/logging.js')
const metrics = require('homeautomation-js-lib/stats.js')
const moment = require('moment-timezone')
const feels = require('feels')

exports.jexl = function() {
	var jexl = new Jexl.Jexl()

	jexl.addTransform('split', function(val, char) {
		return val.split(char)
	})

	jexl.addTransform('words', function(val) {
		return _.words(val)
	})

	jexl.addTransform('lowercase', function(val) {
		return val.toLowerCase()
	})

	jexl.addTransform('uppercase', function(val) {
		return _.upperCase(val)
	})
    
	jexl.addTransform('uppercaseFirst', function(val) {
		return _.upperFirst(val)
	})
    
	jexl.addTransform('camelCase', function(val) {
		return _.camelCase(val)
	})
    
	jexl.addTransform('startCase', function(val) {
		return _.startCase(val)
	})
	
	jexl.addTransform('feelsLikeAAT_C', function(temperature, humidity) {
		const config = {
			temp: temperature,
			humidity: humidity,
			units: {
				temp: 'c'
			}
		}

		return feels(config).like(['AAT'])
	})
	
	jexl.addTransform('trim', function(val) {
		return _.trim(val)
	})
    
	return jexl
}

exports.unique = function(list) {
	var result = []
	list.forEach(function(e) {
		if (!result.includes(e)) {
			result.push(e)
		}
	})
	return result
}

exports.update_topic_for_expression = function(topic) {
	if ( _.isNil(topic) ) { 
		return 'empty_topic' 
	}
        
	topic = topic.toString()
    
	topic = topic.replace(/(\/)(?=\w+)/g, '_')
	topic = topic.replace(/\b[-,+]\w+/g, '_')

	return topic
}

const replaceSpecialTokens = function(topic, expression, context) {
	if (_.isNil(context)) {
		logging.debug('no context for expression: ' + expression)
		return expression
	}

	var newExpression = expression
	
	if ( !_.isNil(context) && !_.isNil(context['TRIGGER_TOPIC']) ) {
		newExpression = newExpression.replace(/\$TRIGGER_TOPIC/g, exports.update_topic_for_expression(context['TRIGGER_TOPIC']))
	}

	if ( !_.isNil(context) && !_.isNil(context['TRIGGER_TIME_UNIX']) ) {
		newExpression = newExpression.replace(/\$TRIGGER_TIME_UNIX/g, exports.update_topic_for_expression(context['TRIGGER_TIME_UNIX']))
	}

	if ( !_.isNil(context) && !_.isNil(context['TRIGGER_TIME_STRING']) ) {
		newExpression = newExpression.replace(/\$TRIGGER_TIME_STRING/g, exports.update_topic_for_expression(context['TRIGGER_TIME_STRING']))
	}

	if ( !_.isNil(context) && !_.isNil(context['TRIGGER_STRING']) ) {
		newExpression = newExpression.replace(/\$TRIGGER_STRING/g, context['TRIGGER_STRING'])
	}

	return newExpression
}

exports.prepareExpression = function(topic, expression, context) {
	logging.debug('context for expression: ' + JSON.stringify(context))
	if (_.isNil(context)) {
		logging.debug('no context for expression: ' + expression)
		return expression
	}

	const variables = Object.keys(context).sort(function(a, b) {
		// ASC  -> a.length - b.length
		// DESC -> b.length - a.length
		return b.length - a.length
	})
	var newExpression = replaceSpecialTokens(topic, expression, context)

	variables.forEach(function(variable) {
		const value = context[variable]
		if (variable.length == 1) { 
			return
		}
		const numberValue = Number(value)
		if (_.isNumber(numberValue) && numberValue == value) {
			newExpression = newExpression.replace(variable, value)
		}
	})

	return newExpression
}

exports.convertToNumberIfNeeded = function(value) {
	const numberValue = Number(value)
	if (!_.isNil(numberValue) && numberValue == value) {
		//logging.debug('converting string: ' + value + ' to number: ' + numberValue)
		return numberValue
	}

	return value
}

exports.isValueAnExpression = function(value) {
	if ( _.isNil(value) ) { 
		return false 
	}

	return (value.includes('/') || value.includes('?') || value.includes('+') || value.includes('-') || value.includes('*') || value.includes('$') || value.includes('|') )
}

exports.getCurrentTimeZone = function() {
	var TIMEZONE = process.env.TIMEZONE

	if (_.isNil(TIMEZONE)) {
		TIMEZONE = process.env.TZ
	}

	if (_.isNil(TIMEZONE)) {
		TIMEZONE = moment.tz.guess()
	}

	if (_.isNil(TIMEZONE)) {
		TIMEZONE = 'UTC'
	}

	return TIMEZONE
}

const isFloat = function(n){
	return Number(n) === n && n % 1 !== 0
}

exports.resolveValueOrExpression = function(rule_name, topic, context, valueOrExpression, options){
	var quiet = false

	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	return new Promise(function(resolve, reject){
		if (exports.isValueAnExpression(valueOrExpression)) {
			const publishExpression = exports.prepareExpression(topic, exports.update_topic_for_expression(valueOrExpression), context)

			if ( publishExpression[0] == '/') {
				resolve(replaceSpecialTokens(topic, valueOrExpression, context))
				return
			}

			var jexl = exports.jexl()
			const startTime = new Date()
			if ( !quiet ) { 
				logging.debug('  start evaluating expression for =>(' + rule_name + ')', {
					action: 'expression-evaluation-start',
					start_time: (startTime.getTime()),
					rule_name: rule_name,
					expression: publishExpression,
					topic: topic,
					value: valueOrExpression
				}) 
			}

			jexl.eval(publishExpression, context,
				function(publishError, publishResult) {
					const evaluation_time = ((new Date().getTime()) - startTime.getTime())
					if ( isFloat(publishResult) ) {
						publishResult = publishResult.toFixed(2)
					}

					if ( !quiet ) { 
						if ( publishResult ) {
							logging.info('  => done evaluating: ' + rule_name + '  result: ' + publishResult + '  value: ' + valueOrExpression)
						} else {
							logging.info('  => done evaluating: ' + rule_name + '  result: ' + publishResult)
						}
						logging.debug('  done evaluating expression for =>(' + rule_name + ')', {
							action: 'expression-evaluation-done',
							evaluation_time: evaluation_time,
							rule_name: rule_name,
							expression: publishExpression,
							// context: context,
							result: publishResult,
							topic: topic,
							error: publishError,
							value: valueOrExpression
						}) 
					}
                    
					metrics.submit('jexl_evaluation_time', evaluation_time)
					resolve(publishResult)
				})
		} else {
			resolve(valueOrExpression)
		}
	})
}
