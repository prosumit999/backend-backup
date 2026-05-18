// src/middleware/idempotency.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP Idempotency Key middleware
//
// Guarantees that any POST/PATCH with an Idempotency-Key header is processed
// exactly once. Subsequent retries with the same key return the cached response.
//
// WRITE SAFETY (I-1 FIX):
//   OLD: response sent → DB write fire-and-forget.
//        If the process crashed between the send and the DB write, the key
//        stayed in "processing" state for up to 24h (TTL), blocking all retries.
//   NEW: DB write completes FIRST → then response is sent.
//        If the DB write fails, the response is still sent (idempotency failure
//        must never block the client) and the error is logged.
//        This narrows the crash window to zero for the happy path.
//
// AUTH GUARD (I-2 FIX):
//   IdempotencyKey.model has userId: required:true.
//   If req.user is null (unauthenticated route or broken middleware chain),
//   the create() call would throw a Mongoose validation error — unhandled.
//   We now skip idempotency entirely for unauthenticated requests.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const IdempotencyKey = require("../models/IdempotencyKey.model");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");

const idempotency = asyncHandler(async (req, res, next) => {
  // Skip non-mutating requests
  if (req.method === "GET") return next();

  const key = req.headers["idempotency-key"];
  if (!key) return next();


  const userId = req.user?._id ?? null;
  if (!userId) {
    logger.warn(
      `[Idempotency] Skipping — no authenticated user for key "${key}". ` +
      `Ensure authenticate middleware runs before idempotency middleware.`,
    );
    return next();
  }

  // Try to find existing key — scoped to this user only
  const existing = await IdempotencyKey.findOne({ key, userId });

  if (existing) {
    if (existing.status === "completed") {
      // Return cached response — client gets same result as original request
      res.set("X-Idempotency-Replayed", "true");
      return res.status(existing.statusCode || 200).json(existing.responseData);
    }

    if (existing.status === "processing") {
      const isStuck = Date.now() - new Date(existing.createdAt).getTime() > 120000;
      if (isStuck) {
        logger.warn(`[Idempotency] Cleared stuck processing key: ${key}`);
        await IdempotencyKey.deleteOne({ key, userId });
      } else {
        throw new ApiError(
          409,
          "This request is already being processed. Please wait.",
        );
      }
    }

    if (existing.status === "failed") {
      // Previous attempt failed — allow retry by clearing the failed key
      await IdempotencyKey.deleteOne({ key, userId });
    }
  }

  // New key (or cleaned-up failed key) — insert as "processing"
  try {
    await IdempotencyKey.create({
      key,
      userId,
      status: "processing",
    });
  } catch (err) {
    // Duplicate key error (race condition) → a concurrent request won the race
    if (err.code === 11000) {
      throw new ApiError(
        409,
        "Duplicate request detected. Operation already in progress.",
      );
    }
    throw err;
  }

  // ── I-1 FIX: DB write BEFORE response send ────────────────────────────────
  // OLD: originalJson(data) → fire-and-forget findOneAndUpdate (no await).
  //      Crash window: process killed after response sent, before DB write →
  //      key stuck in "processing" for 24h (TTL), all retries get 409.
  //
  // NEW: findOneAndUpdate awaited INSIDE .then() chained off the DB promise.
  //      Flow: DB write completes → THEN call originalJson (send response).
  //      If DB write throws, we log and still send the response — idempotency
  //      failure must never block the client from getting their result.
  //      Crash window is now: only if the process dies during the DB write
  //      itself (unavoidable without 2-phase commit, which is overkill here).
  // ─────────────────────────────────────────────────────────────────────────
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    const capturedStatusCode = res.statusCode || 200;

    const persistPromise =
      capturedStatusCode >= 500
        ? IdempotencyKey.deleteOne({ key, userId })
        : IdempotencyKey.findOneAndUpdate(
          { key, userId },
          {
            status: capturedStatusCode >= 400 ? "failed" : "completed",
            statusCode: capturedStatusCode,
            responseData: data,
          },
        );

    // DB write first, response second — eliminates the fire-and-forget race
    persistPromise
      .then(() => {
        originalJson(data);
      })
      .catch((err) => {
        logger.error(
          `[Idempotency] Failed to persist key "${key}": ${err.message}. ` +
          `Response will still be sent. Key may replay incorrectly on retry.`,
        );
        // Always send the response — idempotency is best-effort, not blocking
        originalJson(data);
      });
  };

  next();
});

module.exports = idempotency;
