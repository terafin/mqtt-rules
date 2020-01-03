const _ = require('lodash')

var queues = {}


const basicQueueClear = function(queueName) {
    var queue = queues[queueName]
    if (!_.isNil(queue)) {
        queue.forEach(function(queuedItem) {
            clearTimeout(queuedItem)
        })
    }
}

const basicQueueProcessor = function(queueName, jobProcessor, jobData, delay) {
    var queue = queues[queueName]

    if (_.isNil(queue)) {
        queue = []
        queues[queueName] = queue
    }

    const queuedItem = setTimeout(jobProcessor, (delay), { data: jobData })
    queue.push(queuedItem)
}

const dispatchClearQueue = function(queueName) {
    // console.log('clearing queue name: ' + queueName)

    basicQueueClear(queueName)
}

const dispatchQueueItem = function(queueName, jobProcessor, jobData, delay) {
    // console.log('queue on queue name: ' + queueName + '   delay: ' + delay)
    basicQueueProcessor(queueName, jobProcessor, jobData, delay)
}

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

    if (cancelPrevious) {
        this.clearQueue(domainName, name)
    }

    if (delay === 0) {
        var job = {}
        job.data = jobData
        jobProcessor(job, null)
    } else {
        const queueName = name + '_' + domainName
        dispatchQueueItem(queueName, jobProcessor, jobData, delay)
    }
}

exports.clearQueue = function(domain, name) {
    const queueName = name + '_' + domain
    var queue = queues[queueName]
    if (!_.isNil(queue)) {
        dispatchClearQueue(queueName)
        delete queues[queueName]
    }
}

exports.clearQueues = function(domain) {
    Object.keys(queues).forEach(function(element) {
        var queue = queues[element]
        if (!_.isNil(queue) && element.endsWith(domain)) {
            dispatchClearQueue(element)

            delete queues[element]
        }

    }, this)
}