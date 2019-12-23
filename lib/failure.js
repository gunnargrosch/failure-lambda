'use strict'
const aws = require('aws-sdk')
const ssm = new aws.SSM()

async function getConfig () {
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
        }
      }
      return fn.apply(this, arguments)
    } catch (ex) {
      console.log(ex)
    }
  }
}

module.exports = injectFailure
