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
	const options = rule.options
	var quiet = false

	if ( !_.isNil(options) && !_.isNil(options.quiet) ) { 
		quiet = options.quiet 
	}

	if ( !quiet && !utilities.testMode() ) { 
		logging.info('scheduling rule: ' + rule_name + '  job: ' + jobName + '  schedule: ' + utilities.logDate(date) + ' timezone: ' + TIMEZONE)
	}
	var newJob = schedule.scheduleJob(rule_name, date, TIMEZONE, function() {
		if ( !quiet && !utilities.testMode() ) {
			logging.info('scheduled rule fired: ' + rule_name + '  job: ' + jobName + '  schedule: ' + date + ' rule: ' + JSON.stringify(rule))
			logging.debug('job fired'  + 'data:' + JSON.stringify({
				action: 'scheduled-job-fired',
				schedule: date,
				job: jobName,
				rule_name: rule_name,
				rule: rule
			}))
			logging.debug('* scheduled job fired: ' + rule_name + ' (schedule: ' + utilities.logDate(date) + ')')
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
		if ( !quiet && !utilities.testMode() ) { 
			logging.info('scheduled ' + rule_name + ' - ' + utilities.logDate(date))
			logging.debug('job scheduled ' + 'data:' + JSON.stringify({
				action: 'job-scheduled',
				schedule: date,
				job: jobName,
				rule_name: rule_name,
				rule: rule

			}))
		}

		scheduled_jobs.push(newJob)
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
				if ( !_.isNil(timeRange) ) {
					var jobKey = rule_name + '.during.' + duringIndex
					duringIndex = duringIndex + 1
					
					if ( timeRange.start < timeRange.now ) {
						doSchedule(rule_name, jobKey + '.start', moment(timeRange.start).add(15, 'seconds').toDate(), rule, false)
					} else { 
						doSchedule(rule_name, jobKey + '.start', timeRange.start.toDate(), rule, false)
					}
					doSchedule(rule_name, jobKey + '.end', moment(timeRange.end).add(100, 'ms').toDate(), rule, true)
				}
			})
		}

		const at = rule.at
		if (!_.isNil(at)) {
			var atIndex = 0
			at.forEach(atString => {
				const time = utilities.parseTime(atString)
				if ( !_.isNil(time) ) {
					var jobKey = rule_name + '.at.' + atIndex
					atIndex = atIndex + 1
					
					doSchedule(rule_name, jobKey, time.toDate(), rule, false)
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
		setTimeout(exports.scheduleJobs(), 250)
	})
}
