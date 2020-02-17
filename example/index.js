'use strict'
const failureLambda = require('failure-lambda')
const fs = require('fs')
const AWS = require('aws-sdk')
const s3 = new AWS.S3()
const dynamoDb = new AWS.DynamoDB.DocumentClient()
let response

exports.handler = failureLambda(async (event, context) => {
  try {
    let fileName = Date.now() + '.tmp'
    let contents = 'Hello failureLambda!'
    fs.writeFile('/tmp/' + fileName, contents, (err) => {
      if (err) throw err
    })
    let s3Params = {
      Bucket: process.env.FAILURE_INJECTION_BUCKET,
      Key: fileName,
      Body: contents
    }
    s3.upload(s3Params, (err) => {
      if (err) throw err
    })
    let ddbParams = {
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
