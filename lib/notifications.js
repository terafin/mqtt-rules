const _ = require('lodash')
const pushover = require('pushover-notifications')
const utilities = require('./utilities.js')
const logging = require('homeautomation-js-lib/logging.js')
var Jexl = require('jexl')

exports.handleNotification = function(name, notify_config) {
    const baseAppToken = process.env.PUSHOVER_APP_TOKEN
    const baseUserToken = process.env.PUSHOVER_USER_TOKEN
    var p = new pushover({
        user: (notify_config.user ? notify_config.user : baseUserToken),
        token: (notify_config.token ? notify_config.token : baseAppToken)
    })


    if (_.isNil(notify_config.message)) {
        logging.warn(' Empty notification message', notify_config)
        return
    }

    var msg = {
        // These values correspond to the parameters detailed on https://pushover.net/api
        // 'message' is required. All other values are optional.
        message: notify_config.message,
        title: notify_config.title,
        sound: notify_config.sound,
        device: notify_config.device,
        priority: notify_config.priority,
        url: notify_config.url,
        url_title: notify_config.url_title,
    }

    p.send(msg, function(err, result) {
        var json = notify_config
        json.action = 'notify'
        json.result = result
        json.rule_name = name
        if (!_.isNil(err)) {
            json.error = err
            logging.error(' failed notification', json)
        } else {
            logging.info(' successfully notified', json)
        }
    })
}

exports.notificationProcessor = function(options, context, rule_name, notify_config, notify_name, callback) { // ISOLATED
    logging.info('evaluating for notify: ' + notify_name + '  notify_config: ' + notify_config)
    var expression = notify_config.expression
    const publishExpression = utilities.prepareExpression(null, utilities.update_topic_for_expression(expression), context)
    var jexl = new Jexl.Jexl()
    const startTime = new Date()

    logging.info('  start evaluating publish expression for =>(' + rule_name + ')', {
        action: 'publish-notification-evaluation-start',
        start_time: (startTime.getTime()),
        rule_name: rule_name,
        expression: publishExpression
    })

    jexl.eval(publishExpression, context,
        function(publishError, publishResult) {
            logging.info('  done evaluating publish expression for =>(' + rule_name + ')', {
                action: 'publish-notification-evaluation-done',
                evaluation_time: ((new Date().getTime()) - startTime.getTime()),
                rule_name: rule_name,
                expression: publishExpression,
                context: context,
                result: publishResult,
                error: publishError
            })

            if (publishResult == true) {
                exports.handleNotification(rule_name, notify_config)
            }
        })

    callback()
}