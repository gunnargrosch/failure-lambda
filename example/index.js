'use strict'
const failureLambda = require('failure-lambda')
let response

exports.handler = failureLambda(async (event, context) => {
  try {
    response = {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Hello failureLambda!'
      })
    }
  } catch (err) {
    console.log(err)
    return err
  }

  return response
})
