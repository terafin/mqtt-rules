// Standard Test Includes

const utilities = require('../../lib/utilities.js')
const _ = require('lodash')
const mocha = require('mocha')
const logging = require('homeautomation-js-lib/logging.js')
const describe = mocha.describe
const before = mocha.before
const it = mocha.it

// End Standard Test Includes

const moment = require('moment-timezone')
const TIMEZONE = utilities.getCurrentTimeZone()


describe('Date parsing', function() {
    beforeEach(function() {
        // runs before all tests in this block
        global.clearQueues()
    })

    it('Parse 9:30', function(done) {
        var result = moment(new Date()).tz(TIMEZONE)

        result.hours(Number(9))
        result.minutes(Number(32))
        result.seconds(Number(0))
        result.milliseconds(Number(0))

        var time = utilities.parseTime('09:32')
        if (time.toDate().getTime() == result.toDate().getTime()) {
            done()
        } else {
            logging.error('target time: ' + result + '   parsed time: ' + time)
            done('failed to parse')
        }
    })

    it('Parse 12:33', function(done) {
        var result = moment(new Date()).tz(TIMEZONE)

        result.hours(Number(12))
        result.minutes(Number(33))
        result.seconds(Number(0))
        result.milliseconds(Number(0))

        var time = utilities.parseTime('12:33')
        if (time.toDate().getTime() == result.toDate().getTime()) {
            done()
        } else {
            logging.error('target time: ' + result + '   parsed time: ' + time)
            done('failed to parse')
        }
    })
    it('Parse 23:44', function(done) {
        var result = moment(new Date()).tz(TIMEZONE)

        result.hours(Number(23))
        result.minutes(Number(44))
        result.seconds(Number(0))
        result.milliseconds(Number(0))

        var time = utilities.parseTime('23:44')
        if (time.toDate().getTime() == result.toDate().getTime()) {
            done()
        } else {
            logging.error('target time: ' + result + '   parsed time: ' + time)
            done('failed to parse')
        }
    })
    it('Parse 23:44:22', function(done) {
        var result = moment(new Date()).tz(TIMEZONE)

        result.hours(Number(23))
        result.minutes(Number(44))
        result.seconds(Number(22))
        result.milliseconds(Number(0))

        var time = utilities.parseTime('23:44:22')
        if (time.toDate().getTime() == result.toDate().getTime()) {
            done()
        } else {
            logging.error('target time: ' + result + '   parsed time: ' + time)
            done('failed to parse')
        }
    })
    it('Sunset offsets', function(done) {
        var sunset = utilities.parseTime('sunset').add(30, 'minutes')

        var offset = utilities.parseTime('sunset+30')
        if (sunset.toDate().getTime() == offset.toDate().getTime()) {
            done()
        } else {
            logging.error('target time: ' + sunset + '   parsed time: ' + offset)
            done('failed to parse')
        }
    })
})