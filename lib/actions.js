var Jexl = require('jexl')
var async = require('async')
const _ = require('lodash')
const Queue = require('bull')

const utilities = require('./utilities.js')
const notifications = require('./notifications.js')
const logging = require('../homeautomation-js-lib/logging.js')

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT

var actionQueues = {}

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
        const queueName = name + '_action'
        var actionQueue = actionQueues[queueName]
        if (!_.isNil(actionQueue)) {
            logging.verbose('cancelled existing action queue =>(' + queueName + ')', Object.assign(logResult, {
                queue_name: queueName
            }))

            actionQueue.empty()
        }

        actionQueue = Queue(queueName, redisPort, redisHost)
        actionQueues[queueName] = actionQueue

        actionQueue.process(jobProcessor)

        logging.info('enqueued action =>(' + queueName + ')    for: ' + perform_after)

        logging.verbose('enqueued action =>(' + queueName + ')', Object.assign(logResult, {
            action: 'enqueued-action',
            delay: perform_after,
            actions: actions,
            delayed_actions: delayed_actions,
            notify: notify,
            queue_name: queueName
        }))

        const data = {
            rule_name: name,
            notify: notify,
            actions: actions,
            queue_time: (new Date().getTime()),
            context: context
        }
        if (perform_after === 0) {
            var job = {}
            job.data = data
            jobProcessor(job, null)
        } else {
            actionQueue.add(data, {
                removeOnComplete: true,
                removeOnFail: true,
                delay: (perform_after * 1000), // milliseconds
            })
        }
        if (delayed_actions_delay > 0) {
            var delayed_data = {
                rule_name: name,
                notify: notify,
                actions: delayed_actions.actions,
                queue_time: (new Date().getTime()),
                context: context
            }
            delete delayed_data['delay']

            actionQueue.add(delayed_data, {
                removeOnComplete: true,
                removeOnFail: true,
                delay: (delayed_actions_delay * 1000), // milliseconds
            })
        }
    }
}

exports.clearQueue = function(name) {
    const actionQueueName = name + '_action'
    var actionQueue = actionQueues[actionQueueName]
    if (!_.isNil(actionQueue)) {
        actionQueue.empty()
    }
}

exports.clearQueues = function() {
    Object.keys(actionQueues).forEach(function(element) {
        var actionQueue = actionQueues[element]
        if (!_.isNil(actionQueue)) {
            actionQueue.empty()
        }

    }, this)
}