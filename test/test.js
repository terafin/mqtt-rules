const utilities = require('../lib/utilities.js')
const TIMEZONE = utilities.getCurrentTimeZone()
console.log('Running in timezone: ' + TIMEZONE)

process.env.TEST_MODE = true

const yaml = require('js-yaml')

require('../mqtt-rules.js')
const jobscheduler = require('../lib/scheduled-jobs.js')

var targetTestTopic = null
var targetTestMessage = null
var targetCallback = null
var targetEarliestDate = null
var targetStartDate = null

var clearState = function() {
    targetTestTopic = null
    targetTestMessage = null
    targetCallback = null
    targetEarliestDate = null
    targetStartDate = null
}

var setupTest = function(topic, message, callback, minimumTime) {
    clearState()

    targetTestTopic = topic
    targetTestMessage = message
    targetCallback = callback
    if ((minimumTime != null) && minimumTime > 0) {
        targetEarliestDate = new Date(new Date().getTime() + (minimumTime * 1000))
        targetStartDate = new Date().getTime()
            // console.log('minimum fire date: ' + targetEarliestDate)
    }
}

var generateRule = function(ruleString) {
    return yaml.safeLoad(ruleString)
}
var generateContext = function(inContext) {
    var outContext = {}

    Object.keys(inContext).forEach(function(key) {
        outContext[utilities.update_topic_for_expression(key)] = inContext[key]
    }, this)

    return outContext
}

global.publish = function(rule_name, expression, valueOrExpression, topic, message, options) {
    if (topic.startsWith('happy'))
        return

    // console.log('incoming: ' + topic + ':' + message)
    // console.log('  looking for: ' + targetTestTopic + ':' + targetTestMessage)

    if (topic == targetTestTopic &&
        message == targetTestMessage) {
        if ((targetCallback != null)) {
            // console.log('incoming: ' + topic + ' : ' + message + '   (time: ' + (new Date().getTime()) / 1000 + ')')
            var tooEarly = false
            var howEarly = 0
            var desiredMinimum = 0
            if (targetEarliestDate != null) {
                const now = new Date()
                    // console.log('minimum fire date: ' + targetEarliestDate + '   now: ' + now)

                // Fudge half a second, as sometimes timers early fire a little bit...
                if (now + 0.5 < targetEarliestDate) {
                    tooEarly = true
                    howEarly = targetEarliestDate - now
                    desiredMinimum = (targetEarliestDate - targetStartDate) / 1000
                }
            }
            var oldCallBack = targetCallback

            clearState()

            setTimeout(function cb() {
                if (tooEarly)
                    oldCallBack('test finished too early (' + howEarly + 's vs ' + desiredMinimum + 's)')
                else
                    oldCallBack()
            })
        }
    }
}

