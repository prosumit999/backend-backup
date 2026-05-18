// src/jobs/reconcile.job.js
// HARDENED:
// 1. Cluster-safe distributed lock
// 2. Auto system lock on mismatch (blocks next day open until admin resolves)
// 3. Detailed per-account mismatch reporting
"use strict";

const LedgerAccount = require("../models/LedgerAccount.model");
const LedgerEntry = require("../models/LedgerEntry.model");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const logger = require("../utils/logger");
const { acquireLock, releaseLock, LOCK_KEYS } = require("../utils/cronLock");
const { AUDIT_ACTIONS, CONFIG_KEYS } = require("../config/constants");

// P2-MED-3: System performer sentinel — consistent with penaltyAndOverdue.job.js
const mongoose = require("mongoose");
const SYSTEM_PERFORMER_ID = new mongoose.Types.ObjectId("000000000000000000000000");

const runReconcileJob = async () => {
  const jobStartTime = Date.now();

  // ── Acquire distributed lock ──────────────────────────
  const lockAcquired = await acquireLock(LOCK_KEYS.RECONCILE, 60);
  if (!lockAcquired) {
    logger.warn("[Reconcile] Lock held by another instance. Skipping.");
    return { skipped: true, reason: "lock_held_by_another_instance" };
  }

  logger.info(`[Reconcile] Lock acquired (PID: ${process.pid}). Starting...`);

  try {
    const businessDate = await AppConfig.getCurrentBusinessDate();

    // ── Step 1: Aggregate ALL entries per ledger account ──
    const entryAggregates = await LedgerEntry.aggregate([
      {
        $group: {
          _id: "$ledgerAccount",
          sumDebits: {
            $sum: "$debitInPaise",
          },
          sumCredits: {
            $sum: "$creditInPaise",
          },
        },
      },
    ]);

    const entryMap = Object.fromEntries(
      entryAggregates.map((e) => [e._id.toString(), e]),
    );

    // ── Step 2: Compare against stored running balances ──
    const accounts = await LedgerAccount.find({ isActive: true }).lean();

    const mismatches = [];
    const passedCodes = [];

    for (const account of accounts) {
      const entries = entryMap[account._id.toString()] || {
        sumDebits: 0,
        sumCredits: 0,
      };

      const computedBalance =
        account.normalBalance === "debit"
          ? entries.sumDebits - entries.sumCredits
          : entries.sumCredits - entries.sumDebits;

      const stored = account.runningBalanceInPaise;
      const difference = computedBalance - stored;

      if (difference !== 0) {
        mismatches.push({
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          storedBalance: stored,
          computedBalance,
          differenceInPaise: Math.abs(difference),
          direction:
            difference > 0 ? "stored_understated" : "stored_overstated",
        });
      } else {
        passedCodes.push(account.code);
      }
    }

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    const isClean = mismatches.length === 0;

    const summary = {
      businessDate,
      totalAccounts: accounts.length,
      cleanAccounts: passedCodes.length,
      mismatchedAccounts: mismatches.length,
      mismatches,
      durationSeconds: elapsed,
    };

    if (isClean) {
      // ── All balanced ──────────────────────────────────
      logger.info(
        `[Reconcile] ✅ ALL BALANCED | ` +
          `Accounts: ${accounts.length} | Duration: ${elapsed}s`,
      );

      await AuditLog.log({
        performedBy: SYSTEM_PERFORMER_ID,
        action: AUDIT_ACTIONS.RECONCILE_PASSED,
        entity: "LedgerAccount",
        entityId: null,
        newData: summary,
        businessDate,
        status: "success",
      }).catch((e) =>
        logger.error(`[Reconcile] AuditLog failed: ${e.message}`),
      );
    } else {
      // ── CRITICAL: Mismatches detected ─────────────────
      logger.error(
        `[Reconcile] ❌ BALANCE MISMATCHES DETECTED (${
          mismatches.length
        } accounts):`,
      );
      mismatches.forEach((m) => {
        logger.error(
          `  ❌ [${m.accountCode}] ${m.accountName} | ` +
            `Stored: ₹${(m.storedBalance / 100).toFixed(2)} | ` +
            `Computed: ₹${(m.computedBalance / 100).toFixed(2)} | ` +
            `Diff: ₹${(m.differenceInPaise / 100).toFixed(2)} (${m.direction})`,
        );
      });

      // ── AUTO SYSTEM LOCK ──────────────────────────────
      // Prevents admin from opening day until mismatch is manually resolved
      // Admin must either:
      // a) Fix the root cause of mismatch
      // b) Superadmin unlocks via AppConfig.setValue(SYSTEM_LOCKED, false)
      await AppConfig.setValue(CONFIG_KEYS.SYSTEM_LOCKED, true, SYSTEM_PERFORMER_ID);
      logger.error(
        "[Reconcile] 🔒 SYSTEM LOCKED automatically. " +
          "Admin cannot open next day until mismatch is resolved. " +
          "Superadmin must unlock after investigation.",
      );

      await AuditLog.log({
        performedBy: SYSTEM_PERFORMER_ID,
        action: AUDIT_ACTIONS.RECONCILE_FAILED,
        entity: "LedgerAccount",
        entityId: null,
        newData: summary,
        businessDate,
        status: "failure",
        errorMessage: `${
          mismatches.length
        } ledger account balance mismatches. System auto-locked.`,
      }).catch((e) =>
        logger.error(`[Reconcile] AuditLog failed: ${e.message}`),
      );

      await AuditLog.log({
        performedBy: SYSTEM_PERFORMER_ID,
        action: AUDIT_ACTIONS.SYSTEM_LOCKED,
        entity: "AppConfig",
        entityId: null,
        newData: {
          reason: "Reconcile mismatch",
          mismatches,
        },
        businessDate,
        status: "success",
      }).catch((e) =>
        logger.error(`[Reconcile] SystemLock AuditLog failed: ${e.message}`),
      );
    }

    return summary;
  } finally {
    await releaseLock(LOCK_KEYS.RECONCILE);
    logger.info(`[Reconcile] 🔓 Lock released (PID: ${process.pid})`);
  }
};

module.exports = {
  runReconcileJob,
};
