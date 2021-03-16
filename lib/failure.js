"use strict";
const aws = require("aws-sdk");
const ssm = new aws.SSM();
const fetch = require("node-fetch");
const childProcess = require("child_process");
const Mitm = require("mitm");

var mitm = null;

function clearMitm() {
  if (mitm != null) {
    mitm.disable();
  }
}

async function getConfig() {
  const defaults = {
    isEnabled: false,
  };
  if (process.env.FAILURE_APPCONFIG_CONFIGURATION) {
    try {
      if (process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT) {
        var appconfigPort = process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT;
      } else {
        var appconfigPort = 2772;
      }
      const url =
        "http://localhost:" +
        appconfigPort +
        "/applications/" +
        process.env.FAILURE_APPCONFIG_APPLICATION +
        "/environments/" +
        process.env.FAILURE_APPCONFIG_ENVIRONMENT +
        "/configurations/" +
        process.env.FAILURE_APPCONFIG_CONFIGURATION;
      const response = await fetch(url);
      const json = await response.json();
      return json;
    } catch (err) {
      console.error(err);
      return defaults;
    }
  } else if (process.env.FAILURE_INJECTION_PARAM) {
    try {
      let params = {
        Name: process.env.FAILURE_INJECTION_PARAM,
      };
      let response = await ssm.getParameter(params).promise();
      let json = JSON.parse(response.Parameter.Value);
      return json;
    } catch (err) {
      console.error(err);
      return defaults;
    }
  } else {
    return defaults;
  }
}
var injectFailure = function (fn) {
  return async function () {
    try {
      let config = await getConfig();

      if (config.isEnabled === false || config.failureMode != "denylist") {
        clearMitm();
      }

      if (config.isEnabled === true && Math.random() < config.rate) {
        if (config.failureMode === "latency") {
          let latencyRange = config.maxLatency - config.minLatency;
          let setLatency = Math.floor(
            config.minLatency + Math.random() * latencyRange
          );
          console.log("Injecting " + setLatency + " ms latency.");
          await new Promise((resolve) => setTimeout(resolve, setLatency));
        } else if (config.failureMode === "exception") {
          console.log("Injecting exception message: " + config.exceptionMsg);
          throw new Error(config.exceptionMsg);
        } else if (config.failureMode === "statuscode") {
          console.log("Injecting status code: " + config.statusCode);
          let response = { statusCode: config.statusCode };
          return response;
        } else if (config.failureMode === "diskspace") {
          console.log("Injecting disk space: " + config.diskSpace + " MB");
          childProcess.spawnSync("dd", [
            "if=/dev/zero",
            "of=/tmp/diskspace-failure-" + Date.now() + ".tmp",
            "count=1000",
            "bs=" + config.diskSpace * 1000,
          ]);
        } else if (config.failureMode === "denylist") {
          console.log(
            "Injecting dependency failure through a network block for denylisted sites: " +
              config.denylist
          );

          // if the global mitm doesn't yet exist, create it now
          if (mitm == null) {
            mitm = Mitm();
          }
          mitm.enable();

          // attach a handler to filter the configured deny patterns
          let blRegexs = [];
          config.denylist.forEach(function (regexStr) {
            blRegexs.push(new RegExp(regexStr));
          });
          mitm.on("connect", function (socket, opts) {
            let block = false;
            blRegexs.forEach(function (blRegex) {
              if (blRegex.test(opts.host)) {
                console.log("Intercepted network connection to " + opts.host);
                block = true;
              }
            });
            if (block) {
              socket.end();
            } else {
              socket.bypass();
            }
          });

          // remove any previously attached handlers, leaving only the most recently added
          while (typeof mitm._events.connect != "function") {
            mitm.removeListener("connect", mitm._events.connect[0]);
          }
        }
      }
      return fn.apply(this, arguments);
    } catch (ex) {
      console.log(ex);
      throw ex;
    }
  };
};

module.exports = injectFailure;
