const read_directory = require('read-directory')
const EventEmitter = require('events')
const chokidar = require('chokidar')
const yaml = require('js-yaml')
const utilities = require('./utilities.js')
const logging = require('homeautomation-js-lib/logging.js')
const _ = require('lodash')
const git = require('simple-git/promise')
const rimraf = require('rimraf')

var configs = []
var config_path = null
var git_url = null

module.exports = new EventEmitter()


const loadGIT = function() {
    if (_.isNil(git_url)) {
        return
    }
    rimraf.sync('rules')

    config_path = 'rules'
    git().silent(false)
        .clone(git_url, 'rules')
        .then(() => {
            logging.info('Successfully cloned rules')
            load_rule_config()
        })
        .catch((err) => console.error('Failed to clone rules: ', err))
}

module.exports.load_path = function(in_path) {
    if (!_.isNil(in_path) && (
            _.startsWith(in_path, 'https') ||
            _.startsWith(in_path, 'http') ||
            _.startsWith(in_path, 'git'))) {
        git_url = in_path
        loadGIT()
    } else {
        config_path = in_path

        // Watch Path
        const watcher = chokidar.watch(config_path, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true
          }).on('all', (event, path) => {
            load_rule_config()
        })
    }
}

module.exports.reload = function() {
    if (!_.isNil(git_url)) {
        loadGIT()
    } else {
        load_rule_config()
    }
}

module.exports.get_configs = function() {
    return configs
}

module.exports.set_override_configs = function(overrideConfigs) {
    configs = overrideConfigs
}

module.exports.ruleIterator = function(callback) {
    if (_.isNil(configs)) {
        return
    }

    configs.forEach(function(config_item) {
        if (_.isNil(config_item)) {
            return
        }

        Object.keys(config_item).forEach(function(key) {
            try {
                return callback(key, config_item[key])
            } catch (error) {
                logging.error('Failed callback for rule: ' + key + '  error: ' + error)
            }
        }, this)
    }, this)
}

const print_rule_config = function() {
    if (_.isNil(configs)) {
        return
    }

    configs.forEach(function(config_item) {
        if (_.isNil(config_item)) {
            return
        }

        Object.keys(config_item).forEach(function(key) {
            logging.debug(' Rule [' + key + ']')
        }, this)
    }, this)
}

const _load_rule_config = function() {
    logging.info(' => Really updating rules')
    read_directory(config_path, function(err, files) {
        configs = []

        logging.info('Loading rules at path: ' + config_path)
        if (err) {
            throw err
        }

        const fileNames = Object.keys(files)

        fileNames.forEach(file => {
            if (file.includes('._')) {
                return
            }
            if (file.includes('.yml') || file.includes('.yaml')) {
                logging.info(' - Loading: ' + file)
                const doc = yaml.safeLoad(files[file])
                const category_name = file.split('.')[0] + '_'
                if (!_.isNil(doc)) {
                    var namespacedRules = {}
                    Object.keys(doc).forEach(rule_key => {
                        const namespaced_key = utilities.update_topic_for_expression(category_name + rule_key)
                        namespacedRules[namespaced_key] = doc[rule_key]
                    })
                    configs.push(namespacedRules)
                }
            } else {
                logging.info(' - Skipping: ' + file)
            }
        })

        logging.info('...done loading rules')
        print_rule_config()
        module.exports.emit('rules-loaded')
    })
}


const secondsToDefer = 5
var delayedUpdate = null
const load_rule_config = function() {
    logging.info('Updating rules (deferring for ' + secondsToDefer + ' seconds)')
    if (!_.isNil(delayedUpdate)) {
        clearTimeout(delayedUpdate)
        delayedUpdate = null
    }
    delayedUpdate = _.delay(_load_rule_config, secondsToDefer * 1000)
}