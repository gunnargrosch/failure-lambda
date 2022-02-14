'use strict'
const failureLambda = require('failure-lambda')
const AWS = require('aws-sdk')
const dynamoDb = new AWS.DynamoDB.DocumentClient()
let response

exports.handler = failureLambda(async (event, context) => {
  try {
    const contents = 'Hello failureLambda!'
    const ddbParams = {
      TableName: process.env.FAILURE_INJECTION_TABLE,
      Item: {
        id: Date.now(),
        contents: contents
      }
    }
    dynamoDb.put(ddbParams, (err) => {
      if (err) throw err
    })
    response = {
      statusCode: 200,
      body: JSON.stringify({
        message: contents
      })
    }
  } catch (err) {
    console.log(err)
    return err
  }

  return response
})
