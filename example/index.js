'use strict'
const failureLambda = require('failure-lambda')
const fs = require('fs')
let response

exports.handler = failureLambda(async (event, context) => {
  try {
    fs.writeFile('/tmp/example-' + Date.now() + '.tmp', 'Contents', (err) => {
      if (err) throw err
    })
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
