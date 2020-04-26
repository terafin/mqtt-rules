const utilities = require('../lib/utilities.js')

const TIMEZONE = utilities.getCurrentTimeZone()
const _ = require('lodash')

console.log('Running in timezone: ' + TIMEZONE)

process.env.TEST_MODE = true

require('./tests/date_parsing.js')
require('./tests/schedule_tests.js')
require('./tests/rule_tests.js')