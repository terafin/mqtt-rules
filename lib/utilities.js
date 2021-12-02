const _ = require('lodash')
var Jexl = require('jexl')
const logging = require('homeautomation-js-lib/logging.js')
const metrics = require('homeautomation-js-lib/stats.js')
const moment = require('moment-timezone')
const feels = require('feels')

const SunCalc = require('suncalc')

const solarLat = process.env.LOCATION_LAT
const solarLong = process.env.LOCATION_LONG

var dontPublish = process.env.DONT_PUBLISH

if (dontPublish == 'true') {
    dontPublish = true
} else if (dontPublish != true) {
    dontPublish = false
}

var is_test_mode = process.env.TEST_MODE

if (is_test_mode == 'true') {
    is_test_mode = true
} else if (is_test_mode != true) {
    is_test_mode = false
}


exports.dontPublish = function() {
    return dontPublish
}

exports.testMode = function() {
    return is_test_mode
}


String.prototype.replaceAll = function(searchStr, replaceStr) {
    var str = this

    // no match exists in string?
    if (str.indexOf(searchStr) === -1) {
        // return string
        return str.toString()
    }

    // replace and remove first match, and do another recursirve search/replace
    return (str.replace(searchStr, replaceStr)).toString().replaceAll(searchStr, replaceStr).toString()
}

String.prototype.unescapedString = function() {
    var str = this

    // no match exists in string?
    if (str.indexOf('\\') === -1) {
        // return string
        return str.toString()
    }


    return str.toString().replaceAll('\\', '')
}



