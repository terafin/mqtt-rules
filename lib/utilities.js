const _ = require('lodash')
var Jexl = require('jexl')
const logging = require('homeautomation-js-lib/logging.js')
const metrics = require('homeautomation-js-lib/stats.js')
const moment = require('moment-timezone')
const feels = require('feels')

String.prototype.replaceAll = function(searchStr, replaceStr) {
	var str = this

	// no match exists in string?
	if(str.indexOf(searchStr) === -1) {
		// return string
		return str.toString()
	}

	// replace and remove first match, and do another recursirve search/replace
	return (str.replace(searchStr, replaceStr)).toString().replaceAll(searchStr, replaceStr).toString()
}

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
    
	jexl.addTransform('isNaN', function(val) {
		logging.info('is nan value: ' + val)
		return _.isNil(val) || val.toString().length == 0 || isNaN(val)
	})
    
	jexl.addTransform('camelCase', function(val) {
		return _.camelCase(val)
	})
    
	jexl.addTransform('startCase', function(val) {
		return _.startCase(val)
	})
	
	jexl.addTransform('feelsLikeAAT_C', function(temperature, humidity) {
		const config = {
			temp: Number(temperature),
			humidity: Number(humidity),
			units: {
				temp: 'c'
			}
		}

		let feelsLike
		try {
			feelsLike = new feels(config).like(['AAT'])
		} catch(err) {
			logging.error('err: ' + err)
		}
		
		return feelsLike
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

const replaceVariable = function(expression, variable, context, stringify) {
	if (_.isNil(context)) { 
		return expression 
	}

	const dollar_variable = '$' + variable
	var value = context[variable]

	if ( _.isNil(value) ) { 
		return expression 
	}

	if ( stringify ) { 
		value = "'" + value + "'" 
	} else {
		value = exports.update_topic_for_expression(value)
	}
	return expression.replaceAll(dollar_variable, value).toString()
}

const replaceSpecialTokens = function(topic, expression, context) {
	if (_.isNil(context)) {
		logging.debug('no context for expression: ' + expression)
		return expression
	}

	var newExpression = expression

	newExpression = replaceVariable(newExpression, 'TRIGGER_TOPIC', context)
	newExpression = replaceVariable(newExpression, 'TRIGGER_TIME_UNIX', context)
	newExpression = replaceVariable(newExpression, 'TRIGGER_TIME_STRING', context)
	newExpression = replaceVariable(newExpression, 'TRIGGER_STRING', context, true)
	newExpression = replaceVariable(newExpression, 'TRIGGER_RULE', context)

	if ( expression != newExpression ) {
		logging.debug('expression update from: ' + expression + '    to: ' + newExpression)
		return newExpression
	}

	return expression
}

exports.prepareExpression = function(topic, expression, context) {
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

	var log = false
	// if ( newExpression.includes('/bathroom/motion')) {
	// 	log = true
	// }
	if ( log ) { 
		logging.info('variables: ' + variables) 
	}

	variables.forEach(function(variable) {
		var value = context[variable]

		if ( log ) { 
			logging.info('   => ' + variable + ':' + value) 
		}

		if (variable.length == 1) { 
			return
		}

		if ( value == 'undefined' ) {
			value = 0
		}

		const numberValue = Number(value)

		if (!_.isNumber(value) && (numberValue != value)) {
			value = '\'' + value + '\''
		}

		if ( log ) { 
			logging.info('    pre: ' + newExpression) 
		}

		newExpression = newExpression.replaceAll(variable, value)

		if ( log ) { 
			logging.info('   post: ' + newExpression) 
		}
	})

	return newExpression
}

exports.convertToNumberIfNeeded = function(value) {
	const numberValue = Number(value)
	if (!_.isNil(numberValue) && numberValue == value) {
		//logging.debug('converting string: ' + value + ' to number: ' + numberValue)
		if ( isFloat(numberValue) ) {
			return Number(numberValue.toFixed(2))
		}

		return numberValue
	}

	return value
}

exports.isValueAnExpression = function(value) {
	if ( _.isNil(value) ) { 
		return false
	}

	value = value.toString()
	
	return (value.includes('/') || value.includes('?') || value.includes('+') || value.includes('-') || value.includes('*') || value.includes('$') || value.includes('|')  || value.includes('>')  || value.includes('<')  || value.includes('=') )
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
			if ( !quiet && !global.isTestMode() ) { 
				logging.debug('  start evaluating expression for =>(' + rule_name + ')' + '  context: ' + JSON.stringify({
					action: 'expression-evaluation-start',
					start_time: (startTime.getTime()),
					rule_name: rule_name,
					expression: publishExpression,
					topic: topic,
					value: valueOrExpression
				}))
			}

			jexl.eval(publishExpression, context).then(function(publishResult) {
				const evaluation_time = ((new Date().getTime()) - startTime.getTime())
				if ( isFloat(publishResult) ) {
					publishResult = Number(publishResult.toFixed(2))
				}

				if ( !quiet && !global.isTestMode() ) { 
					logging.info('  => done evaluating: ' + rule_name + '  result: ' + publishResult + '  value: ' + valueOrExpression)
						
					logging.debug('  done evaluating expression for =>(' + rule_name + ')   context' +  JSON.stringify({
						action: 'expression-evaluation-done',
						evaluation_time: evaluation_time,
						rule_name: rule_name,
						expression: publishExpression,
						// context: context,
						result: publishResult,
						topic: topic,
						value: valueOrExpression
					}))
				}
                    
				metrics.submit('jexl_evaluation_time', evaluation_time)
				resolve(publishResult)
			}).catch((catchError) => {
				logging.error(' *** Caught error while evaluating (' + rule_name + '): ' + catchError)
			})
		} else {
			resolve(valueOrExpression)
		}
	})
}
