// src/jobs/deficitWarning.job.js
// ─────────────────────────────────────────────────────────────────────────────
// PIGMY COLLECTION DEFICIT WARNING JOB
//
// RUNS: After day-close (10:30 PM IST), following missedDayTracking.job.js
//
// PURPOSE:
//   For every active/overdue loan whose pigmy account is linked (activeLoan),
//   calculate whether the customer is behind on their cumulative pigmy payments.
//
// FORMULA (agreed with client):
//   expected = businessDaysElapsed × pigmyAccount.dailyDepositAmountInPaise
//   actual   = loan.totalPaidInPaise + pigmyAccount.balanceInPaise
//   deficit  = max(0, expected − actual)
//   isDeficient = deficit ≥ pigmyAccount.dailyDepositAmountInPaise
//
// KEY DESIGN DECISIONS:
//   1. Uses (totalPaid + pigmyBalance) as ACTUAL — not totalCollectedInPaise.
//      Reason: applying pigmy to loan moves ₹X from balance→totalPaid, keeping
//      the sum constant. No false alarms on internal transfers.
//   2. Saving→loan repayment increments totalPaidInPaise directly, so it
//      automatically reduces deficit. No snapshot or separate tracking needed.
//   3. businessDaysElapsed increments +1 each cron run (= each business-day close).
//      No calendar math needed. Zero on loan creation. Tied to actual open days.
//
// LIFELINE LIFECYCLE:
//   lifelinesRemaining = MAX (from AppConfig.WARNING_SMS_BEFORE_PENALTY, default 3)
//   Each deficit day: lifelinesRemaining−−, warning SMS sent
//   When lifelinesRemaining = 0: isPenaltyEligible = true, EXHAUSTED SMS sent
//   When deficit clears: consecutive reset, lifelines restored, RESTORED SMS sent
//   Admin can also manually adjust lifelines via PATCH /loans/:id/lifelines
//
// IDEMPOTENCY:
//   lastDeficitWarningDate guards against double-SMS if cron fires twice same day.
//   businessDaysElapsed is always incremented regardless (day must be counted).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const LoanAccount = require("../models/LoanAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const Customer = require("../models/Customer.model");
const logger = require("../utils/logger");
const smsService = require("../utils/sms.service");
const { acquireLock, releaseLock, LOCK_KEYS } = require("../utils/cronLock");
const { startOfDay, endOfDay, toIndianDate } = require("../utils/dateHelpers");
const {
  LOAN_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  CONFIG_KEYS,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PERFORMER — consistent with other cron jobs
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PERFORMER_ID = new mongoose.Types.ObjectId(
  "000000000000000000000000",
);

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — safe integer formatter for SMS (avoids "₹100.00 paise" display)
// ─────────────────────────────────────────────────────────────────────────────
const toRs = (paise) => Math.round(paise / 100).toString();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — IST date key for same-day idempotency guard
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const toISTDateKey = (date) => {
  const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10); // "YYYY-MM-DD"
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB
// ─────────────────────────────────────────────────────────────────────────────
const runDeficitWarningJob = async () => {
  const jobStartTime = Date.now();

  // ── Distributed lock — one instance at a time ─────────────────────────────
  const lockAcquired = await acquireLock(LOCK_KEYS.DEFICIT_WARNING, 30);
  if (!lockAcquired) {
    logger.warn("[DeficitWarningJob] Lock held by another instance. Skipping.");
    return { skipped: true, reason: "lock_held_by_another_instance" };
  }

  logger.info(
    `[DeficitWarningJob] Lock acquired (PID: ${process.pid}). Starting...`,
  );

  try {
    // ── Guard: day must be CLOSED ──────────────────────────────────────────
    const dayStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
    if (dayStatus !== "closed") {
      logger.warn("[DeficitWarningJob] Day is still OPEN. Skipping.");
      return { skipped: true, reason: "day_not_closed" };
    }

    const businessDate = await AppConfig.getCurrentBusinessDate();
    if (!businessDate) {
      logger.warn("[DeficitWarningJob] No business date set. Skipping.");
      return { skipped: true, reason: "no_business_date" };
    }

    // ── IDEMPOTENCY GUARD: Skip if already processed for this business date ──
    // Prevents double-decrement of lifelines and duplicate warning SMS when both
    // the event-driven Day Close trigger AND the scheduled cron fire on the same day.
    const existingAudit = await AuditLog.findOne({
      action: AUDIT_ACTIONS.DEFICIT_WARNING_SENT,
      businessDate: {
        $gte: startOfDay(businessDate),
        $lte: new Date(startOfDay(businessDate).getTime() + 24 * 60 * 60 * 1000 - 1),
      },
      status: AUDIT_STATUS.SUCCESS,
    }).lean();

    if (existingAudit) {
      logger.info(
        `[DeficitWarningJob] Already processed for ${new Date(businessDate).toLocaleDateString("en-IN")}. Skipping (idempotency).`,
      );
      return { skipped: true, reason: "already_processed_for_date" };
    }

    const businessDateKey = toISTDateKey(businessDate);

    // ── Fetch config from AppConfig (set by superadmin) ────────────────────
    const [rawMaxWarnings, rawPenaltyAmtPaise] = await Promise.all([
      AppConfig.getValue(CONFIG_KEYS.WARNING_SMS_BEFORE_PENALTY),
      AppConfig.getValue(CONFIG_KEYS.PENALTY_AMOUNT_PER_MISSED_DAY),
    ]);
    // Default: 3 warnings. Superadmin can change via PUT /api/v1/config
    const maxWarnings = Number(rawMaxWarnings) || 3;
    // Display-only in this job's summary — NOT used for actual penalty calculation.
    // Actual daily penalty computation lives in penaltyAndOverdue.job.js using
    // PENALTY_EXTRA_RATE_BPS and the loan's interestRateBps.
    const penaltyAmtPaise = Number(rawPenaltyAmtPaise) || 10000; // ₹100

    // ── Fetch all ACTIVE/OVERDUE loans with pigmy + customer populated ─────
    // We only process loans where pigmyAccount.activeLoan = this loan's _id
    // (i.e., the pigmy account is actually linked to repay this loan).
    const activeLoans = await LoanAccount.find({
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      disbursedAt: { $lte: endOfDay(new Date(businessDate)) }, // Fix: Do not process loans created after this date
      isDeleted: false,
    })
      .select(
        "_id loanAccountNumber customer pigmyAccount " +
        "totalPaidInPaise businessDaysElapsed consecutiveDeficitDays " +
        "lifelinesRemaining totalWarningsSentCount isPenaltyEligible " +
        "lastDeficitWarningDate",
      )
      .lean();

    if (activeLoans.length === 0) {
      logger.info("[DeficitWarningJob] No active/overdue loans. Nothing to process.");
      return { processed: 0, skipped: 0, warningSent: 0, recovered: 0 };
    }

    // ── Fetch all relevant pigmy accounts in ONE query ─────────────────────
    const pigmyAccountIds = activeLoans
      .map((l) => l.pigmyAccount)
      .filter(Boolean);

    const pigmyAccounts = await PigmyAccount.find({
      _id: { $in: pigmyAccountIds },
      isDeleted: false,
    })
      .select("_id activeLoan balanceInPaise dailyDepositAmountInPaise")
      .lean();

    // Build map: pigmyAccount._id → pigmyAccount (for O(1) lookup)
    const pigmyMap = new Map(
      pigmyAccounts.map((p) => [p._id.toString(), p]),
    );

    // ── Fetch customers for SMS (bulk) ─────────────────────────────────────
    const customerIds = [...new Set(activeLoans.map((l) => l.customer?.toString()).filter(Boolean))];
    const customers = await Customer.find({ _id: { $in: customerIds } })
      .select("_id name phone")
      .lean();
    const customerMap = new Map(customers.map((c) => [c._id.toString(), c]));

    // ── Process each loan ──────────────────────────────────────────────────
    const bulkOps = [];
    const smsQueue = []; // collect SMS tasks, fire after bulk write
    let processedCount = 0;
    let skippedCount = 0;
    let warningSentCount = 0;
    let recoveredCount = 0;

    for (const loan of activeLoans) {
      const pigmyId = loan.pigmyAccount?.toString();
      if (!pigmyId) { skippedCount++; continue; }

      const pigmy = pigmyMap.get(pigmyId);
      if (!pigmy) { skippedCount++; continue; }

      // ── Guard: only pigmy accounts whose activeLoan = THIS loan ──────────
      // Prevents deficit logic running on pigmy accounts shared between loans
      // (which shouldn't happen, but belt-and-suspenders).
      if (pigmy.activeLoan?.toString() !== loan._id.toString()) {
        skippedCount++;
        continue;
      }

      const dailyDepositPaise = pigmy.dailyDepositAmountInPaise;
      if (!dailyDepositPaise || dailyDepositPaise <= 0) {
        skippedCount++;
        continue;
      }

      // businessDaysElapsed is now incremented by missedDayTracking.job.js
      // (runs at 22:00 IST, before this job at 22:30 IST). We read the already-updated
      // value directly from the loan document.
      const currentBusinessDays = loan.businessDaysElapsed || 0;

      // ── Step 2: Calculate deficit ─────────────────────────────────────────
      const expectedPaise = currentBusinessDays * dailyDepositPaise;
      const actualPaise = (loan.totalPaidInPaise || 0) + (pigmy.balanceInPaise || 0);
      const deficitPaise = Math.max(0, expectedPaise - actualPaise);
      const isDeficient = deficitPaise >= dailyDepositPaise;

      const customer = customerMap.get(loan.customer?.toString());
      processedCount++;

      if (!isDeficient) {
        // ── CASE A: Customer ON TRACK ─────────────────────────────────────
        const wasInDeficit = (loan.consecutiveDeficitDays || 0) > 0;
        const lifelinesWereReduced =
          loan.lifelinesRemaining !== null &&
          loan.lifelinesRemaining < maxWarnings;

        const update = {
          $set: {},
        };

        if (loan.consecutiveDeficitDays > 0) {
          update.$set.consecutiveDeficitDays = 0;
        }

        // Restore lifelines if customer had previously been in deficit
        if (lifelinesWereReduced || loan.isPenaltyEligible) {
          update.$set.lifelinesRemaining = maxWarnings;
          update.$set.isPenaltyEligible = false;
          recoveredCount++;

          // Queue LIFELINE_RESTORED SMS
          if (customer?.phone) {
            smsQueue.push({
              type: "RESTORED",
              phone: customer.phone,
              name: customer.name,
              loanNo: loan.loanAccountNumber,
              maxWarnings,
            });
          }
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: loan._id },
            update,
          },
        });
        continue;
      }

      // ── CASE B: Customer BEHIND (isDeficient = true) ─────────────────────
      const newConsecutiveDays = (loan.consecutiveDeficitDays || 0) + 1;

      // Initialize lifelinesRemaining on first-ever deficit
      const currentLifelines =
        loan.lifelinesRemaining === null
          ? maxWarnings
          : loan.lifelinesRemaining;

      // ── Idempotency guard: skip SMS if already warned today ───────────────
      // businessDaysElapsed is always counted (+1 above), but SMS throttled.
      const alreadyWarnedToday =
        loan.lastDeficitWarningDate &&
        toISTDateKey(loan.lastDeficitWarningDate) === businessDateKey;

      const update = {
        $set: {
          consecutiveDeficitDays: newConsecutiveDays,
        },
      };

      if (currentLifelines > 0 && !alreadyWarnedToday) {
        // ── Send warning SMS and decrement lifelines ───────────────────────
        const newLifelines = currentLifelines - 1;
        const warnNum = maxWarnings - newLifelines; // e.g. 3−2=1 (1st warning)

        update.$set.lifelinesRemaining = newLifelines;
        update.$set.lastDeficitWarningDate = new Date(businessDate);
        update.$inc = { totalWarningsSentCount: 1 };

        if (newLifelines === 0) {
          // Last warning — lifelines exhausted
          update.$set.isPenaltyEligible = true;

          if (customer?.phone) {
            smsQueue.push({
              type: "EXHAUSTED",
              phone: customer.phone,
              name: customer.name,
              loanNo: loan.loanAccountNumber,
              maxWarnings,
            });
          }
          logger.info(
            `[DeficitWarningJob] LIFELINES EXHAUSTED | ${loan.loanAccountNumber} | ` +
            `Deficit: ₹${toRs(deficitPaise)} | Day ${newConsecutiveDays}`,
          );
        } else {
          // Normal warning
          if (customer?.phone) {
            smsQueue.push({
              type: "WARNING",
              phone: customer.phone,
              name: customer.name,
              loanNo: loan.loanAccountNumber,
              deficitRs: toRs(deficitPaise),
              dailyRs: toRs(dailyDepositPaise),
              warnNum: String(warnNum),
              maxWarn: String(maxWarnings),
              lifelinesLeft: String(newLifelines),
            });
          }
          logger.info(
            `[DeficitWarningJob] WARNING ${warnNum}/${maxWarnings} | ` +
            `${loan.loanAccountNumber} | Deficit: ₹${toRs(deficitPaise)} | ` +
            `Lifelines left: ${newLifelines}`,
          );
        }
        warningSentCount++;

      } else if (currentLifelines === 0 && !alreadyWarnedToday) {
        // ── Already exhausted — keep flag, no new SMS ─────────────────────
        update.$set.lifelinesRemaining = 0;
        update.$set.isPenaltyEligible = true;
        // Mark as warned today so we don't re-log every run
        update.$set.lastDeficitWarningDate = new Date(businessDate);

      } else {
        // alreadyWarnedToday — just update counters, no SMS
        update.$set.lifelinesRemaining = currentLifelines;
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: loan._id },
          update,
        },
      });
    }

    // ── Execute bulk write ─────────────────────────────────────────────────
    // ordered: false — one loan failure never blocks others
    if (bulkOps.length > 0) {
      await LoanAccount.bulkWrite(bulkOps, { ordered: false });
    }

    // ── Fire SMS queue (non-blocking, non-critical) ────────────────────────
    // All financial writes are committed above. SMS failure must NEVER block.
    for (const sms of smsQueue) {
      try {
        if (sms.type === "WARNING") {
          await smsService.sendCollectionDeficitWarning(
            sms.phone, sms.name, sms.loanNo,
            sms.deficitRs, sms.dailyRs,
            sms.warnNum, sms.maxWarn, sms.lifelinesLeft,
          );
        } else if (sms.type === "EXHAUSTED") {
          await smsService.sendLifelineExhausted(
            sms.phone, sms.name, sms.loanNo, String(sms.maxWarnings),
          );
        } else if (sms.type === "RESTORED") {
          await smsService.sendLifelineRestored(
            sms.phone, sms.name, sms.loanNo, String(sms.maxWarnings),
          );
        }
      } catch (smsErr) {
        logger.error(
          `[DeficitWarningJob] SMS failed | Loan: ${sms.loanNo} | ${smsErr.message}`,
        );
        // continue — SMS failure must not crash the job
      }
    }

    // ── Summary & AuditLog ─────────────────────────────────────────────────
    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    const summary = {
      businessDate: toIndianDate(startOfDay(new Date(businessDate))),
      totalLoansChecked: activeLoans.length,
      processedCount,
      skippedCount,
      warningSentCount,
      recoveredCount,
      bulkOpsWritten: bulkOps.length,
      maxWarningsConfig: maxWarnings,
      penaltyAmtConfig: `₹${toRs(penaltyAmtPaise)}`,
      durationSeconds: elapsed,
    };

    await AuditLog.log({
      performedBy: SYSTEM_PERFORMER_ID,
      action: AUDIT_ACTIONS.DEFICIT_WARNING_SENT,
      entity: "LoanAccount",
      entityId: null,
      newData: summary,
      businessDate,
      status: AUDIT_STATUS.SUCCESS,
    }).catch((e) =>
      logger.error(`[DeficitWarningJob] AuditLog failed: ${e.message}`),
    );

    logger.info(
      `[DeficitWarningJob] Done | ` +
      `Total: ${activeLoans.length} | Processed: ${processedCount} | ` +
      `Warnings: ${warningSentCount} | Recovered: ${recoveredCount} | ` +
      `Duration: ${elapsed}s`,
    );

    return summary;
  } finally {
    await releaseLock(LOCK_KEYS.DEFICIT_WARNING);
    logger.info(`[DeficitWarningJob] 🔓 Lock released (PID: ${process.pid})`);
  }
};

module.exports = { runDeficitWarningJob };
