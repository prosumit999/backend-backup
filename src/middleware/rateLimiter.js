// src/middleware/rateLimiter.js
"use strict";

const rateLimit = require("express-rate-limit");
const ApiError = require("../utils/ApiError");

/**
 * authLimiter
 * 10 login attempts per 15 minutes per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res, next, options) => {
    throw new ApiError(
      429,
      `Too many login attempts. Please try again after 15 minutes.`
    );
  },
});

/**
 * transactionLimiter
 * 100 sensitive transactions per hour per IP.
 */
const transactionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    throw new ApiError(
      429,
      `Transaction limit exceeded. Slow down or contact technical support.`
    );
  },
});

module.exports = {
  authLimiter,
  transactionLimiter,
};
