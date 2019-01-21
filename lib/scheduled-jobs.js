const schedule = require('node-schedule-tz')
const SunCalc = require('suncalc')

const moment = require('moment-timezone')
const _ = require('lodash')

const solarLat = process.env.LOCATION_LAT
const solarLong = process.env.LOCATION_LONG

const utilities = require('./utilities.js')
const evaluation = require('./evaluation.js')
const logging = require('homeautomation-js-lib/logging.js')
const rules = require('./loading.js')
const TIMEZONE = utilities.getCurrentTimeZone()

var scheduled_jobs = []

const doSchedule = function(rule_name, jobName, cronSchedule, rule) {
	const options = rule.options
	var quiet = false

	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	if ( !quiet && !global.isTestMode() ) { 
		logging.debug('scheduling rule: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' timezone: ' + TIMEZONE + ' rule: ' + JSON.stringify(rule)) 
	}
	var newJob = schedule.scheduleJob(rule_name, cronSchedule, TIMEZONE, function() {
		if ( !quiet && !global.isTestMode() ) {
			logging.debug('scheduled rule fired: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' rule: ' + JSON.stringify(rule))
			logging.debug('job fired'  + 'data:' + JSON.stringify({
				action: 'scheduled-job-fired',
				schedule: cronSchedule,
				job: jobName,
				rule_name: rule_name,
				rule: rule
			}))
			logging.info('* scheduled job fired' + rule_name + ' (schedule: ' + cronSchedule + ')')
		}

		const scheduleAction = function(err, context) {
			evaluation.evalulateValue(
				null,
				context,
				rule_name,
				rule,
				true,
				'scheduled rule: ' + rule_name)
		}

		global.generateContext(null, null, function(outTopic, outMessage, context) {
			scheduleAction(null, context)
		})
	}.bind(null, rule))

	if (!_.isNil(newJob)) {
		if ( !quiet && !global.isTestMode() ) { 
			logging.info('scheduled ' + rule_name + ' - ' + cronSchedule)
			logging.debug('job scheduled ' + 'data:' + JSON.stringify({
				action: 'job-scheduled',
				schedule: cronSchedule,
				job: jobName,
				rule_name: rule_name,
				rule: rule

			}))
		}

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
			})
		}

		if (!_.isNil(daily)) {

			Object.keys(daily).forEach(function(daily_key) {
				var now = moment(new Date()).tz(TIMEZONE).toDate()
				// console.log('   new date:' + new Date())
				// console.log('   now date:' + now)
				var times = SunCalc.getTimes(now, Number(solarLat), Number(solarLong))

				var jobKey = rule_name + '.daily.' + daily_key
				const dailyValue = daily[daily_key]
				var offset = 0
				if (!_.isNil(dailyValue)) {
					if (_.isNil(dailyValue.offset)) {
						offset = 0 
					} else {
						offset = Number(dailyValue.offset)
					}
				}

				var date = null

				if (daily_key === 'sunrise') {
					date = times.sunrise
				} else if (daily_key === 'sunset') {
					date = times.sunset
				} else if (daily_key === 'civilDawn') {
					date = times.dawn
				} else if (daily_key === 'nauticalDawn') {
					date = times.nauticalDawn
				} else if (daily_key === 'astronomicalDawn') {
					date = times.nightEnd
				} else if (daily_key === 'civilDusk') {
					date = times.dusk
				} else if (daily_key === 'nauticalDusk') {
					date = times.nauticalDusk
				} else if (daily_key === 'astronomicalDusk') {
					date = times.night
				} else if (daily_key === 'solarNoon') {
					date = times.solarNoon
				}

				// console.log('  made date:' + date)

				logging.debug(jobKey + ' offset: ' + offset)
				if (!_.isNil(date)) {
					var newDate = moment(date).add(offset, 'minutes')
					// console.log('     => offset date:' + newDate)
					// console.log('     => offset date + tz:' + newDate.tz(TIMEZONE).toDate())
					doSchedule(rule_name, jobKey, newDate.tz(TIMEZONE).toDate(), rule)
				}

			})
		}
	})
}

var dailyJob = null

const scheduleDailyJobs = function() {
	if (!_.isNil(dailyJob)) {
		return
	}

	logging.info('Scheduling Daily Job', {
		action: 'schedule-daily-job'
	})

	dailyJob = schedule.scheduleJob('00 00 00 * * * ', function() {
		logging.info('Daily job fired ', {
			action: 'scheduled-daily-job'
		})

		exports.scheduleJobs()
	})
}
