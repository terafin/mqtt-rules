var Jexl = require('jexl')
var async = require('async')
const _ = require('lodash')

const utilities = require('./utilities.js')
const notifications = require('./notifications.js')
const queue = require('./queue.js')
const logging = require('../homeautomation-js-lib/logging.js')

var actionProcessor = function(context, rule_name, valueOrExpression, topic, callback) { // ISOLATED
    logging.debug('evaluating for publish: ' + topic + '  value: ' + valueOrExpression, context)

    if (utilities.isValueAnExpression(valueOrExpression)) {
        const publishExpression = utilities.prepareExpression(topic, utilities.update_topic_for_expression(valueOrExpression), context)
        var jexl = new Jexl.Jexl()
        const startTime = new Date()
        logging.verbose('  start evaluating publish expression for =>(' + rule_name + ')', {
            action: 'publish-expression-evaluation-start',
            start_time: (startTime.getTime()),
            rule_name: rule_name,
            expression: publishExpression,
            topic: topic,
            value: valueOrExpression
        })
        jexl.eval(publishExpression, context,
            function(publishError, publishResult) {
                logging.verbose('  done evaluating publish expression for =>(' + rule_name + ')', {
                    action: 'publish-expression-evaluation-done',
                    evaluation_time: ((new Date().getTime()) - startTime.getTime()),
                    rule_name: rule_name,
                    expression: publishExpression,
                    context: context,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })

                global.publish(rule_name, publishExpression, valueOrExpression, topic, '' + publishResult)
                logging.verbose(' published result', {
                    action: 'published-value',
                    rule_name: rule_name,
                    expression: publishExpression,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })

            })
    } else {
        logging.info(' published result', {
            action: 'published-value',
            rule_name: rule_name,
            topic: topic,
            value: valueOrExpression
        })
        global.client.publish(topic, '' + valueOrExpression)
    }


    callback()
}

function jobProcessor(job, doneAction) {
    const queueTime = job.data.queue_time
    const actions = job.data.actions
    const notify = job.data.notify
    const name = job.data.rule_name
    const context = job.data.context
        // const message = job.data.message
        // const topic = job.data.topic
        // const expression = job.data.expression
    const startTime = new Date().getTime()
    logging.debug('action queue: ' + name + '    begin')
    logging.verbose(' action queue: ' + name, {
        action: 'job-process-start',
        rule_name: name,
        actions: actions,
        queue_time: (startTime - queueTime)
    })

    if (!_.isNil(actions)) // name, context
        async.eachOf(actions, actionProcessor.bind(undefined, context, name))

    if (!_.isNil(notify)) {
        if (!_.isNil(notify.if)) {
            logging.debug(' checking notification evaluation')
            async.eachOf(notify.if, notifications.notificationProcessor.bind(undefined, context, name))
        } else {
            logging.debug(' directly notifying')
            notifications.handleNotification(name, notify)
        }
    }

    logging.debug('action queue: ' + name + '    end')

    if (!_.isNil(doneAction))
        doneAction()

    logging.verbose(' processing done: ' + name, {
        action: 'job-process-done',
        rule_name: name,
        processing_time: ((new Date().getTime()) - startTime)
    })
}

exports.performAction = function(eval_result, context, name, rule, logResult) {
    if (eval_result === true) {
        const actions = rule.actions
        const notify = rule.notify
        var delayed_actions = rule.delayed_actions
        const delayed_actions_delay = _.isNil(delayed_actions) ? -1 : delayed_actions['delay']

        var perform_after = rule.perform_after

        if (_.isNil(perform_after)) {
            perform_after = 0
        }

        if (perform_after > 0)
            logging.info('enqueued action =>(' + name + ')    for: ' + perform_after)

        logging.verbose('enqueued action =>(' + name + ')', Object.assign(logResult, {
            action: 'enqueued-action',
            delay: perform_after,
            actions: actions,
            delayed_actions: delayed_actions,
            notify: notify,
            queue_name: name
        }))

        const data = {
            rule_name: name,
            notify: notify,
            actions: actions,
            queue_time: (new Date().getTime()),
            context: context
        }
        queue.enqueue('actions', name, jobProcessor, data, perform_after, true, logResult)

        if (delayed_actions_delay > 0) {
            var delayed_data = {
                rule_name: name,
                notify: notify,
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