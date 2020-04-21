const schedule = require('node-schedule-tz')
const moment = require('moment-timezone')
const _ = require('lodash')
const utilities = require('./utilities.js')
const evaluation = require('./evaluation.js')
const logging = require('homeautomation-js-lib/logging.js')
const rules = require('./loading.js')
const TIMEZONE = utilities.getCurrentTimeZone()

var scheduled_jobs = []

const doSchedule = function(rule_name, jobName, date, rule, otherwise) {
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
}

exports.scheduleJob = function(rule_name, jobName, scheduleString, rule) {
    doSchedule(rule_name, jobName, scheduleString, rule, false)
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
                const timeRange = utilities.parseTimeRange(duringString)
                if (!_.isNil(timeRange)) {
                    var jobKey = rule_name + '.during.' + duringIndex
                    duringIndex = duringIndex + 1

                    if (timeRange.end > timeRange.now) { // Don't schedule start if we're already passed it

                        if (timeRange.start < timeRange.now) {
                            logging.debug('rule time passed, scheduling now + 15')
                            doSchedule(rule_name, jobKey + '.start', moment(timeRange.now).add(15, 'seconds').toDate(), rule, false)
                        } else {
                            logging.debug('rule time has not passed, scheduling at the time its supposed to')
                            doSchedule(rule_name, jobKey + '.start', moment(timeRange.start).add(100, 'ms').toDate(), rule, false)
                        }
                    }
                    if (timeRange.end < timeRange.now) {
                        logging.debug('rule time passed, scheduling now + 15')
                        doSchedule(rule_name, jobKey + '.end', moment(timeRange.now).add(20, 'seconds').toDate(), rule, false)
                    } else {
                        logging.debug('rule time has not passed, scheduling at the time its supposed to')
                        doSchedule(rule_name, jobKey + '.end', moment(timeRange.end).add(100, 'ms').toDate(), rule, false)
                    }
                }
            })
        }

        const at = rule.at
        if (!_.isNil(at)) {
            const TIMEZONE = utilities.getCurrentTimeZone()
            const now = moment(new Date()).tz(TIMEZONE)
            var atIndex = 0
            at.forEach(atString => {
                const time = utilities.parseTime(atString)
                if (!_.isNil(time)) {
                    var jobKey = rule_name + '.at.' + atIndex
                    atIndex = atIndex + 1

                    if (time > now) { // Don't schedule at if we're already passed it
                        doSchedule(rule_name, jobKey, time.toDate(), rule, false)
                    }
                }
            })
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