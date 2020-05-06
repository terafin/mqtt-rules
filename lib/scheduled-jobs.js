const schedule = require('node-schedule-tz')
const moment = require('moment-timezone')
const _ = require('lodash')
const utilities = require('./utilities.js')
const evaluation = require('./evaluation.js')
const logging = require('homeautomation-js-lib/logging.js')
const rules = require('./loading.js')
const TIMEZONE = utilities.getCurrentTimeZone()

var scheduled_jobs = []


const doSchedule = function(rule_name, jobName, date, rule, otherwise, inAction) {
    var quiet = false

    if (!utilities.testMode()) {
        logging.info('scheduling rule: ' + rule_name + '  job: ' + jobName + '  schedule: ' + utilities.logDate(date) + ' timezone: ' + TIMEZONE + '   otherwise: ' + otherwise)
    }
    var newJob = schedule.scheduleJob(jobName, date, TIMEZONE, function() {
        if (!quiet && !utilities.testMode()) {
            logging.info('scheduled rule fired: ' + rule_name + '  job: ' + jobName + '  schedule: ' + date + ' rule: ' + JSON.stringify(rule))
            logging.debug('job fired' + 'data:' + JSON.stringify({
                action: 'scheduled-job-fired',
                schedule: date,
                job: jobName,
                rule_name: rule_name,
                rule: rule
            }))
            logging.debug('* scheduled job fired: ' + rule_name + ' (schedule: ' + utilities.logDate(date) + ')')
        }

        if (_.isNil(inAction)) {
            inAction = function() {
                const scheduleAction = function(context) {
                    evaluation.evalulateValue(
                        null,
                        context,
                        rule_name,
                        rule,
                        true,
                        otherwise,
                        'scheduled rule: ' + rule_name + ' job: ' + jobName)
                }

                global.generateContext(null, null, function(outTopic, outMessage, context) {
                    scheduleAction(context)
                })
            }
        }

        inAction()

    }.bind(null, rule))

    if (!_.isNil(newJob)) {
        if (!quiet && !utilities.testMode()) {
            logging.info(' => scheduled ' + jobName + ' - ' + utilities.logDate(date) + ' job: ' + JSON.stringify(newJob))
            logging.debug('job scheduled ' + 'data:' + JSON.stringify({
                action: 'job-scheduled',
                schedule: date,
                job: jobName,
                rule_name: rule_name,
                rule: rule

            }))
        }

        scheduled_jobs.push(newJob)
    } else {
        logging.error('failed to schedule job name: ' + jobName + '   job: ' + newJob + '   date: ' + date + '   tz: ' + TIMEZONE)
        process.exit(1)
    }

    return newJob
}

exports.scheduleJob = function(rule_name, jobName, scheduleString, rule, callback) {
    return doSchedule(rule_name, jobName, scheduleString, rule, false, callback)
}

exports.cancelJob = function(job) {
    return schedule.cancelJob(job)
}


exports.processAtTime = function(at, rule_name, rule) {
    var jobs = []

    const TIMEZONE = utilities.getCurrentTimeZone()
    const now = moment(new Date()).tz(TIMEZONE)

    var atIndex = 0
    at.forEach(atString => {
        const time = utilities.parseTime(atString)
        if (!_.isNil(time)) {
            var jobKey = rule_name + '.at.' + atIndex
            atIndex = atIndex + 1

            if (time > now) { // Don't schedule at if we're already passed it
                const job = doSchedule(rule_name, jobKey, time.toDate(), rule, false)
                if (!_.isNil(job)) {
                    jobs.push(job)
                }
            }
        }
    })

    return jobs
}

exports.processDuring = function(duringString, duringIndex, rule_name, rule) {
    var jobs = []

    const timeRange = utilities.parseTimeRange(duringString)
    if (!_.isNil(timeRange)) {
        if (!utilities.testMode()) {
            logging.info(' => time range for: ' + rule_name + '  during: ' + duringString + ' now: ' + timeRange.now + '   time range: ' + timeRange.start + ',' + timeRange.end + '   formatted time range: ' + moment(timeRange.start).format('HH:mm:ss') + ',' + moment(timeRange.end).format('HH:mm:ss'))
        }
        var jobKey = rule_name + '.during.' + duringIndex
        var jobResult = null

        logging.debug('timeRange.start: ' + timeRange.start)
        logging.debug('timeRange.end: ' + timeRange.end)

        if (timeRange.end > timeRange.now) { // Don't schedule start if we're already passed it

            if (timeRange.start < timeRange.now) {
                logging.info('  => * rule time start passed, not scheduling')
                    // jobResult = doSchedule(rule_name, jobKey + '.start', moment(timeRange.now).add(15, 'seconds').toDate(), rule, false)
                    // if (!_.isNil(jobResult)) {
                    //     jobs.push(jobResult)
                    // }
            } else {
                logging.debug('  => * rule time has not passed, scheduling at the time its supposed to')
                jobResult = doSchedule(rule_name, jobKey + '.start', moment(timeRange.start).add(100, 'ms').toDate(), rule, false)
                if (!_.isNil(jobResult)) {
                    jobs.push(jobResult)
                }
            }
        }
        if (timeRange.end < timeRange.now) {
            logging.info('  => * rule time end passed, not scheduling')
                // logging.debug('rule time passed, scheduling now + 15')
                // jobResult = doSchedule(rule_name, jobKey + '.end', moment(timeRange.now).add(20, 'seconds').toDate(), rule, false)
                // if (!_.isNil(jobResult)) {
                //     jobs.push(jobResult)
                // }
        } else {
            logging.debug('  => * rule time has not passed, scheduling at the time its supposed to')
            jobResult = doSchedule(rule_name, jobKey + '.end', moment(timeRange.end).add(100, 'ms').toDate(), rule, true)
            if (!_.isNil(jobResult)) {
                jobs.push(jobResult)
            }
        }
    } else {
        logging.error('bad time range: ' + duringString)
    }

    return jobs
}

exports.scheduleJobs = function() {
    logging.info('scheduling jobs ', {
        action: 'schedule-jobs'
    })

    scheduleDailyJobs()

    scheduled_jobs.forEach(function(job) {
        job.cancel()
    }, this)

    rules.ruleIterator(function(rule_name, rule) {
        const during = rule.during
        if (!_.isNil(during)) {
            var duringIndex = 0
            during.forEach(duringString => {
                duringIndex = duringIndex + 1
                exports.processDuring(duringString, duringIndex, rule_name, rule)
            })
        }

        const at = rule.at
        if (!_.isNil(at)) {
            exports.processAtTime(at, rule_name, rule)
        }

        const cronString = rule.cron
        if (!_.isNil(cronString)) {
            Object.keys(cronString).forEach(function(schedule_key) {
                var jobKey = rule_name + '.cron.' + schedule_key
                const cronSchedule = cronString[schedule_key]
                logging.debug(jobKey + ' = ' + cronSchedule)

                doSchedule(rule_name, jobKey, cronSchedule, rule, false)
            })
        }
    })
}

var dailyJob = null

const scheduleDailyJobs = function() {
    if (!_.isNil(dailyJob)) {
        return
    }

    logging.info('Scheduling Daily Job (timezone: ' + TIMEZONE + ')', {
        action: 'schedule-daily-job'
    })

    dailyJob = schedule.scheduleJob('daily', '00 00 00 * * * ', TIMEZONE, function() {
        logging.info('Daily job fired ', {
            action: 'scheduled-daily-job'
        })

        // Delay this 250ms given the first set of sunset calculations seem to weirdly sometimes work from the previous day
        setTimeout(exports.scheduleJobs, 250)
    })
}