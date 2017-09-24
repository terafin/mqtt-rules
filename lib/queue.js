const _ = require('lodash')
const Queue = require('bull')
const logging = require('../homeautomation-js-lib/logging.js')

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT

var queues = {}

exports.enqueue = function(domainName, name, jobProcessor, jobData, inDelay, cancelPrevious, inLogResult) {
    var logResult = inLogResult
    if (_.isNil(logResult)) {
        logResult = {}
    }

    var delay = inDelay
    if (_.isNil(delay) || delay < 0) {
        delay = 0
    }

    // console.log('enqueue:')
    // console.log('     domain:' + domainName)
    // console.log('       name:' + name)
    // console.log('       data:' + jobData)
    // console.log('      delay:' + delay)
    // console.log('     cancel:' + cancelPrevious)

    const queueName = name + '_' + domainName

    if (cancelPrevious) {
        var existingQueue = queues[queueName]
        if (!_.isNil(existingQueue)) {
            logging.verbose('cancelled existing action queue =>(' + queueName + ')', Object.assign(logResult, {
                queue_name: queueName
            }))

            existingQueue.empty()
        }
        delete queues[queueName]
    }

    if (delay === 0) {
        var job = {}
        job.data = jobData
        jobProcessor(job, null)
    } else {
        var queue = Queue(queueName, redisPort, redisHost)
        queues[queueName] = queue

        queue.process(jobProcessor)

        queue.add(jobData, {
            removeOnComplete: true,
            removeOnFail: true,
            delay: (delay * 1000), // milliseconds
        })
    }
}

exports.clearQueue = function(domain, name) {
    const domainName = name + '_' + domain
    var queue = queues[domainName]
    if (!_.isNil(queue)) {
        queue.empty()
    }
}

exports.clearQueues = function(domain) {
    Object.keys(queues).forEach(function(element) {
        var queue = queues[element]
        if (!_.isNil(queue) && element.endsWith(domain)) {
            queue.empty()
        }

    }, this)
}