"use strict";

// Manual SMS smoke-test utility.
// Usage:
//   node scripts/test-sms.js <phone> <template-key> '[\"variable 1\",\"variable 2\"]'

require("dotenv").config();
const smsService = require("../src/utils/sms.service");

const [phone, templateKey, rawVariables = "[]"] = process.argv.slice(2);

if (!phone || !templateKey) {
  console.error(
    "Usage: node scripts/test-sms.js <phone> <template-key> '[\"variable 1\"]'",
  );
  process.exitCode = 1;
} else {
  let variables;
  try {
    variables = JSON.parse(rawVariables);
    if (!Array.isArray(variables)) throw new Error("variables must be an array");
  } catch (error) {
    console.error(`Invalid variables JSON: ${error.message}`);
    process.exitCode = 1;
  }

  if (variables) {
    smsService
      .sendSms({ phone, templateKey, variables })
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
