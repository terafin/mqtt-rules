const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const health = require('homeautomation-js-lib/health.js')
const Redis = require('redis')
const utilities = require('./utilities.js')
const metrics = require('homeautomation-js-lib/stats.js')

var state = {}
var pendingTopicUpdates = []
var observedTopics = []

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT
const redisDB = process.env.REDIS_DATABASE

const requiredPrefixesString = process.env.REQUIRED_PREFIXES
const prefixesToIgnoreString = process.env.PREFIXES_TO_IGNORE
const topicStringsToIgnoreString = process.env.TOPIC_STRINGS_TO_INGORE
const stuffixesToIgnoreString = process.env.SUFFIXES_TO_IGNORE

const requiredPrefixes = _.isNil(requiredPrefixesString) ? null : requiredPrefixesString.split(',')
const prefixesToIgnore = _.isNil(prefixesToIgnoreString) ? null : prefixesToIgnoreString.split(',')
const topicStringsToIgnore = _.isNil(topicStringsToIgnoreString) ? null : topicStringsToIgnoreString.split(',')
const stuffixesToIgnore = _.isNil(stuffixesToIgnoreString) ? null : stuffixesToIgnoreString.split(',')

const isInterestingDevice = function(deviceTopic) {
    if (_.isNil(deviceTopic)) {
        return false
    }

    if (deviceTopic.length == 1) {
        return false
    }

    var match = false

    if (!_.isNil(requiredPrefixes)) {
        requiredPrefixes.forEach(prefix => {
            match |= deviceTopic.startsWith(prefix)
        })

        if (!match) {
            return false
        }

    }

    match = false

    if (!_.isNil(topicStringsToIgnore)) {
        topicStringsToIgnore.forEach(string => {
            match |= deviceTopic.includes(string)
        })

        if (match) {
            return false
        }
    }

    if (!_.isNil(prefixesToIgnore)) {
        prefixesToIgnore.forEach(prefix => {
            match |= deviceTopic.startsWith(prefix)
        })

        if (match) {
            return false
        }
    }

    if (!_.isNil(stuffixesToIgnore)) {
        stuffixesToIgnore.forEach(suffix => {
            match |= deviceTopic.endsWith(suffix)
        })

        if (match) {
            return false
        }
    }

    return true
}


const shouldUseRedis = function() {
    return !utilities.testMode() && !_.isNil(process.env.REDIS_HOST)
}

var redis = null

// Config
const expireAfterMinutes = process.env.EXPIRE_KEYS_AFTER_MINUTES

const connectToRedis = function(callback) {
    if (!shouldUseRedis()) {
        if (!_.isNil(callback)) {
            return callback()
        }

        return
    }

    if (!_.isNil(redis)) {
        if (!_.isNil(callback)) {
            return callback()
        }

        return
    }

    logging.debug(' setting up redis client')
    redis = Redis.createClient({
        host: redisHost,
        port: redisPort,
        db: redisDB,
        retry_strategy: function(options) {
            if (options.error && options.error.code === 'ECONNREFUSED') {
                // End reconnecting on a specific error and flush all commands with a individual error
                return new Error('The server refused the connection')
            }
            if (options.total_retry_time > 1000 * 60 * 60) {
                // End reconnecting after a specific timeout and flush all commands with a individual error
                return new Error('Retry time exhausted')
            }
            if (options.times_connected > 10) {
                // End reconnecting with built in error
                return undefined
            }
            // reconnect after
            return Math.min(options.attempt * 100, 3000)
        }
    })

    // redis callbacks

    redis.on('error', function(err) {
        logging.error('redis error ' + err)
    })

    redis.on('connect', function() {
        logging.info('redis connected ', {
            action: 'redis-connected'
        })

        if (!_.isNil(callback)) {
            return callback()
        }

    })

    redis.on('reconnect', function() {
        logging.error('redis disconnected ', {
            action: 'redis-disconnected'
        })
    })
}

const secondsToDefer = 10
var delayedUpdate = null

const processPendingUpdates = function() {
    if (!shouldUseRedis()) {
        return
    }

    if (!_.isNil(delayedUpdate)) {
        clearTimeout(delayedUpdate)
        delayedUpdate = null
    }

    var timeToExpire = expireAfterMinutes

    logging.debug('processing updates for topics: ' + pendingTopicUpdates)

    pendingTopicUpdates.forEach(topic => {
        if (!isInterestingDevice(topic)) {
            redis.del(topic)
            return
        }

        const message = state[topic]

        if (_.isNil(timeToExpire)) {
            logging.debug('setting: ' + topic + ' to: ' + message)

            redis.set(topic, message)
        } else {
            logging.debug('setting: ' + topic + ' to: ' + message)
            redis.set(topic, message, 'EX', (timeToExpire * 60)) // redis takes seconds
        }
    })

    pendingTopicUpdates = []
    logging.debug(' => done')

    // Prune un-needed values
    logging.debug(' Pruning state')
    Object.keys(state).forEach(topic => {
        if (!observedTopics.includes(topic)) {
            logging.debug('No longer need to observe, pruning:' + topic)
            delete(state[topic])
        }
    })

    logging.debug(' => done')
}

