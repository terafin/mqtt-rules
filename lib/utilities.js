const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')

exports.unique = function(list) {
    var result = []
    list.forEach(function(e) {
        if (!result.includes(e))
            result.push(e)
    })
    return result
}

exports.update_topic_for_expression = function(topic) {
    if ( _.isNil(topic) )
        return 'empty_topic'
        
    topic = topic.toString()
    
    topic = topic.replace(/(\/)(?=\w+)/g, '_')
    topic = topic.replace(/\b[-,+]\w+/g, '_')

    return topic
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
    var newExpression = expression

    const triggerTopic = null
    if ( !_.isNil(context) && !_.isNil(context['TRIGGER_TOPIC']) ) {
        newExpression = newExpression.replace(/\$TRIGGER_TOPIC/g, exports.update_topic_for_expression(context['TRIGGER_TOPIC']))
    }
    variables.forEach(function(variable) {
        const value = context[variable]
        if (variable.length == 1) return
        const numberValue = Number(value)
        if (_.isNumber(numberValue) && numberValue == value) {
            newExpression = newExpression.replace(variable, value)
        } else {
            //logging.debug('value is not a number: ' + value)
        }
    }, this)

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
    return (value.includes('/') || value.includes('?') || value.includes('+') || value.includes('-') || value.includes('*') || value.includes('$') )
}

exports.getCurrentTimeZone = function() {
    var TIMEZONE = process.env.TIMEZONE

    if (_.isNil(TIMEZONE)) {
        TIMEZONE = process.env.TZ
    }

    if (_.isNil(TIMEZONE)) {
        const moment = require('moment-timezone')
        TIMEZONE = moment.tz.guess()
    }

    if (_.isNil(TIMEZONE)) {
        TIMEZONE = 'UTC'
    }

    return TIMEZONE
}