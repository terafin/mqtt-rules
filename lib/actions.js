var async = require('async')
const _ = require('lodash')

const utilities = require('./utilities.js')
const notifications = require('./notifications.js')
const queue = require('./queue.js')
const logging = require('homeautomation-js-lib/logging.js')

const handleWebActions = function(web) {
    if (_.isNil(web)) {
        return
    }
    logging.debug('handleWebActions: ' + JSON.stringify(web))

    const getRequests = web.get

    if (!_.isNil(getRequests)) {
        // Format is name: url

        Object.keys(getRequests).forEach(urlName => {
            const urlString = getRequests[urlName]

            if (_.isNil(urlString)) {
                return
            }

            if (utilities.testMode()) {
                return
            }

            // logging.info('Handling get request: ' + urlName + '   url: ' + urlString)

            // request.get({ url: urlString },
            //     function(err, httpResponse, body) {
            //         if (!_.isNil(err)) {
            //             logging.error('_get url:' + urlString)
            //             logging.error('error:' + err)
            //             logging.error('httpResponse:' + httpResponse)
            //             logging.error('body:' + body)
            //         }
            //     })
        })
    }
}

const actionProcessor = function(evaluate_job_data, options, inContext, rule_name, valueOrExpression, topic, callback) { // ISOLATED
    var quiet = false
    var context = {}

    if (topic == 'if') {
        return
    }

    Object.keys(inContext).forEach(key => {
        context[key] = utilities.convertToNumberIfNeeded(inContext[key])
    })
    if (!_.isNil(options) && !_.isNil(options.quiet)) {
        quiet = options.quiet
    }

    if (!quiet && !utilities.testMode()) {
        logging.debug('evaluating for publish: ' + topic + '  value: ' + valueOrExpression + '  context: ' + JSON.stringify(context) + '  options: ' + options)
    }

    utilities.resolveValueOrExpression(rule_name, topic, context, valueOrExpression, options).then(resultString => {
        if (!quiet && !utilities.testMode()) {
            logging.info(' => publishing rule: ' + rule_name + '   topic: ' + topic + '   value: ' + resultString)

            logging.debug(' published result' + 'data:' + JSON.stringify({
                action: 'published-value',
                rule_name: rule_name,
                topic: topic,
                value: resultString
            }))
        }

        global.publish(rule_name, '', valueOrExpression.unescapedString(), topic, '' + resultString, options, evaluate_job_data)
    })

    callback()
}

const jobProcessor = function(job, doneAction) {
    const queueTime = job.data.queue_time
    const notify = job.data.notify
    const web = job.data.web
    const name = job.data.rule_name
    const evaluate_job_data = job.data.evaluate_job_data
    const options = job.data.options
    const context = job.data.context
    var actions = job.data.actions
    const startTime = new Date().getTime()

    logging.debug('action queue: ' + name + ' begin context: ' + JSON.stringify({
        action: 'job-process-start',
        rule_name: name,
        actions: actions,
        evaluate_job_data: evaluate_job_data,
        data: job.data,
        queue_time: (startTime - queueTime)
    }))

    if (!_.isNil(actions)) { // name, context
        async.eachOf(actions, actionProcessor.bind(undefined, evaluate_job_data, options, context, name))
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

    logging.debug(' processing done: ' + name + 'data:' + JSON.stringify({
        action: 'job-process-done',
        rule_name: name,
        processing_time: ((new Date().getTime()) - startTime)
    }))
}

exports.performAction = function(eval_result, context, name, rule, logResult, evaluateJobData) {
    var useOtherwise = false
    var isOtherwiseEvent = context['OTHERWISE_EVENT']

    if (eval_result === false && !_.isNil(rule.otherwise)) {
        useOtherwise = true
        logging.info('  eval failed but using otherwise result for => (' + name + ')')
    }

    if (eval_result === true || useOtherwise === true) {
        var actions = (isOtherwiseEvent || useOtherwise) ? rule.otherwise : rule.actions
        const web = rule.web
        const options = rule.options
        const notify = rule.notify
        var delayed_actions = rule.delayed_actions
        var delayed_actions_delay = _.isNil(delayed_actions) ? -1 : delayed_actions['delay']

        if (utilities.testMode() && delayed_actions > -1) {
            delayed_actions_delay = 1
        }

        var quiet = false

        if (!_.isNil(options) && !_.isNil(options.quiet)) {
            quiet = options.quiet
        }

        var perform_after = rule.perform_after

        if (_.isNil(perform_after)) {
            perform_after = 0
        } else if (utilities.testMode()) {
            perform_after = 1
        }

        if (perform_after > 0) {
            if (!quiet && !utilities.testMode()) {
                logging.info('enqueued delayed perform action =>(' + name + ')    for: ' + perform_after)
            }
        } else {
            if (!quiet && !utilities.testMode()) {
                logging.debug('enqueued instantaneous action =>(' + name + ')' + ' data:' + JSON.stringify(Object.assign(logResult, {
                    action: 'enqueued-action',
                    delay: perform_after,
                    actions: actions,
                    web: web,
                    delayed_actions: delayed_actions,
                    notify: notify,
                    queue_name: name
                })))
            }
        }

        const data = {
            rule_name: name,
            options: options,
            notify: notify,
            web: web,
            rule: rule,
            actions: actions,
            queue_time: (new Date().getTime()),
            evaluate_job_data: evaluateJobData,
            context: context
        }
        queue.enqueue('actions', name, jobProcessor, data, perform_after * 1000, true, logResult)

        if (delayed_actions_delay > 0) {
            var delayed_data = {
                rule_name: name,
                options: options,
                notify: notify,
                web: web,
                rule: rule,
                actions: delayed_actions.actions,
                queue_time: (new Date().getTime()),
                evaluate_job_data: evaluateJobData,
                context: context
            }
            delete delayed_data['delay']

            queue.enqueue('actions', name, jobProcessor, delayed_data, delayed_actions_delay * 1000, false, logResult)
        }
    } else {
        global.addRuleToHistory(name, rule.when, null, null, null, rule.options, evaluateJobData, false)
    }
}

exports.clearQueue = function(name) {
    queue.clearQueue('actions', name)
}

exports.clearQueues = function() {
    queue.clearQueues('actions')
}