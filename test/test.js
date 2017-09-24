const _ = require('lodash')
const utilities = require('../lib/utilities.js')

const yaml = require('js-yaml')

process.env.TEST_MODE = true

require('../mqtt-rules.js')

var targetTestTopic = null
var targetTestMessage = null
var targetCallback = null


var setupTest = function(topic, message, callback) {
    targetTestTopic = topic
    targetTestMessage = message
    targetCallback = callback
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

global.client.on('message', (topic, message) => {
    if (topic.startsWith('happy'))
        return

    // console.log('incoming: ' + topic + ':' + message)
    // console.log('  looking for: ' + targetTestTopic + ':' + targetTestMessage)

    if (topic == targetTestTopic &&
        message == targetTestMessage) {
        if (!_.isNull(targetCallback)) {
            var oldCallBack = targetCallback
            setTimeout(function cb() {
                oldCallBack()
            })
            targetCallback = null
        }
    }
})

describe('quick trigger tests', function() {
    before(function() {
        // runs before all tests in this block
        global.clearQueues()
    })

    this.slow(100)

    it('test connection to mqtt', function(done) {
        if (global.client.connected == true) {
            done()
        } else {
            global.client.on('connect', function() {
                done()
            })
        }
    })

    it('test motion should trigger light on', function(done) {
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
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
      "/test/lights/set": "/test/motion" \n\
    ')
        setupTest('/test/lights/set', '0', done)

        global.changeProcessor([rule], {}, '/test/motion', '0')
    }).timeout(500)

    it('test comparing values for true/false', function(done) {
        // is_cooler_outside:
        //     watch:
        //       devices: ["/environment/temperatures/current_area", "/environment/temperature/outdoors"]
        //     actions:
        //       "/environment/temperatures/is_cooler_outside": "(/environment/temperatures/current_area > (/environment/temperature/outdoors + 0.5) ? 1 : 0"
        done()
    }).timeout(500)

    it('test averaging numbers', function(done) {
        // sleeping_area_temperature_calculator:
        //     watch:
        //       devices: ["/environment/thermostat/temperature/bedroom", "/environment/thermostat/temperature/guest_bedroom"]
        //     actions:
        //       "/environment/temperatures/sleeping_area": "(/environment/thermostat/temperature/bedroom + /environment/thermostat/temperature/guest_bedroom) / 2"
        done()
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

    it('delayed evaluate of 1s', function(done) {
        // guest_bathroom_motion_off:
        //     evaluate_after: 1200
        //     watch:
        //       devices: ["/guest_bathroom/motion"]
        //     rules:
        //       expression: "/guest_bathroom/motion == 0"
        //     actions:
        //       "/zones/guest_bathroom": "0"
        done()
    }).timeout(500)

    it('simple evaluate, string result', function(done) {
        // harmony_off_when_mode_changes:
        //     watch:
        //       devices: ["/home/mode"]
        //     rules:
        //       expression: "(/home/mode == 1) || (/home/mode == 2)"
        //     actions:
        //       "/livingroom/harmony/set": "off"
        done()
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

    this.slow(1200)

    it('test connection to mqtt', function(done) {
        if (global.client.connected == true) {
            done()
        } else {
            global.client.on('connect', function() {
                done()
            })
        }
    })


    it('test motion should trigger light on, then off', function(done) {
        const rule = generateRule(
            'some_bathroom_lights_motion: \n\
    watch: \n\
      devices: ["/test/motion"] \n\
    actions: \n\
      "/test/lights/set": "/test/motion" \n\
    delayed_actions: \n\
      delay: 1 \n\
      actions: \n\
        "/test/lights/set": "0" ')

        setupTest('/test/lights/set', '1', function() {
            setupTest('/test/lights/set', '0', done)
        })

        global.changeProcessor([rule], {}, '/test/motion', '1')
    }).timeout(3000)

})