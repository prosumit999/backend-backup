// src/utils/ApiError.js
"use strict";

class ApiError extends Error {
  /**
   * @param {number}      statusCode  - HTTP status code
   * @param {string}      message     - Human-readable message (sent to client)
   * @param {Array|null}  errors      - Optional field-level validation errors
   * @param {string}      stack       - Optional pre-existing stack trace
   */
  constructor(statusCode, message, errors = null, stack = "") {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.isOperational = true;
    this.success = false;

    this.errors = Array.isArray(errors) ? errors : errors ? [errors] : null;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      statusCode: this.statusCode,
      message: this.message,
      isOperational: this.isOperational,
      success: this.success,
      errors: this.errors,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** 400 Bad Request — invalid input, failed validation */
ApiError.badRequest = (message, errors = null) => {
  const err = new ApiError(400, message, errors);
  Error.captureStackTrace(err, ApiError.badRequest);
  return err;
};

/** 401 Unauthorized — not authenticated */
ApiError.unauthorized = (message = "Authentication required.") => {
  const err = new ApiError(401, message);
  Error.captureStackTrace(err, ApiError.unauthorized);
  return err;
};

/** 403 Forbidden — authenticated but not permitted */
ApiError.forbidden = (
  message = "You do not have permission to perform this action.",
) => {
  const err = new ApiError(403, message);
  Error.captureStackTrace(err, ApiError.forbidden);
  return err;
};

/** 404 Not Found — resource does not exist or is soft-deleted */
ApiError.notFound = (message = "Resource not found.") => {
  const err = new ApiError(404, message);
  Error.captureStackTrace(err, ApiError.notFound);
  return err;
};

/** 409 Conflict — duplicate resource, concurrent modification */
ApiError.conflict = (message) => {
  const err = new ApiError(409, message);
  Error.captureStackTrace(err, ApiError.conflict);
  return err;
};

/** 422 Unprocessable Entity — semantically invalid request */
ApiError.unprocessable = (message, errors = null) => {
  const err = new ApiError(422, message, errors);
  Error.captureStackTrace(err, ApiError.unprocessable);
  return err;
};

/** 429 Too Many Requests — rate limit or login lockout */
ApiError.tooManyRequests = (
  message = "Too many requests. Please try again later.",
) => {
  const err = new ApiError(429, message);
  Error.captureStackTrace(err, ApiError.tooManyRequests);
  return err;
};

/** 500 Internal — use ONLY when a service hits a true invariant violation */
ApiError.internal = (
  message = "An internal error occurred. Contact superadmin.",
) => {
  const err = new ApiError(500, message);
  Error.captureStackTrace(err, ApiError.internal);
  return err;
};

/** 503 Service Unavailable — day closed, system locked, maintenance */
ApiError.serviceUnavailable = (message) => {
  const err = new ApiError(503, message);
  Error.captureStackTrace(err, ApiError.serviceUnavailable);
  return err;
};

ApiError.fromError = (err) => {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    return new ApiError(500, err.message || "An unexpected error occurred.", null, err.stack);
  }
  return ApiError.internal(String(err));
};

module.exports = ApiError;
