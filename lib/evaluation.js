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
    if (utilities.testMode()) {
        return true
    }

    var isOKTime = false

    allowedTimes.forEach(function(timeRange) {
        if (isOKTime) {
            return
        }
        const range = utilities.parseTimeRange(timeRange)
        if (!_.isNil(range)) {
            const result = range.now.isBetween(range.start, range.end)
            if (result == true) {
                isOKTime = true
            }
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
    const reason = job.data.reason
    const rule = job.data.rule
    const options = rule.options

    // NOTE: need to test minimum time between...
    const minimum_time_between_runs = rule.minimum_time_between_runs
    var rule_actions = rule.actions
    const conditional_actions = !_.isNil(rule_actions) ? rule_actions.if : null
    const during = rule.during
    const allowed_times = rule.allowed_times
    const startTime = new Date().getTime()
    var quiet = false

    if (!_.isNil(options) && !_.isNil(options.quiet)) {
        quiet = options.quiet
    }

    var logResult = {
        action: 'rule-time-evaluation',
        rule_name: name,
        rule: rule,
        topic: topic,
        during: during,
        allowed_times: allowed_times
    }
    var isOKTime = true

    if (!quiet) {
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

    // Note to self, how should during & allowed_times interact?
    if (!_.isNil(during)) {
        isOKTime = isGoodTime(during)
    }

    if (context['SCHEDULED_EVENT'] == true) {
        logging.debug('good time, given it is a scheduled event')
        isOKTime = true
    }

    if (!_.isNil(minimum_time_between_runs)) {
        var last_time = global.timeLastRuleRun(name) * 1000
        logging.debug('   rule: ' + name)
        logging.debug('   *        last run: ' + last_time)
        logging.debug('   *     time needed: ' + minimum_time_between_runs)
        logging.debug('   *     currentDate: ' + currentDate)
        logging.debug('   *      difference: ' + (currentDate - last_time))
        if (_.isNil(last_time)) {
            last_time = 0
        }

        if (last_time > 0) {
            const difference = (currentDate - last_time) / 1000

            if (difference < minimum_time_between_runs) {
                logging.debug('   * too soon: ' + difference)
                isOKTime = false
            } else {
                logging.debug('   * OK to run: ' + difference)
            }
        }
    }

    if (!isOKTime) {
        if (!quiet && !utilities.testMode()) {
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

    if (!quiet && !utilities.testMode()) {
        logging.info('evaluating: ' + name + '   (' + currentDate.format('MMMM Do YYYY, h:mm:ss a') + ')' + '  topic: ' + topic + '  reason: ' + reason)
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

    if (!_.isNil(rule.when)) {
        const expressionHandler = function(expressionString, callback) {
            utilities.resolveValueOrExpression(name, topic, context, expressionString, options).then(result => {
                actions.performAction(result, context, name, rule, logResult, job.data)
                if (!quiet && !utilities.testMode()) {
                    logging.debug('eval queue: ' + name + '    end expression')
                }
            })

            if (!_.isNil(callback)) {
                return callback()
            }
        }

        if (!_.isNil(rule.when.if)) {
            async.each(rule.when.if, expressionHandler)
        } else {
            expressionHandler(rule.when, null)
        }
    } else {
        if (!quiet && !utilities.testMode()) {
            logging.debug('  =>(' + name + ') skipped evaluated expression, no expression to evaluate (no rule)')
        }

        actions.performAction(true, context, name, rule, logResult, job.data)

        if (!quiet && !utilities.testMode()) {
            logging.debug('eval queue: ' + name + '    end expression - no expression/rules')
        }
    }

    const evaluation_queue_time = ((new Date().getTime()) - startTime)

    if (!quiet && !utilities.testMode()) {
        logging.debug(' evaluation queue: ' + name + ' data:' + JSON.stringify({
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

exports.evalulateValue = function(topic, in_context, name, rule, isScheduledJob, otherwiseEvent, reason) {
    var queueName = name
    const options = rule.options
    const customQueueName = rule.queue
    var evaluateAfter = rule.evaluate_after
    var quiet = false

    if (utilities.testMode() && evaluateAfter > 0) {
        evaluateAfter = 0
    }

    if (utilities.testMode() && !_.isNil(evaluateAfter)) {
        evaluateAfter = 0
    }

    if (!_.isNil(options) && !_.isNil(options.quiet)) {
        quiet = options.quiet
    }

    if (isScheduledJob) {
        evaluateAfter = 0
    }

    if (!_.isNil(customQueueName)) {
        queueName = customQueueName
    }

    var job = {
        rule: rule,
        options: options,
        reason: reason,
        name: '' + name,
        topic: topic,
        queue_time: (new Date().getTime()),
        context_value: {}
    }

    Object.keys(in_context).forEach(function(key) {
        job.context_value[key] = '' + in_context[key]
    }, this)

    job.context_value['TRIGGER_RULE'] = name
    job.context_value['TRIGGER_STRING'] = topic
    job.context_value['TRIGGER_TIME_UNIX'] = moment(new Date()).tz(TIMEZONE).unix()
    job.context_value['TRIGGER_TIME_STRING'] = moment(new Date()).tz(TIMEZONE).toDate()

    if (isScheduledJob) {
        job.context_value['SCHEDULED_EVENT'] = true
    } else {
        job.context_value['SCHEDULED_EVENT'] = false
    }

    if (otherwiseEvent) {
        job.context_value['OTHERWISE_EVENT'] = true
    } else {
        job.context_value['OTHERWISE_EVENT'] = false
    }

    if (!_.isNil(topic)) {
        job.context_value['TRIGGER_TOPIC'] = topic

        var topicComponents = topic.split('/')
        if (topicComponents[0] == '') {
            topicComponents.shift()
        }

        job.context_value['TRIGGER_COMPONENTS'] = topicComponents
    }
    if (evaluateAfter > 0) {
        if (!quiet && !utilities.testMode()) {
            logging.info('enqueued expression evaluation =>(' + name + ')    for: ' + evaluateAfter)
        }
    }

    if (!quiet && !utilities.testMode()) {
        logging.debug('enqueued expression evaluation =>(' + queueName + ')' + 'data:' + JSON.stringify({
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