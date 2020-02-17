'use strict'
const aws = require('aws-sdk')
const ssm = new aws.SSM()
const childProcess = require('child_process')
const Mitm = require('mitm')

async function getConfig() {
  try {
    let params = {
      Name: process.env.FAILURE_INJECTION_PARAM
    }
    let request = await ssm.getParameter(params).promise()
    return request.Parameter.Value
  } catch (err) {
    console.error(err)
    throw err
  }
}
var injectFailure = function (fn) {
  return async function () {
    try {
      let configResponse = await getConfig()
      let config = JSON.parse(configResponse)
      if (config.isEnabled === true && Math.random() < config.rate) {
        if (config.failureMode === 'latency') {
          let latencyRange = config.maxLatency - config.minLatency
          let setLatency = Math.floor(config.minLatency + Math.random() * latencyRange)
          console.log('Injecting ' + setLatency + ' ms latency.')
          await new Promise(resolve => setTimeout(resolve, setLatency))
        } else if (config.failureMode === 'exception') {
          console.log('Injecting exception message: ' + config.exceptionMsg)
          throw new Error(config.exceptionMsg)
        } else if (config.failureMode === 'statuscode') {
          console.log('Injecting status code: ' + config.statusCode)
          let response = { statusCode: config.statusCode }
          return response
        } else if (config.failureMode === 'diskspace') {
          console.log('Injecting disk space: ' + config.diskSpace + ' MB')
          childProcess.spawnSync('dd', ['if=/dev/zero', 'of=/tmp/diskspace-failure-' + Date.now() + '.tmp', 'count=1000', 'bs=' + config.diskSpace * 1000])
        } else if (config.failureMode === 'blacklist') {
          console.log('Injecting dependency failure through a network blackhole for blacklisted sites: ' + config.blacklist)
          let mitm = Mitm()
          let blRegexs = []
          config.blacklist.forEach(function (regexStr) {
            blRegexs.push(new RegExp(regexStr))
          })
          mitm.on('connect', function (socket, opts) {
            let block = false
            blRegexs.forEach(function (blRegex) {
              if (blRegex.test(opts.host)) {
                console.log('Intercepted network connection to ' + opts.host)
                block = true
              }
            })
            if (block) {
              socket.end()
            } else {
              socket.bypass()
            }
          })
        }
      }
      return fn.apply(this, arguments)
    } catch (ex) {
      console.log(ex)
      throw ex
    }
  }
}

module.exports = injectFailure
