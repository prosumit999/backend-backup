// src/jobs/missedDayTracking.job.js
"use strict";

const mongoose = require("mongoose");
const LoanAccount = require("../models/LoanAccount.model");
const Collection = require("../models/Collection.model");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const logger = require("../utils/logger");
const { acquireLock, releaseLock, LOCK_KEYS } = require("../utils/cronLock");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");
const {
  LOAN_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  COLLECTION_STATUS,
  CONFIG_KEYS,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PERFORMER — same sentinel used in penaltyAndOverdue.job.js
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PERFORMER_ID = new mongoose.Types.ObjectId(
  "000000000000000000000000",
);

// ─────────────────────────────────────────────────────────────────────────────
// IST-AWARE MONTH KEY
// Using bDate.getMonth() on UTC server returns February (wrong).
// Must shift to IST first, then extract year/month.
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const getISTMonthKey = (date) => {
  const istDate = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`; // e.g. "2026-03"
};

// ─────────────────────────────────────────────────────────────────────────────
const runMissedDayTrackingJob = async () => {
  const jobStartTime = Date.now();

  // ── Distributed lock — one instance at a time ─────────────────────────────
  const lockAcquired = await acquireLock(LOCK_KEYS.MISSED_DAY_TRACKING, 30);
  if (!lockAcquired) {
    logger.warn("[MissedDayJob] Lock held by another instance. Skipping.");
    return { skipped: true, reason: "lock_held_by_another_instance" };
  }

  logger.info(
    `[MissedDayJob] Lock acquired (PID: ${process.pid}). Starting...`,
  );

  try {
    // ── Guard: day must be closed ─────────────────────────────────────────
    const dayStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
    if (dayStatus !== "closed") {
      logger.warn("[MissedDayJob] Day is still OPEN. Skipping.");
      return { skipped: true, reason: "day_not_closed" };
    }

    const businessDate = await AppConfig.getCurrentBusinessDate();
    if (!businessDate) {
      logger.warn("[MissedDayJob] No business date set. Skipping.");
      return { skipped: true, reason: "no_business_date" };
    }

    // ── IDEMPOTENCY GUARD: Skip if already tracked for this business date ───
    // This prevents double-increment of missed-day counters when both the
    // event-driven Day Close trigger AND the scheduled cron fire on the same day,
    // or when a backdated day is closed multiple times.
    const existingAudit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.MISSED_DAY_TRACKED,
      businessDate: {
        $gte: startOfDay(businessDate),
        $lte: endOfDay(businessDate),
      },
      status: AUDIT_STATUS.SUCCESS,
    }).lean();

    if (existingAudit) {
      logger.info(
        `[MissedDayJob] Already tracked for ${new Date(businessDate).toLocaleDateString("en-IN")}. Skipping (idempotency).`,
      );
      return { skipped: true, reason: "already_tracked_for_date" };
    }

    const monthKey = getISTMonthKey(businessDate);

    // ── Step 1: Pigmy accounts with valid collection today ────────────────
    // IST-aware startOfDay/endOfDay used (fixed in dateHelpers.js Round 1)
    const collectedPigmyIds = await Collection.find({
      collectionDate: {
        $gte: startOfDay(businessDate),
        $lte: endOfDay(businessDate),
      },
      status: COLLECTION_STATUS.COLLECTED,
      isReversed: false,
      isDeleted: false,
    }).distinct("pigmyAccount");

    const collectedSet = new Set(collectedPigmyIds.map((id) => id.toString()));

    // ── Step 2: All live loans ────────────────────────────────────────────
    const activeLoans = await LoanAccount.find({
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      disbursedAt: { $lte: endOfDay(businessDate) },
      isDeleted: false,
    })
      .select(
        "_id pigmyAccount currentMonthMissedDays currentMonthYear " +
        "totalMissedDaysAllTime loanAccountNumber",
      )
      .lean();

    if (activeLoans.length === 0) {
      logger.info("[MissedDayJob] No active/overdue loans. Nothing to track.");
      return { tracked: 0, missed: 0, present: 0 };
    }

    // ── Step 3: Build bulk write ops ──────────────────────────────────────
    const bulkOps = [];
    let missedCount = 0;
    let presentCount = 0;

    for (const loan of activeLoans) {
      const pigmyId = loan.pigmyAccount?.toString();
      const hadCollection = pigmyId && collectedSet.has(pigmyId);
      const isNewMonth = loan.currentMonthYear !== monthKey;

      if (hadCollection) {
        presentCount++;
        if (isNewMonth) {
          // Month rolled over + collection present: reset missed counter + count business day
          bulkOps.push({
            updateOne: {
              filter: { _id: loan._id },
              update: {
                $set: {
                  currentMonthMissedDays: 0,
                  currentMonthYear: monthKey,
                },

                $inc: { businessDaysElapsed: 1 },
              },
            },
          });
        } else {
          // Same month + collection present: only increment business days
          bulkOps.push({
            updateOne: {
              filter: { _id: loan._id },
              update: {
                $inc: { businessDaysElapsed: 1 },
              },
            },
          });
        }
        continue;
      }

      // Missed today
      missedCount++;

      if (isNewMonth) {
        // First miss of new month — reset counter to 1 (don't accumulate Feb into Mar)
        bulkOps.push({
          updateOne: {
            filter: { _id: loan._id },
            update: {
              $set: {
                currentMonthMissedDays: 1,
                currentMonthYear: monthKey,
              },
              $inc: { totalMissedDaysAllTime: 1, businessDaysElapsed: 1 },
            },
          },
        });
      } else {
        // Same month — increment both
        bulkOps.push({
          updateOne: {
            filter: { _id: loan._id },
            update: {
              $inc: {
                currentMonthMissedDays: 1,
                totalMissedDaysAllTime: 1,
                businessDaysElapsed: 1,
              },
            },
          },
        });
      }
    }

    // ── Step 4: Execute bulk write ────────────────────────────────────────
    // ordered:false → one loan failure doesn't block the rest
    if (bulkOps.length > 0) {
      await LoanAccount.bulkWrite(bulkOps, { ordered: false });
    }

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    const summary = {
      businessDate,
      monthKey,
      totalLoansTracked: activeLoans.length,
      presentToday: presentCount,
      missedToday: missedCount,
      bulkOpsWritten: bulkOps.length,
      durationSeconds: elapsed,
    };

    await AuditLog.log({
      performedBy: SYSTEM_PERFORMER_ID,
      action: AUDIT_ACTIONS.MISSED_DAY_TRACKED,
      entity: "LoanAccount",
      entityId: null,
      newData: summary,
      businessDate,
      status: AUDIT_STATUS.SUCCESS,
    }).catch((e) =>
      logger.error(`[MissedDayJob] AuditLog failed: ${e.message}`),
    );

    logger.info(
      `[MissedDayJob] Done | Month: ${monthKey} | ` +
      `Total: ${activeLoans.length} | Present: ${presentCount} | ` +
      `Missed: ${missedCount} | Duration: ${elapsed}s`,
    );

    return summary;
  } finally {
    await releaseLock(LOCK_KEYS.MISSED_DAY_TRACKING);
    logger.info(`[MissedDayJob] 🔓 Lock released (PID: ${process.pid})`);
  }
};

module.exports = { runMissedDayTrackingJob };