describe('quick trigger tests', function() {
    before(function() {
        // runs before all tests in this block
        global.clearQueues()
    })

    this.slow(100)

    it('test motion should trigger light on', function(done) {
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/#"] \n\
    actions: \n\
      "/test/lights/set": "/test/motion" \n\
    ')

        setupTest('/test/lights/set', '1', done)

        global.changeProcessor([rule], {}, '/test/motion', '1')
    }).timeout(500)

    it('test motion should trigger light off', function(done) {
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
    actions: \n\
      "/test/lights/set": "$TRIGGER_TOPIC" \n\
    ')
        setupTest('/test/lights/set', '0', done)

        global.changeProcessor([rule], {}, '/test/motion', '0')
    }).timeout(500)

    it('testing compound if expressions', function(done) {
        const rule = generateRule(
            'some_compound_if_expression: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
    expression: \n\
      if: \n\
        rule1: "/test/motion == 1"\n\
        rule2: "/test/motion == 0"\n\
    actions: \n\
      "/test/lights/set": "/test/motion" \n\
    ')
        setupTest('/test/lights/set', '0', done)

        global.changeProcessor([rule], {}, '/test/motion', '0')
    }).timeout(500)

    it('test comparing values for true', function(done) {
        const rule = generateRule(
            'is_cooler_outside: \n\
        watch:  \n\
            devices: ["/test/environment/temperatures/current_area", "/test/environment/temperature/outdoors"] \n\
        actions:  \n\
            "/test/environment/temperatures/is_cooler_outside": "(/test/environment/temperatures/current_area > (/test/environment/temperature/outdoors + 0.5) ? 1 : 0" \n')

        setupTest('/test/environment/temperatures/is_cooler_outside', '1', done)

        const context = {
            '/test/environment/temperatures/current_area': '20',
        }
        global.changeProcessor([rule], generateContext(context), '/test/environment/temperature/outdoors', '15')
    }).timeout(500)

    it('test comparing values for false', function(done) {
        const rule = generateRule(
            'is_cooler_outside: \n\
        watch:  \n\
            devices: ["/test/environment/temperatures/current_area", "/test/environment/temperature/outdoors"] \n\
        actions:  \n\
            "/test/environment/temperatures/is_cooler_outside": "(/test/environment/temperatures/current_area > (/test/environment/temperature/outdoors + 0.5) ? 1 : 0" \n')

        setupTest('/test/environment/temperatures/is_cooler_outside', '0', done)

        const context = {
            '/test/environment/temperatures/current_area': '20',
        }
        global.changeProcessor([rule], generateContext(context), '/test/environment/temperature/outdoors', '25')
    }).timeout(500)

    it('test averaging numbers float', function(done) {
        const rule = generateRule(
            'sleeping_area_temperature_calculator: \n\
            watch: \n\
              devices: ["/test/environment/thermostat/temperature/bedroom", "/test/environment/thermostat/temperature/guest_bedroom"] \n\
            actions: \n\
              "/test/environment/temperatures/sleeping_area": "(/test/environment/thermostat/temperature/bedroom + /test/environment/thermostat/temperature/guest_bedroom) / 2"')

        setupTest('/test/environment/temperatures/sleeping_area', '12.5', done)

        const context = {
            '/test/environment/thermostat/temperature/bedroom': '15',
        }
        global.changeProcessor([rule], generateContext(context), '/test/environment/thermostat/temperature/guest_bedroom', '10')
    }).timeout(500)

    it('test averaging numbers integer', function(done) {
        const rule = generateRule(
            'sleeping_area_temperature_calculator: \n\
            watch: \n\
              devices: ["/test/environment/thermostat/temperature/bedroom", "/test/environment/thermostat/temperature/guest_bedroom"] \n\
            actions: \n\
              "/test/environment/temperatures/sleeping_area": "(/test/environment/thermostat/temperature/bedroom + /test/environment/thermostat/temperature/guest_bedroom) / 2"')

        setupTest('/test/environment/temperatures/sleeping_area', '15', done)

        const context = {
            '/test/environment/thermostat/temperature/bedroom': '20',
        }
        global.changeProcessor([rule], generateContext(context), '/test/environment/thermostat/temperature/guest_bedroom', '10')
    }).timeout(500)


    it('test home mode (or)', function(done) {
        const rule = generateRule(
            'test_nobody_home_mode: \n\
          rules: \n\
            expression: "(/test/presence/geofence/home/justin == 1 || /test/presence/geofence/home/elene == 1) && (/test/home/mode != 0 || /test/home/mode == 2)" \n\
          watch: \n\
            devices: ["/test/presence/geofence/home/justin", "/test/presence/geofence/home/elene"] \n\
          actions: \n\
            "/test/home/mode": "0"')

        setupTest('/test/home/mode', '0', done)

        const context = {
            '/test/home/mode': '1',
            '/test/presence/geofence/home/justin': '0'
        }
        global.changeProcessor([rule], generateContext(context), '/test/presence/geofence/home/elene', '1')
    }).timeout(500)

    it('test away mode (and)', function(done) {
        const rule = generateRule(
            'test_nobody_home_mode: \n\
          rules: \n\
            expression: "(/test/presence/geofence/home/justin == 0) && (/test/presence/geofence/home/elene == 0) && (/test/home/mode == 0 || /test/home/mode == 2)" \n\
          watch: \n\
            devices: ["/test/presence/geofence/home/justin", "/test/presence/geofence/home/elene"] \n\
          actions: \n\
            "/test/home/mode": "1"')

        setupTest('/test/home/mode', '1', done)

        const context = {
            '/test/home/mode': '0',
            '/test/presence/geofence/home/justin': '0',
            '/test/presence/geofence/home/elene': '1'
        }

        global.changeProcessor([rule], generateContext(context), '/test/presence/geofence/home/elene', '0')
    }).timeout(500)

    it('simple evaluate, string result', function(done) {
        const rule = generateRule(
            'test_harmony_off_when_mode_changes:\n\
            watch:\n\
              devices: ["/test/home/mode"]\n\
            rules:\n\
              expression: "(/test/home/mode == 1) || (/test/home/mode == 2)"\n\
            actions:\n\
              "/test/livingroom/harmony/set": "off"\n')

        setupTest('/test/livingroom/harmony/set', 'off', done)

        global.changeProcessor([rule], {}, '/test/home/mode', '1')
    }).timeout(500)

    it('test simple value during a time', function(done) {
        // front_door_lights:
        //   allowed_times: ["17:00 - 23:59", "00:00 - 5:00"]
        //   rules:
        //     expression: "(/doors/front == 255) && (/house/lights == 0) && (/home/mode == 0)"
        //   watch:
        //     devices: ["/doors/front"]
        //   actions:
        //       "/house/lights/set": "1"
        done()
    }).timeout(500)

    it('simple conditional action > 0', function(done) {
        const rule = generateRule(
            'vents: \n\
        watch:\n\
          devices: ["/environment/vents"]\n\
        actions:\n\
          "/guest_bathroom/vent/set": "(/environment/vents > 0) ? 50 : 0"\n')

        setupTest('/guest_bathroom/vent/set', '50', done)

        global.changeProcessor([rule], {}, '/environment/vents', '1')

    }).timeout(500)

    it('simple conditional action == 0', function(done) {
        const rule = generateRule(
            'vents: \n\
        watch:\n\
          devices: ["/environment/vents"]\n\
        actions:\n\
          "/guest_bathroom/vent/set": "(/environment/vents > 0) ? 50 : 0"\n')

        setupTest('/guest_bathroom/vent/set', '0', done)

        global.changeProcessor([rule], {}, '/environment/vents', '0')

    }).timeout(500)

})

describe('delay tests', function() {
    before(function() {
        // runs before all tests in this block
        global.clearQueues()
    })

    this.slow(10500)

    it('test motion should trigger light on, then off 10s later', function(done) {
        this.slow(10500)
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
    actions: \n\
      "/test/lights/set": "/test/motion" \n\
    delayed_actions: \n\
      delay: 10 \n\
      actions: \n\
        "/test/lights/set": "0" ')

        setupTest('/test/lights/set', '1', function() {
            setupTest('/test/lights/set', '0', done, 10)
        })

        global.changeProcessor([rule], {}, '/test/motion', '1')
    }).timeout(12000)

    it('test motion should trigger light on, motion again 5s later, then off 10s later', function(done) {
        this.slow(16000)
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
    actions: \n\
      "/test/lights/set": "/test/motion" \n\
    delayed_actions: \n\
      delay: 10 \n\
      actions: \n\
        "/test/lights/set": "0" ')

        setupTest('/test/lights/set', '1', function() {
            setupTest('/test/lights/set', '0', done, 15)
        })

        global.changeProcessor([rule], {}, '/test/motion', '1')

        setTimeout(function() {
            global.changeProcessor([rule], {}, '/test/motion', '1')
        }, 5000)

    }).timeout(17000)

    it('delayed evaluate of 2s', function(done) {
        this.slow(2200)
        const rule = generateRule(
            'test_guest_bathroom_motion_off: \n\
            evaluate_after: 2 \n\
            watch: \n\
              devices: ["/test/guest_bathroom/motion"] \n\
            rules: \n\
              expression: "/test/guest_bathroom/motion == 0" \n\
            actions: \n\
              "/test/zones/guest_bathroom": "0" \n')

        setupTest('/test/zones/guest_bathroom', '0', done, 2)

        global.changeProcessor([rule], {}, '/test/guest_bathroom/motion', '0')
    }).timeout(4000)

})

describe('time based triggers', function() {
    before(function() {
        // runs before all tests in this block
        global.setOverrideContext(null)
        global.clearQueues()
    })

    this.slow(1200)

    it('test if a trigger can fire at sunset', function(done) {
        done()
    }).timeout(60000)

    it('test if a trigger can fire inside a minute', function(done) {
        this.slow(16000)
        const rule = generateRule('\
            test_timed_rule: \n\
            schedule: \n\
              soon: "*/2 * * * * *" \n\
            actions: \n\
              "/test/timer/fired": "1" \n\
            ')
        jobscheduler.scheduleJob('test_timed_rule', 'test_timed_rule', '*/2 * * * * *', rule)
        setupTest('/test/timer/fired', '1', done, 1)

    }).timeout(5000)

    it('test if a trigger can check values', function(done) {
        this.slow(16000)
        const rule = generateRule('\
            test_timed_rule_with_value: \n\
            schedule: \n\
              soon: "*/2 * * * * *" \n\
            actions: \n\
              "/test/timer/print_value": "/test/timer/some_value" \n\
            ')

        const context = {
            '/test/timer/some_value': '42',
        }
    
        global.setOverrideContext(context)
        jobscheduler.scheduleJob('test_timed_rule', 'test_timed_rule', '*/2 * * * * *', rule)
        setupTest('/test/timer/print_value', '42', done, 1)

    }).timeout(5000)
})

