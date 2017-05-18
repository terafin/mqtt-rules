const _ = require('lodash')

exports.unique = function(list) {
    var result = []
    list.forEach(function(e) {
        if (!result.includes(e))
            result.push(e)
    })
    return result
}

exports.update_topic_for_expression = function(topic) {
    topic = topic.replace(/(\/)(?=\w+)/g, '_')
    topic = topic.replace(/[-,+]\w+/g, '_')

    return topic
}

exports.prepareExpression = function(topic, expression, context) {
    if (_.isNil(context)) return expression

    const variables = Object.keys(context).sort(function(a, b) {
        // ASC  -> a.length - b.length
        // DESC -> b.length - a.length
        return b.length - a.length
    })
    var newExpression = expression

    variables.forEach(function(variable) {
        const value = context[variable]
        if (variable.length == 1) return

        if (_.isNumber(value)) {
            newExpression = newExpression.replace(variable, value)
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
    return (value.includes('/') || value.includes('?') || value.includes('+'))
}