const setPendingUpdateForTopic = function(topic) {
    if (!isInterestingDevice(topic)) {
        return
    }

    if (pendingTopicUpdates.includes(topic)) {
        return
    }

    pendingTopicUpdates.push(topic)

    if (_.isNil(delayedUpdate)) {
        delayedUpdate = _.delay(processPendingUpdates, secondsToDefer * 1000)
    }
}

var initialStateLoaded = false

const _loadInitialState = function(topics, callback) {
    if (initialStateLoaded) {
        return
    }

    const completion = function() {
        logging.debug(' initial state loaded, sending callback: ' + JSON.stringify(state))

        initialStateLoaded = true
        if (!_.isNil(callback)) {
            return callback(true)
        }
    }

    if (!utilities.testMode()) {
        logging.debug(' starting connection')
        connectToRedis(function() {
            logging.debug(' connection completed')

            _updateObservedTopics(topics, function() {
                logging.debug(' done updating observed topics')
                completion()
            })
        })
    } else {
        completion()
    }
}

module.exports.isInitialStateLoaded = function() {
    return initialStateLoaded
}

const _updateObservedTopics = function(topics, callback) {
    observedTopics = topics

    if (!shouldUseRedis()) {
        logging.debug('will not update obseved topics, redis not used')
        if (!_.isNil(callback)) {
            return callback()
        }
        return
    }

    if (!redis.connected) {
        logging.error('Cannot update topics when redis is not connected')
        if (!_.isNil(callback)) {
            return callback()
        }
        return
    }

    logging.debug('updating observed topics: ' + topics)

    const redisStartTime = new Date().getTime()
    logging.debug(' redis query', {
        action: 'redis-query-start',
        start_time: redisStartTime
    })

    redis.mget(topics, function(err, values) {
        const redisQueryTime = ((new Date().getTime()) - redisStartTime)
        logging.debug(' redis query done', {
            action: 'redis-query-done',
            query_time: redisQueryTime
        })

        metrics.submit('redis_query_time', redisQueryTime)

        for (var index = 0; index < topics.length; index++) {
            const key = topics[index]
            const value = values[index]

            // Only update state if it isn't present
            if (_.isNil(state[key])) {
                state[key] = utilities.convertToNumberIfNeeded(value)

                try {
                    var jsonFound = JSON.parse(value)
                    if (!_.isNil(jsonFound)) {
                        Object.keys(jsonFound).forEach(function(key) {
                            if (_.isNil(state[key])) {
                                state[key] = jsonFound[key]
                            }
                        })
                    }
                } catch (err) {
                    // eslint-disable-next-line
                }
            }
        }

        if (!_.isNil(state)) {
            logging.debug('   == Done loading from Redis ==')
            logging.debug('   observed topics: ' + observedTopics)
            logging.debug('      loaded state: ' + JSON.stringify(state))
        }

        if (!_.isNil(callback)) {
            return callback()
        }
    })
}

module.exports.updateObservedTopics = function(topics, callback) {
    if (initialStateLoaded) {
        _updateObservedTopics(topics, callback)
    } else {
        _loadInitialState(topics, callback)
    }
}

module.exports.clearState = function() {
    state = {}
    pendingTopicUpdates = []
    observedTopics = []
}

module.exports.update = function(topic, message) {
    if (_.isNil(topic) || _.isNil(message)) {
        return
    }

    state[topic] = utilities.convertToNumberIfNeeded(message)
    health.healthyEvent()

    if (shouldUseRedis()) {
        setPendingUpdateForTopic(topic)
    }
}

module.exports.valueForTopic = function(topic) {
    if (_.isNil(topic)) {
        return null
    }

    logging.debug(' returning topic: ' + topic + ' value: ' + state[topic])

    return state[topic]
}

module.exports.valuesForTopics = function(topics) {
    if (_.isNil(topics)) {
        return null
    }

    var result = {}

    topics.forEach(topic => {
        const value = state[topic]
        if (_.isNil(value)) {
            result[topic] = 0
        } else {
            result[topic] = value
        }
    })

    return result
}