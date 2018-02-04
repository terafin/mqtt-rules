var Jexl = require('jexl')
var async = require('async')
const _ = require('lodash')
const request = require('request')

const utilities = require('./utilities.js')
const notifications = require('./notifications.js')
const queue = require('./queue.js')
const logging = require('homeautomation-js-lib/logging.js')
const metrics = require('homeautomation-js-lib/stats.js')

function handleWebActions(web) {
    if ( _.isNil(web) ) {
        return
    }
    logging.debug('handleWebActions: ' + JSON.stringify(web))

    const getRequests = web.get

    if ( !_.isNil(getRequests) ) {
        // Format is name: url

        Object.keys(getRequests).forEach(urlName => {
            const urlString = getRequests[urlName]
            logging.info('should process get request: ' + urlName + '   url: ' + urlString)
            
            if ( _.isNil(urlString)) return

            request.get({ url: urlString },
            function(err, httpResponse, body) {
                logging.info('_get url:' + urlString)
                logging.info('error:' + err)
                logging.info('httpResponse:' + httpResponse)
                logging.info('body:' + body)
            })    
        })
    }
}

var actionProcessor = function(options, context, rule_name, valueOrExpression, topic, callback) { // ISOLATED
    logging.debug('evaluating for publish: ' + topic + '  value: ' + valueOrExpression, context, options)

    if (utilities.isValueAnExpression(valueOrExpression)) {
        const publishExpression = utilities.prepareExpression(topic, utilities.update_topic_for_expression(valueOrExpression), context)
        var jexl = new Jexl.Jexl()
        const startTime = new Date()
        logging.debug('  start evaluating publish expression for =>(' + rule_name + ')', {
            action: 'publish-expression-evaluation-start',
            start_time: (startTime.getTime()),
            rule_name: rule_name,
            expression: publishExpression,
            topic: topic,
            value: valueOrExpression
        })
        jexl.eval(publishExpression, context,
            function(publishError, publishResult) {
                const jexl_publish_evaluation_time = ((new Date().getTime()) - startTime.getTime())
                logging.debug('  done evaluating publish expression for =>(' + rule_name + ')', {
                    action: 'publish-expression-evaluation-done',
                    evaluation_time: jexl_publish_evaluation_time,
                    rule_name: rule_name,
                    expression: publishExpression,
                    context: context,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })
                
                global.publish(rule_name, publishExpression, valueOrExpression, topic, '' + publishResult, options)

                logging.debug(' published result', {
                    action: 'published-value',
                    rule_name: rule_name,
                    expression: publishExpression,
                    result: publishResult,
                    topic: topic,
                    error: publishError,
                    value: valueOrExpression
                })
                metrics.submit('jexl_publish_evaluation_time', jexl_publish_evaluation_time)
            })
    } else {
        logging.info(' published result', {
            action: 'published-value',
            rule_name: rule_name,
            topic: topic,
            value: valueOrExpression
        })

        global.publish(rule_name, '', valueOrExpression, topic, '' + valueOrExpression, options)
    }

    callback()
}

function jobProcessor(job, doneAction) {
    const queueTime = job.data.queue_time
    const actions = job.data.actions
    const notify = job.data.notify
    const web  = job.data.web
    const name = job.data.rule_name
    const options = job.data.options
    const context = job.data.context
    const startTime = new Date().getTime()

    logging.debug('action queue: ' + name + '    begin')
    logging.debug(' action queue: ' + name, {
        action: 'job-process-start',
        rule_name: name,
        actions: actions,
        queue_time: (startTime - queueTime)
    })

    if (!_.isNil(actions)) { // name, context
        async.eachOf(actions, actionProcessor.bind(undefined, options, context, name))
    }

    if (!_.isNil(notify)) {
        if (!_.isNil(notify.if)) {
            logging.info(' checking notification evaluation')
            async.eachOf(notify.if, notifications.notificationProcessor.bind(undefined, options, context, name))
        } else {
            logging.info(' directly notifying')
            notifications.handleNotification(name, notify)
        }
    } else {
        logging.debug(' nothing to notify about')
    }

    handleWebActions(web)

    logging.debug('action queue: ' + name + '    end')

    if (!_.isNil(doneAction)) { doneAction() }

    logging.debug(' processing done: ' + name, {
        action: 'job-process-done',
        rule_name: name,
        processing_time: ((new Date().getTime()) - startTime)
    })
}

exports.performAction = function(eval_result, context, name, rule, logResult) {
    if (eval_result === true) {
        const actions = rule.actions
        const web = rule.web
        const options = rule.options
        const notify = rule.notify
        var delayed_actions = rule.delayed_actions
        const delayed_actions_delay = _.isNil(delayed_actions) ? -1 : delayed_actions['delay']

        var perform_after = rule.perform_after

        if (_.isNil(perform_after)) {
            perform_after = 0
        }

        if (perform_after > 0) { logging.info('enqueued action =>(' + name + ')    for: ' + perform_after) }

        logging.info('enqueued action =>(' + name + ')', Object.assign(logResult, {
            action: 'enqueued-action',
            delay: perform_after,
            actions: actions,
            web: web,
            delayed_actions: delayed_actions,
            notify: notify,
            queue_name: name
        }))

        const data = {
            rule_name: name,
            options: options,
            notify: notify,
            web: web,
            actions: actions,
            queue_time: (new Date().getTime()),
            context: context
        }
        queue.enqueue('actions', name, jobProcessor, data, perform_after, true, logResult)

        if (delayed_actions_delay > 0) {
            var delayed_data = {
                rule_name: name,
                notify: notify,
                web: web,
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