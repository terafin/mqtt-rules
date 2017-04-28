// Requirements
const mqtt = require('mqtt')
var jexl = require('jexl')
var Redis = require('redis')

const config = require('./homeautomation-js-lib/config_loading.js')
const logging = require('./homeautomation-js-lib/logging.js')

require('./homeautomation-js-lib/devices.js')
require('./homeautomation-js-lib/mqtt_helpers.js')

const redisHost = process.env.REDIS_HOST
const redisPort = process.env.REDIS_PORT
const redisDB = process.env.REDIS_DATABASE
const config_path = process.env.TRANSFORM_CONFIG_PATH

const syslogHost = process.env.SYSLOG_HOST
const syslogPort = process.env.SYSLOG_PORT

// Config
const host = process.env.MQTT_HOST

// Set up modules
logging.set_enabled(true)
logging.setRemoteHost(syslogHost, syslogPort)

// Setup MQTT
var client = mqtt.connect(host)

// MQTT Observation

client.on('connect', () => {
    logging.log('Reconnecting...\n')
    client.subscribe('#')
})

client.on('disconnect', () => {
    logging.log('Reconnecting...\n')
    client.connect(host)
})

client.on('message', (topic, message) => {
    logging.log(' ' + topic + ':' + message)
})

const redis = Redis.createClient({
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
    logging.log('redis error ' + err)
})

redis.on('connect', function() {
    logging.log('redis connected')
    config.load_path(config_path)
})

config.on('config-loaded', () => {
    logging.log('config-loaded!')
    redis.flushdb()

    config.deviceIterator(function(device_id, device) {
        redis.set(device.topic, device.name)
    })
})

var context = {
    name: { first: 'Sterling', last: 'Archer' },
    assoc: [
        { first: 'Lana', last: 'Kane' },
        { first: 'Cyril', last: 'Figgis' },
        { first: 'Pam', last: 'Poovey' }
    ],
    age: 36
}

jexl.eval('(1 || 0) * 4', context, function(err, res) {
    logging.log(res) // Output: 72
})