/* eslint-disable no-unused-vars */
// Standard Test Includes

const utilities = require('../../lib/utilities.js')
const _ = require('lodash')
const mocha = require('mocha')
const logging = require('homeautomation-js-lib/logging.js')
const describe = mocha.describe
const before = mocha.before
const it = mocha.it

// End Standard Test Includes

const schedule = require('../../lib/scheduled-jobs.js')
const moment = require('moment-timezone')
const TIMEZONE = utilities.getCurrentTimeZone()

const msInASecond = 1000


describe('Schedule Tests', function() {
    var testStartTime = null
    var now = null
    var nowString = null
    var nowComponents = null
    var hours = null
    var minutes = null
    var seconds = null

    beforeEach(function() {
        // runs before all tests in this block
        global.clearQueues()
        testStartTime = moment(new Date()).tz(TIMEZONE)
        now = moment(testStartTime)
        nowString = now.format('HH:mm:ss')
        nowComponents = nowString.split(':')
        hours = Number(nowComponents[0])
        minutes = Number(nowComponents[1])
        seconds = Number(nowComponents[2])
    })

    it('Current Date', function(done) {
        if (!_.isNil(testStartTime)) {
            done()
        } else {
            logging.error('Current time: ' + testStartTime)
            done(-1)
        }
    })

    it('Schedule in 3s', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        const scheduledJob = schedule.scheduleJob('3s_from_now', '3s_from_now.job', moment(testStartTime).add(3, 'seconds').toDate(), null, function() {
            schedule.cancelJob(scheduledJob)
            done()
        })

        if (_.isNil(scheduledJob)) {
            logging.error('Job failed to schedule')
            done(-1)
        }
    })

    it('Schedule every 3s', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        const scheduledJob = schedule.scheduleJob('every_3s', 'every_3s.job', '*/3 * * * * *', null, function() {
            schedule.cancelJob(scheduledJob)
            done()
        })

        if (_.isNil(scheduledJob)) {
            logging.error('Job failed to schedule')
            done(-1)
        }
    })


    it('Schedule time string for 3s from now with seconds', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        seconds = seconds + 3

        const scheduleString = [hours, minutes, seconds].join(':')
        const scheduleDate = utilities.parseTime(scheduleString)

        const scheduledJob = schedule.scheduleJob('in_3_seconds', 'in_3_seconds.job', moment(scheduleDate).toDate(), null, function() {
            schedule.cancelJob(scheduledJob)
            done()
        })

        if (_.isNil(scheduledJob)) {
            logging.error('Job failed to schedule')
            done(-1)
        }
    })

    it('During parsing - both in future', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        seconds = seconds + 3
        const startString = [hours, minutes, seconds].join(':')

        seconds = seconds + 3
        const endString = [hours, minutes, seconds].join(':')


        const duringString = [startString, endString].join(',')
        const jobs = schedule.processDuring(duringString, 1, 'during_test', null)

        if (jobs.length == 2) {
            jobs.forEach(job => {
                schedule.cancelJob(job)
            })
            done()
        } else {
            done(-1)
        }
    })

    it('During parsing - start in past', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        seconds = seconds - 10
        const startString = [hours, minutes, seconds].join(':')

        seconds = seconds + 13
        const endString = [hours, minutes, seconds].join(':')


        const duringString = [startString, endString].join(',')
        const jobs = schedule.processDuring(duringString, 1, 'during_test', null)

        if (jobs.length == 1) {
            jobs.forEach(job => {
                schedule.cancelJob(job)
            })
            done()
        } else {
            done(-1)
        }
    })

    it('During parsing - both in past', function(done) {
        this.slow(Number(4 * msInASecond))
        this.timeout(Number(5 * msInASecond))

        seconds = seconds - 20
        const startString = [hours, minutes, seconds].join(':')

        seconds = seconds + 10
        const endString = [hours, minutes, seconds].join(':')


        const duringString = [startString, endString].join(',')
        const jobs = schedule.processDuring(duringString, 1, 'during_test', null)

        if (jobs.length == 0) {
            done()
        } else {
            done(-1)
        }
    })
})