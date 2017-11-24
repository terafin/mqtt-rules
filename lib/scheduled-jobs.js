const schedule = require('node-schedule-tz')
const SolarCalc = require('solar-calc')
const moment = require('moment-timezone')
const _ = require('lodash')

const solarLat = process.env.LOCATION_LAT
const solarLong = process.env.LOCATION_LONG

const utilities = require('./utilities.js')
const evaluation = require('./evaluation.js')
const logging = require('../homeautomation-js-lib/logging.js')
const rules = require('../homeautomation-js-lib/rules.js')
const TIMEZONE = utilities.getCurrentTimeZone()

var scheduled_jobs = []

function doSchedule(rule_name, jobName, cronSchedule, rule) {
    console.log('scheduling rule: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' timezone: ' + TIMEZONE + ' rule: ' + JSON.stringify(rule))
    var newJob = schedule.scheduleJob(rule_name, cronSchedule, TIMEZONE, function(rule_value) {
        console.log('scheduled rule fired: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' rule: ' + JSON.stringify(rule))
        logging.info('job fired ', {
            action: 'scheduled-job-fired',
            schedule: cronSchedule,
            job: jobName,
            rule_name: rule_name,
            rule: rule,
            rule_value: rule_value
        })

        global.redis.mget(global.devices_to_monitor, function(err, values) {
            var context = {}

            for (var index = 0; index < global.devices_to_monitor.length; index++) {
                const key = global.devices_to_monitor[index]
                const value = values[index]
                const newKey = utilities.update_topic_for_expression(key)
                context[newKey] = utilities.convertToNumberIfNeeded(value)
            }

            logging.info('evaluating ', {
                action: 'scheduled-job-evaluate',
                rule_name: rule_name,
                rule: rule,
                context: context
            })

            evaluation.evalulateValue(
                null,
                context,
                rule_name,
                rule)
        })
    }.bind(null, rule))
    console.log('job created: ' + newJob)

    if (!_.isNil(newJob)) {
        console.log('job scheduled: ' + newJob)
        logging.info('job scheduled ', {
            action: 'job-scheduled',
            schedule: cronSchedule,
            job: jobName,
            rule_name: rule_name,
            rule: rule

        })

        scheduled_jobs.push(newJob)
    }
}

exports.scheduleJob = function(rule_name, jobName, cronSchedule, rule) {
    doSchedule(rule_name, jobName, cronSchedule, rule)
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
        const schedule = rule.schedule
        const daily = rule.daily

        if (!_.isNil(schedule)) {
            Object.keys(schedule).forEach(function(schedule_key) {
                var jobKey = rule_name + '.schedule.' + schedule_key
                const cronSchedule = schedule[schedule_key]
                logging.debug(jobKey + ' = ' + cronSchedule)

                doSchedule(rule_name, jobKey, cronSchedule, rule)
            }, this)
        }

        if (!_.isNil(daily)) {

            Object.keys(daily).forEach(function(daily_key) {
                var now = moment(new Date()).tz(TIMEZONE).toDate()
                var solar = new SolarCalc(now, Number(solarLat), Number(solarLong))
                var jobKey = rule_name + '.daily.' + daily_key
                const dailyValue = daily[daily_key]
                var offset = 0
                if (!_.isNil(dailyValue)) {
                    if (_.isNil(dailyValue.offset))
                        offset = 0
                    else
                        offset = Number(dailyValue.offset)
                }

                var date = null

                if (daily_key === 'sunrise')
                    date = solar.sunrise
                else if (daily_key === 'sunset')
                    date = solar.sunset
                else if (daily_key === 'civilDawn')
                    date = solar.civilDawn
                else if (daily_key === 'nauticalDawn')
                    date = solar.nauticalDawn
                else if (daily_key === 'astronomicalDawn')
                    date = solar.astronomicalDawn
                else if (daily_key === 'civilDusk')
                    date = solar.civilDusk
                else if (daily_key === 'nauticalDusk')
                    date = solar.nauticalDusk
                else if (daily_key === 'astronomicalDusk')
                    date = solar.astronomicalDusk
                else if (daily_key === 'solarNoon')
                    date = solar.solarNoon


                logging.debug(jobKey + ' offset: ' + offset)
                if (!_.isNil(date)) {
                    var newDate = moment(date).add(offset, 'minutes')
                    doSchedule(rule_name, jobKey, newDate.toDate(), rule)
                }

            }, this)
        }
    })
}

var dailyJob = null

function scheduleDailyJobs() {
    if (!_.isNil(dailyJob))
        return

    logging.info('Scheduling Daily Job ', {
        action: 'schedule-daily-job'
    })

    dailyJob = schedule.scheduleJob('00 00 00 * * * ', function() {
        logging.info('Daily job fired ', {
            action: 'scheduled-daily-job'
        })

        exports.scheduleJobs()
    })
}