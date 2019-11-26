const schedule = require('node-schedule-tz')
const moment = require('moment-timezone')
const _ = require('lodash')
const utilities = require('./utilities.js')
const evaluation = require('./evaluation.js')
const logging = require('homeautomation-js-lib/logging.js')
const rules = require('./loading.js')
const TIMEZONE = utilities.getCurrentTimeZone()

var scheduled_jobs = []

const doSchedule = function(rule_name, jobName, cronSchedule, rule, otherwise) {
	const options = rule.options
	var quiet = false

	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	if ( !quiet && !global.isTestMode() ) { 
		logging.info('scheduling rule: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' timezone: ' + TIMEZONE)
	}
	var newJob = schedule.scheduleJob(rule_name, cronSchedule, TIMEZONE, function() {
		if ( !quiet && !global.isTestMode() ) {
			logging.info('scheduled rule fired: ' + rule_name + '  job: ' + jobName + '  schedule: ' + cronSchedule + ' rule: ' + JSON.stringify(rule))
			logging.debug('job fired'  + 'data:' + JSON.stringify({
				action: 'scheduled-job-fired',
				schedule: cronSchedule,
				job: jobName,
				rule_name: rule_name,
				rule: rule
			}))
			logging.debug('* scheduled job fired: ' + rule_name + ' (schedule: ' + cronSchedule + ')')
		}

		const scheduleAction = function(err, context) {
			evaluation.evalulateValue(
				null,
				context,
				rule_name,
				rule,
				true,
				otherwise,
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
	doSchedule(rule_name, jobName, cronSchedule, rule, false)
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
		const during = rule.during

		if (!_.isNil(during)) {
			var index = 0
			during.forEach(duringString => {
				const timeRange = utilities.parseTimeRange(duringString)
				if ( !_.isNil(timeRange) ) {
					var jobKey = rule_name + '.during.' + index
					index = index + 1
					
					if ( timeRange.start < timeRange.now ) {
						doSchedule(rule_name, jobKey + '.start', moment(timeRange.start).add(15, 'seconds').toDate(), rule, false)
					} else { 
						doSchedule(rule_name, jobKey + '.start', timeRange.start.toDate(), rule, false)
					}
					doSchedule(rule_name, jobKey + '.end', moment(timeRange.end).add(1, 'seconds').toDate(), rule, true)
				}
			})
		}

		if (!_.isNil(schedule)) {
			Object.keys(schedule).forEach(function(schedule_key) {
				var jobKey = rule_name + '.schedule.' + schedule_key
				const cronSchedule = schedule[schedule_key]
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
