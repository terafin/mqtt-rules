const express = require('express')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')

require('homeautomation-js-lib/devices.js')

var rules = null
const port = process.env.API_PORT

if (!_.isNil(port)) {
	// Express
	const app = express()

	app.use(function (req, res, next) {
		console.log('incoming request: ' + req)
		res.header('Access-Control-Allow-Origin', '*')
		res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
		next()
	})

	app.get('/json/', function (req, res) {
		if (_.isNil(rules)) {
			res.send('[]')
			return
		}

		res.send(JSON.stringify(rules.get_configs()))
	})

	app.listen(port, function () {
		logging.info('Rules API listening on port: ', port)
	})


	exports.updateRules = function (newRules) {
		rules = newRules
	}

}