const _ = require('lodash')
const moment = require('moment-timezone')
const logging = require('../homeautomation-js-lib/logging.js')
var Jexl = require('jexl')
const Queue = require('bull')

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT

var TIMEZONE = process.env.TIMEZONE

if (_.isNil(TIMEZONE)) {
    TIMEZONE = process.env.TZ
}

if (_.isNil(TIMEZONE)) {
    TIMEZONE = 'UTC'
}

const utilities = require('./utilities.js')
const actions = require('./actions.js')

var evalQueues = {}

function evaluateProcessor(job, doneEvaluate) {
    const queue_time = job.data.queue_time
    const name = job.data.name
    const topic = job.data.topic
    const context = job.data.context_value
    const rule = job.data.rule
    const allowed_times = rule.allowed_times
    const startTime = new Date().getTime()

    var logResult = {
        action: 'rule-time-evaluation',
        rule_name: name,
        rule: rule,
        topic: topic,
        allowed_times: allowed_times,
        context: context
    }
    var isOKTime = true

    logging.verbose(' evaluation queue: ' + name, {
        action: 'evaluate-process-start',
        rule_name: name,
        queue_time: (startTime - queue_time)
    })
    const currentDate = moment(new Date()).tz(TIMEZONE)

    if (!_.isNil(allowed_times)) {
        isOKTime = false

        allowed_times.forEach(function(timeRange) {
            if (isOKTime)
                return
            const split = timeRange.split('-')
            logging.debug(' time range from: ' + split[0] + '   to: ' + split[1])

            const startDate = moment(new Date())
            const endDate = moment(new Date())

            const startHours = split[0].split(':')[0]
            const startMinutes = split[0].split(':')[1]

            const endHours = split[1].split(':')[0]
            const endMinutes = split[1].split(':')[1]

            startDate.hours(Number(startHours))
            startDate.minutes(Number(startMinutes))
            endDate.hours(Number(endHours))
            endDate.minutes(Number(endMinutes))
            const result = currentDate.isBetween(startDate.tz(TIMEZONE), endDate.tz(TIMEZONE))
            if (result == true) {
                isOKTime = true
            }


            logging.info('good time: ' + isOKTime)
            logging.info('     current date: ' + currentDate.format('MMMM Do YYYY, h:mm:ss a'))
            logging.info('   startDate date: ' + startDate.tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a'))
            logging.info('     endDate date: ' + endDate.tz(TIMEZONE).format('MMMM Do YYYY, h:mm:ss a'))



        }, this)
    }

    if (!isOKTime) {
        logging.info('not evaluating, bad time (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ')  =>(' + name + ')', logResult)
        logging.debug('eval queue: ' + name + '    end - not a good time')
        logging.verbose(' evaluation queue: ' + name, {
            action: 'evaluate-process-done',
            rule_name: name,
            queue_time: ((new Date().getTime()) - startTime)
        })

        if (!_.isNil(doneEvaluate))
            doneEvaluate()

        return
    }
    logging.info('evaluating, good time  (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ') =>(' + name + ')', logResult)

    if (!_.isNil(rule.rules) && !_.isNil(rule.rules.expression)) {
        const expression = utilities.prepareExpression(topic, utilities.update_topic_for_expression(rule.rules.expression), context)
        var jexl = new Jexl.Jexl()
        const beginTime = new Date()
        jexl.eval(expression, context, function(error, result) {
            logging.info('  =>(' + name + ') evaluated expression', Object.assign(logResult, {
                action: 'evaluated-expression',
                result: result,
                evaluation_time: ((new Date().getTime()) - beginTime.getTime()),
                error: error
            }))
            actions.performAction(result, context, name, rule, logResult)
            logging.debug('eval queue: ' + name + '    end expression')
        })
    } else {
        logging.info('  =>(' + name + ') skipped evaluated expression', Object.assign(logResult, {
            action: 'no-expression-to-evaluate'
        }))
        actions.performAction(true, context, name, rule, logResult)
        logging.debug('eval queue: ' + name + '    end expression - no expression')
    }

    logging.verbose(' evaluation queue: ' + name, {
        action: 'evaluate-process-done',
        rule_name: name,
        queue_time: ((new Date().getTime()) - startTime)
    })
    if (!_.isNil(doneEvaluate))
        doneEvaluate()
}

exports.evalulateValue = function(topic, in_context, name, rule) {
    var queueName = name + '_eval'
    var evalQueue = evalQueues[queueName]

    if (!_.isNil(evalQueue)) {
        evalQueue.empty()
    }

    actions.clearQueue(name)
    const customQueueName = rule.queue

    var evaluateAfter = rule.evaluate_after
    if (_.isNil(evaluateAfter)) {
        evaluateAfter = 0
    }

    if (!_.isNil(customQueueName)) {
        queueName = customQueueName
    }

    evalQueue = Queue(queueName, redisPort, redisHost)
    evalQueues[queueName] = evalQueue

    evalQueue.process(evaluateProcessor)

    var job = {
        rule: rule,
        name: '' + name,
        topic: topic,
        queue_time: (new Date().getTime()),
        context_value: {}
    }

    Object.keys(in_context).forEach(function(key) {
        job.context_value[key] = '' + in_context[key]
    }, this)


    if (evaluateAfter > 0)
        logging.info('enqueued expression evaluation =>(' + name + ')    for: ' + evaluateAfter)

    logging.verbose('enqueued expression evaluation =>(' + queueName + ')', {
        action: 'enqueued-evaluation',
        delay: evaluateAfter,
        rule_name: name,
        rule: rule,
        queue_name: queueName
    })

    if (evaluateAfter === 0) {
        job.data = job
        evaluateProcessor(job, null)
    } else {
        evalQueue.add(job, {
            removeOnComplete: true,
            removeOnFail: true,
            delay: (evaluateAfter * 1000), // milliseconds
        })
    }
}


exports.clearQueues = function() {
    Object.keys(evalQueues).forEach(function(element) {
        var evalQueue = evalQueues[element]
        if (!_.isNil(evalQueue)) {
            evalQueue.empty()
        }

    }, this)

    actions.clearQueues()
}