String.prototype.hasUnescapedString = function(searchStr) {
    var str = this.unescapedString()

    var startAt = 0

    startAt = str.indexOf(searchStr)

    while (startAt != -1) {
        if (startAt > 0) {
            if (str.charAt(startAt - 1) == '\\') {
                startAt = str.indexOf(searchStr, startAt + 1)
                continue
            }
        }

        return true
    }

    return false
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
        } catch (err) {
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
    if (_.isNil(topic)) {
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

    if (_.isNil(value)) {
        return expression
    }

    if (stringify) {
        value = "'" + value + "'"
    } else {
        value = exports.update_topic_for_expression(value)
    }
    return expression.replaceAll(dollar_variable, value).toString()
}

const replaceSpecialTokens = function(expression, context) {
    var newExpression = expression

    newExpression = newExpression.replaceAll('$CURRENT_TIME_UNIX', moment(new Date()).tz(exports.getCurrentTimeZone()).unix())

    if (!_.isNil(context)) {
        newExpression = replaceVariable(newExpression, 'TRIGGER_TOPIC', context)
        newExpression = replaceVariable(newExpression, 'TRIGGER_TIME_UNIX', context)
        newExpression = replaceVariable(newExpression, 'TRIGGER_TIME_STRING', context)
        newExpression = replaceVariable(newExpression, 'TRIGGER_STRING', context, true)
        newExpression = replaceVariable(newExpression, 'TRIGGER_RULE', context)
    }
    // Just for clarity, we'll support the $ syntax, but jexl doesn't want it
    newExpression = newExpression.replaceAll('$TRIGGER_COMPONENTS', 'TRIGGER_COMPONENTS')

    if (expression != newExpression) {
        logging.debug('expression update from: ' + expression + '    to: ' + newExpression)
        return newExpression
    }

    return expression
}

exports.prepareExpression = function(expression, context) {
    const variables = []

    if (!_.isNil(context)) {
        Object.keys(context).sort(function(a, b) {
            // ASC  -> a.length - b.length
            // DESC -> b.length - a.length
            return b.length - a.length
        })
    }
    var newExpression = replaceSpecialTokens(expression, context)

    variables.forEach(function(variable) {
        var value = context[variable]

        // Don't process this one, we want it to stay and be handled by context
        if (variable == 'TRIGGER_COMPONENTS') {
            return
        }

        if (variable.length == 1) {
            return
        }

        if (value == 'undefined') {
            value = 0
        }

        const numberValue = Number(value)

        if (!_.isNumber(value) && (numberValue != value)) {
            value = '\'' + value + '\''
        }

        newExpression = newExpression.replaceAll(variable, value)
    })

    return newExpression
}

exports.convertToNumberIfNeeded = function(value) {
    const numberValue = Number(value)
    if (!_.isNil(numberValue) && numberValue == value) {
        //logging.debug('converting string: ' + value + ' to number: ' + numberValue)
        if (isFloat(numberValue)) {
            return Number(numberValue.toFixed(2))
        }

        return numberValue
    }

    return value
}

exports.isValueAnExpression = function(value) {
    if (_.isNil(value)) {
        return false
    }

    return (value.hasUnescapedString('/') ||
        value.hasUnescapedString('?') ||
        value.hasUnescapedString('+') ||
        value.hasUnescapedString('-') ||
        value.hasUnescapedString('*') ||
        value.hasUnescapedString('$') ||
        value.hasUnescapedString('|') ||
        value.hasUnescapedString('>') ||
        value.hasUnescapedString('<') ||
        value.hasUnescapedString('='))
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

const isFloat = function(n) {
    return Number(n) === n && n % 1 !== 0
}

exports.resolveValueOrExpression = function(rule_name, topic, context, valueOrExpression, options) {
    var quiet = false

    if (!_.isNil(options) && !_.isNil(options.quiet)) {
        quiet = options.quiet
    }

    // eslint-disable-next-line no-unused-vars
    return new Promise(function(resolve, reject) {
        if (exports.isValueAnExpression(valueOrExpression)) {
            const publishExpression = exports.prepareExpression(exports.update_topic_for_expression(valueOrExpression), context)

            if (publishExpression[0] == '/') {
                resolve(replaceSpecialTokens(valueOrExpression, context))
                return
            }

            var jexl = exports.jexl()
            const startTime = new Date()
            if (!quiet && !exports.testMode()) {
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
                if (isFloat(publishResult)) {
                    publishResult = Number(publishResult.toFixed(2))
                }

                if (!quiet && !exports.testMode()) {
                    logging.info('  => done evaluating: ' + rule_name + '  result: ' + publishResult + '  value: ' + valueOrExpression)

                    logging.debug('  done evaluating expression for =>(' + rule_name + ')   context' + JSON.stringify({
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

exports.nowMoment = function() {
    const TIMEZONE = exports.getCurrentTimeZone()
    return moment(new Date()).tz(TIMEZONE)
}

exports.parseTime = function(timeString) {
    if (_.isNil(timeString)) {
        return null
    }
    var result = exports.nowMoment()

    if (timeString.includes(':')) {
        const components = timeString.split(':')
        const hours = components[0]
        const minutes = components[1]
        var seconds = Number(0)

        if (components.length > 2) {
            seconds = components[2]
        }

        result.hours(Number(hours))
        result.minutes(Number(minutes))
        result.seconds(Number(seconds))
        result.milliseconds(Number(0))

    } else {
        const nowMoment = exports.nowMoment()
        var now = nowMoment.add(10, 'minutes').toDate()
        var times = SunCalc.getTimes(now, Number(solarLat), Number(solarLong))
        var timeKey = timeString
        var offset = Number(0)
        var date = null

        if (timeString.includes('+')) {
            timeKey = timeString.split('+')[0]
            offset = Number(timeString.split('+')[1])
        } else if (timeString.includes('-')) {
            timeKey = timeString.split('-')[0]
            offset = -1 * Number(timeString.split('-')[1])
        }

        if (timeKey === 'sunrise') {
            date = times.sunrise
        } else if (timeKey === 'sunset') {
            date = times.sunset
        } else if (timeKey === 'civilDawn') {
            date = times.dawn
        } else if (timeKey === 'nauticalDawn') {
            date = times.nauticalDawn
        } else if (timeKey === 'astronomicalDawn') {
            date = times.nightEnd
        } else if (timeKey === 'civilDusk') {
            date = times.dusk
        } else if (timeKey === 'nauticalDusk') {
            date = times.nauticalDusk
        } else if (timeKey === 'astronomicalDusk') {
            date = times.night
        } else if (timeKey === 'solarNoon') {
            date = times.solarNoon
        } else {
            return null
        }

        result = moment(date).add(offset, 'minutes')

        result.year(nowMoment.year())
        result.month(nowMoment.month())
        result.date(nowMoment.date())
        result.seconds(Number(0))
        result.milliseconds(Number(0))
    }

    return result
}


exports.parseTimeRange = function(rangeString) {
    if (_.isNil(rangeString)) {
        return null
    }

    const split = rangeString.split(',')
    const startDate = exports.parseTime(split[0])
    const endDate = exports.parseTime(split[1])

    var timeRange = {}
    timeRange.now = exports.nowMoment()
    timeRange.start = startDate
    timeRange.end = endDate

    return timeRange
}


exports.hasRecentlyStarted = function() {
    const now = moment(new Date()).tz(exports.getCurrentTimeZone()).toDate()


    const difference = (now.getTime() - startupTime.getTime()) / 1000
    return difference < STARTUP_TIME
}

const STARTUP_TIME = 30
const startupTime = moment(new Date()).tz(exports.getCurrentTimeZone()).toDate()

exports.logDate = function(date) {
    if (_.isString(date)) {
        return date
    }
    return date.toLocaleTimeString('en-US', {
        year: 'numeric',
        day: 'numeric',
        month: 'numeric',
        timeZoneName: 'short',
        timeZone: exports.getCurrentTimeZone()
    })
}