// src/utils/withTransaction.js
"use strict";

const mongoose = require("mongoose");
const logger = require("./logger");

const TXN_OPTIONS = {
  readPreference: "primary",
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  maxCommitTimeMS: 10_000,
};

const MAX_ATTEMPTS = 5;

/**
 * Wraps a callback in a MongoDB multi-document transaction.
 *
 * @param {Function} callback     - async (session) => { ... return result }
 *   The callback receives the active session. Pass `session` to ALL
 *   Mongoose queries inside: Model.find(...).session(session)
 *   The callback MAY be called multiple times on transient retries.
 *   It MUST be idempotent — use requestId guards at the start.
 *
 * @param {string} [operationName] - Label for retry logs
 *   e.g. "disburseLoan", "recordCollection", "agentDeposit"
 *   Makes retry logs actionable in production.
 *
 * @returns {Promise<*>} — whatever the callback returns on success
 *
 * @throws {ApiError}  — business logic errors from inside the callback
 * @throws {Error}     — sustained TransientTransactionError after MAX_ATTEMPTS
 */
const withTransaction = async (callback, operationName = "unknown") => {
  if (typeof callback !== "function") {
    throw new TypeError(
      `[withTransaction] callback must be a function. ` +
      `Received: ${typeof callback}. ` +
      `Usage: withTransaction(async (session) => { ... }, "operationName")`,
    );
  }

  const session = await mongoose.startSession();
  let attempts = 0;

  try {
    let result;

    await session.withTransaction(async () => {
      attempts += 1;

      if (attempts >= MAX_ATTEMPTS) {
        throw new Error(
          `[withTransaction:${operationName}] Aborted after ${MAX_ATTEMPTS} attempts. ` +
          `Sustained TransientTransactionError detected — possible replica set ` +
          `election or network partition. Retry the request after a short delay. ` +
          `If this persists, check MongoDB cluster health.`,
        );
      }

      if (attempts > 1) {
        logger.warn(
          `[withTransaction:${operationName}] Retry attempt ${attempts}/${MAX_ATTEMPTS} ` +
          `due to TransientTransactionError.`,
        );
      }

      result = await callback(session);
    }, TXN_OPTIONS);

    return result;
  } catch (err) {
    if (!err.isOperational) {
      logger.error(
        `[withTransaction:${operationName}] Transaction failed after ${attempts} attempt(s): ` +
        `${err.message}`,
      );
    }
    throw err;
  } finally {
    try {
      await session.endSession();
    } catch (endErr) {
      logger.error(
        `[withTransaction:${operationName}] Failed to end session: ${endErr.message}. ` +
        `This is a driver-level issue — check MongoDB connection health.`,
      );
    }
  }
};

module.exports = withTransaction;
