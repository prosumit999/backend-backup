// src/utils/cronLock.js
"use strict";

const crypto = require("crypto");
const AppConfig = require("../models/AppConfig.model");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE TOKEN — generated ONCE per process lifetime.
// UUID instead of process.pid: PIDs are reused by the OS after crash+restart.
// On Docker with --restart always, the new process can get the same PID as
// the crashed one. UUID collision probability: ~0 (122 bits of entropy).
// ─────────────────────────────────────────────────────────────────────────────
const INSTANCE_TOKEN = crypto.randomUUID();

logger.info(
  `[CronLock] Instance token: ${INSTANCE_TOKEN} (PID: ${process.pid})`,
);

// ─────────────────────────────────────────────────────────────────────────────
// LOCK KEYS — must match AppConfig seeded document keys exactly.
// ─────────────────────────────────────────────────────────────────────────────
const LOCK_KEYS = Object.freeze({
  PENALTY: "CRON_LOCK_PENALTY",
  RECONCILE: "CRON_LOCK_RECONCILE",
  MISSED_DAY_TRACKING: "CRON_LOCK_MISSED_DAY_TRACKING",
  DEFICIT_WARNING: "CRON_LOCK_DEFICIT_WARNING", // pigmy collection deficit warning cron
});

// ─────────────────────────────────────────────────────────────────────────────
// ACQUIRE LOCK
// Returns true  → this instance owns the lock, proceed.
// Returns false → another instance holds it, skip.
//
// Acquire conditions (any one):
//   a) value is false/null  (lock is released)
//   b) lockedAt < expireTime (previous holder crashed — stale lock recovery)
// ─────────────────────────────────────────────────────────────────────────────
const acquireLock = async (lockKey, maxAgeMinutes = 30) => {
  const now = new Date();
  const expireTime = new Date(now.getTime() - maxAgeMinutes * 60 * 1000);

  // Atomic findOneAndUpdate — only one process wins this race.
  const result = await AppConfig.findOneAndUpdate(
    {
      key: lockKey,
      $or: [
        { value: false },
        { value: null },
        { "meta.lockedAt": { $lt: expireTime } },
      ],
    },
    {
      $set: {
        value: true,
        "meta.lockedAt": now,
        "meta.instance": INSTANCE_TOKEN,
      },
    },
    { returnDocument: "after", upsert: false },
  );

  if (!result) {
    // Two cases:
    //   1. Document doesn't exist yet (first startup before seed runs)
    //   2. Document exists but is actively locked by another instance
    // The upsert below handles case 1. Case 2 falls through to return false.
    try {
      await AppConfig.findOneAndUpdate(
        { key: lockKey },
        {
          $setOnInsert: {
            key: lockKey,
            value: true,
            description: `Distributed cron lock — ${lockKey}`,
            "meta.lockedAt": now,
            "meta.instance": INSTANCE_TOKEN,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      // Verify we actually own the inserted document.
      const check = await AppConfig.findOne({ key: lockKey }).lean();
      if (check?.meta?.instance === INSTANCE_TOKEN) return true;

      return false;
    } catch (err) {
      if (err?.code !== 11000) {
        logger.warn(
          `[CronLock] Unexpected error acquiring ${lockKey}: ${err.message}`,
        );
      }
      return false;
    }
  }

  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE LOCK
// Always call in finally — even on error/crash path.
// Only releases if this instance owns the lock (prevents releasing a lock
// stolen by another instance during stale lock recovery).
// ─────────────────────────────────────────────────────────────────────────────
const releaseLock = async (lockKey) => {
  await AppConfig.findOneAndUpdate(
    {
      key: lockKey,
      "meta.instance": INSTANCE_TOKEN,
    },
    {
      $set: {
        value: false,
        "meta.releasedAt": new Date(),
        "meta.instance": null,
      },
    },
  );
};

module.exports = { acquireLock, releaseLock, LOCK_KEYS };
