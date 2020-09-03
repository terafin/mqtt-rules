const express = require('express')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const utilities = require('./utilities.js')
const moment = require('moment-timezone')
const TIMEZONE = utilities.getCurrentTimeZone()
const loader = require('./loading.js')

var rules = null
const port = process.env.API_PORT

const formatResult = function(string) {
    if (_.isNil(string)) {
        return ''
    }

    return string
}

if (!_.isNil(port)) {
    // Express
    const app = express()

    app.use(function(req, res, next) {
        res.header('Access-Control-Allow-Origin', '*')
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
        next()
    })

    app.get('/reload/', function(req, res) {
        loader.reload()
        res.send('OK')
    })

    app.get('/json/', function(req, res) {
        if (_.isNil(rules)) {
            res.send('[]')
            return
        }

        res.send(JSON.stringify(rules.get_configs()))
    })

    app.get('/history-json/', function(req, res) {
        const history = global.getRuleHistory()
        if (_.isNil(history)) {
            res.send('[]')
            return
        }

        res.send(JSON.stringify(history))
    })

    app.get('/history/', function(req, res) {
        const history = global.getRuleHistory()
        if (_.isNil(history)) {
            res.send('[]')
            return
        }

        var historyHTML = ''

        historyHTML += '<!DOCTYPE html>'
        historyHTML += '<html>'
        historyHTML += '<head>'
        historyHTML += '<style>'
        historyHTML += 'table {'
        historyHTML += '	font-family: arial, sans-serif;'
        historyHTML += '	border-collapse: collapse;'
        historyHTML += '	width: 100%;'
        historyHTML += '  }'
        historyHTML += '  '
        historyHTML += '  td, th {'
        historyHTML += '	border: 1px solid #dddddd;'
        historyHTML += '	text-align: left;'
        historyHTML += '	padding: 8px;'
        historyHTML += '  }'
        historyHTML += '  '
        historyHTML += '  tr:nth-child(even) {'
        historyHTML += '	background-color: #dddddd;'
        historyHTML += '  }'
        historyHTML += '</style>'
        historyHTML += '</head>'
        historyHTML += '<body>'


        // "date": 1550355690,
        // "rule_name": "climate_venstar_venstar_home_away_mode",
        // "expression": "",
        // "valueOrExpression": "(/presence/home/elene > 0) ? 'auto' : 'off'",
        // "result": true,
        // "topic": "/environment/thermostat/study/mode/set",
        // "message": "off",
        // "options": {
        // 	"retain": false,
        // 	"qos": 2
        // }

        historyHTML += '<table style="width:100%">'
        historyHTML += '  <tr>'
        historyHTML += '    <th>Action Date</th>'
        historyHTML += '    <th>Rule</th> '
        historyHTML += '    <th>Trigger</th> '
        historyHTML += '    <th>Message</th> '
        historyHTML += '    <th>Trigger Date</th>'
        historyHTML += '    <th>Expression</th>'
        historyHTML += '    <th>Value or Expression</th>'
        historyHTML += '    <th>Result</th>'
        historyHTML += '    <th>Topic</th>'
        historyHTML += '    <th>Message</th>'
        historyHTML += '    <th>Options</th>'
        historyHTML += '  </tr>'

        history.forEach(item => {
            const color = item.result ? 'black' : 'gray'
            historyHTML += '  <tr>'
            historyHTML += '    <th style="color:' + color + '">' + moment.unix(item.date).tz(TIMEZONE).format('DD.MM.YY-HH:mm:ss') + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + item.rule_name + '</th> '
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.evaluate_job_data.reason) + '</th> '
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.evaluate_job_data.context_value[utilities.update_topic_for_expression(item.evaluate_job_data.topic)]) + '</th> '
            historyHTML += '    <th style="color:' + color + '">' + moment.unix(item.evaluate_job_data.context_value.TRIGGER_TIME_UNIX).tz(TIMEZONE).format('DD.MM.YY-HH:mm:ss') + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.evaluate_job_data.rule.when) + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.valueOrExpression) + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.result) + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.topic) + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(item.message) + '</th>'
            historyHTML += '    <th style="color:' + color + '">' + formatResult(JSON.stringify(item.options)) + '</th>'
            historyHTML += '  </tr>'

        })
        historyHTML += '</table>'

        historyHTML += '</body>'
        historyHTML += '</html>'

        res.send(historyHTML)
    })

    app.listen(port, function() {
        logging.info('Rules API listening on port: ' + port)
    })

    exports.updateRules = function(newRules) {
        rules = newRules
    }
}