// src/middleware/requireIdempotencyKey.js
"use strict";

const ApiError = require("../utils/ApiError");

/**
 * requireIdempotencyKey — must be placed BEFORE idempotency middleware
 * on all financial write routes (loan, collection, deposit, pigmy).
 * Forces clients to always provide Idempotency-Key header.
 */
const requireIdempotencyKey = (req, res, next) => {
  if (req.method === "GET") return next();

  const key = req.headers["idempotency-key"];

  if (!key || key.trim() === "") {
    return next(
      // Use static factory method for ApiError
      ApiError.badRequest(
        "Idempotency-Key header is required for this operation. " +
          "Generate a unique UUID per request and include it as: Idempotency-Key: <uuid>",
      ),
    );
  }

  if (key.length > 200) {
    return next(
      ApiError.badRequest("Idempotency-Key must be 200 characters or less."),
    );
  }

  next();
};

module.exports = requireIdempotencyKey;
