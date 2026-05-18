// src/jobs/penaltyAndOverdue.job.js
// HARDENED:
// 1. Cluster-safe distributed lock — skips if another instance running
// 2. Idempotency check per loan per day — prevents double penalty
// 3. Each loan processed in isolated transaction — one failure never blocks others
// 4. Business date check — skips loans penalized today already
// 5. performedBy uses SYSTEM_PERFORMER_ID sentinel for cron-initiated transactions
"use strict";

const mongoose = require("mongoose");
const LoanAccount = require("../models/LoanAccount.model");
const Transaction = require("../models/Transaction.model");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const { acquireLock, releaseLock, LOCK_KEYS } = require("../utils/cronLock");
const { daysBetween, startOfDay } = require("../utils/dateHelpers");
const {
  calculateDailyPenaltyInterest,
} = require("../utils/interestCalculator");
const { generateTransactionId } = require("../utils/generateCode");
const {
  LOAN_STATUS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  AUDIT_ACTIONS,
  CONFIG_KEYS,
  AUDIT_STATUS,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PERFORMER
// Cron jobs have no human user. We use a reserved all-zeros ObjectId as a
// sentinel "SYSTEM" performer so Transaction.performedBy (required:true) is
// satisfied without creating a real User document.
// Any report/audit query can filter `performedBy = SYSTEM_PERFORMER_ID` to
// identify cron-generated records.
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PERFORMER_ID = new mongoose.Types.ObjectId(
  "000000000000000000000000",
);

const runPenaltyAndOverdueJob = async () => {
  const jobStartTime = Date.now();

  // ── Acquire distributed lock ──────────────────────────────────────────────
  const lockAcquired = await acquireLock(LOCK_KEYS.PENALTY, 60); // 60 min max age
  if (!lockAcquired) {
    logger.warn(
      "[PenaltyJob]  Lock not acquired — another instance is running. Skipping.",
    );
    return { skipped: true, reason: "lock_held_by_another_instance" };
  }

  logger.info(`[PenaltyJob] Lock acquired (PID: ${process.pid}). Starting...`);

  try {
    // ── Validate day is closed before running ─────────────────────────────
    const dayStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
    if (dayStatus !== "closed") {
      logger.warn(
        "[PenaltyJob]  Day is still OPEN. Penalty job requires closed day. Skipping.",
      );
      return { skipped: true, reason: "day_not_closed" };
    }

    // ── Fetch business date — NEVER use wall clock ────────────────────────
    const businessDate = await AppConfig.getCurrentBusinessDate();
    if (!businessDate) {
      logger.error("[PenaltyJob] Business date not configured. Aborting.");
      return { skipped: true, reason: "business_date_not_configured" };
    }

    const businessDateKey = new Date(businessDate).toISOString().slice(0, 10);

    // ── Fetch all overdue loans ───────────────────────────────────────────
    // Uses startOfDay(businessDate) — IST-aware after dateHelpers.js fix
    const loansToProcess = await LoanAccount.find({
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      maturityDate: { $lt: startOfDay(businessDate) },
      outstandingBalanceInPaise: { $gt: 0 },
      isDeleted: false,
    }).lean();

    if (loansToProcess.length === 0) {
      logger.info("[PenaltyJob] No overdue loans found. Job complete.");
      return { processed: 0, skipped: 0, errors: 0, totalPenaltyInPaise: 0 };
    }

    logger.info(
      `[PenaltyJob] Found ${loansToProcess.length} overdue loan(s) to process.`,
    );

    // ── Fetch penalty config once — not per loan ──────────────────────────
    const configs = await AppConfig.getMany([
      CONFIG_KEYS.PENALTY_EXTRA_RATE_BPS,
      CONFIG_KEYS.LATE_PENALTY_EXTRA_BPS,
    ]);
    const penaltyExtraRateBps =
      configs[CONFIG_KEYS.PENALTY_EXTRA_RATE_BPS] || 300;
    const latePenaltyExtraBps =
      configs[CONFIG_KEYS.LATE_PENALTY_EXTRA_BPS] || 500;

    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let totalPenaltyInPaise = 0;

    // ── Process each loan in its own isolated transaction ─────────────────
    for (const loan of loansToProcess) {
      const penaltyRequestId = `CRON-PENALTY-${loan._id.toString()}-${businessDateKey}`;

      try {
        await withTransaction(async (session) => {
          // ── IDEMPOTENCY CHECK (inside session) ───────────────────────
          // Matches the compound unique index: { requestId:1, type:1 }
          const existingPenalty = await Transaction.findOne({
            requestId: penaltyRequestId,
            type: TRANSACTION_TYPES.PENALTY_CHARGE,
          })
            .session(session)
            .lean();

          if (existingPenalty) {
            logger.warn(
              `[PenaltyJob] Duplicate skipped | ` +
              `${loan.loanAccountNumber} | RequestId: ${penaltyRequestId}`,
            );
            skippedCount++;
            return;
          }

          // ── Re-read loan inside session ──────────────────────────────
          // Gets latest outstanding (could have changed since outer query)
          const freshLoan = await LoanAccount.findById(loan._id)
            .session(session)
            .lean();

          if (
            !freshLoan ||
            freshLoan.outstandingBalanceInPaise <= 0 ||
            freshLoan.status === LOAN_STATUS.CLOSED ||
            freshLoan.status === LOAN_STATUS.WRITTEN_OFF
          ) {
            logger.info(
              `[PenaltyJob] ${loan.loanAccountNumber} no longer eligible. Skipping.`,
            );
            skippedCount++;
            return;
          }

          // ── Calculate penalty ────────────────────────────────────────
          // daysBetween uses IST-normalized startOfDay internally
          const daysOverdue = daysBetween(freshLoan.maturityDate, businessDate);
          const effectivePenaltyExtra =
            daysOverdue >= 90 ? latePenaltyExtraBps : penaltyExtraRateBps;

          const dailyPenaltyInPaise = calculateDailyPenaltyInterest({
            outstandingInPaise: freshLoan.outstandingBalanceInPaise,
            baseRateBps: freshLoan.interestRateBps,
            penaltyExtraRateBps: effectivePenaltyExtra,
          });

          if (dailyPenaltyInPaise === 0) {
            logger.warn(
              `[PenaltyJob] ${loan.loanAccountNumber}: penalty rounds to 0. ` +
              `Outstanding: ${freshLoan.outstandingBalanceInPaise} paise. Skipping.`,
            );
            skippedCount++;
            return;
          }

          // ── Step 1: Create Transaction record ────────────────────────
          const [penaltyTxn] = await Transaction.create(
            [
              {
                transactionId: await generateTransactionId(businessDate),
                requestId: penaltyRequestId,
                type: TRANSACTION_TYPES.PENALTY_CHARGE,
                toLoanAccount: freshLoan._id,
                customer: freshLoan.customer,
                performedBy: SYSTEM_PERFORMER_ID,
                amountInPaise: dailyPenaltyInPaise,
                feeInPaise: dailyPenaltyInPaise,
                netAmountInPaise: dailyPenaltyInPaise,
                balanceAfterInPaise:
                  freshLoan.outstandingBalanceInPaise + dailyPenaltyInPaise,
                reference: freshLoan.loanAccountNumber,
                note:
                  `Daily overdue penalty — Day ${daysOverdue} | ` +
                  `Rate: ${((freshLoan.interestRateBps + effectivePenaltyExtra) / 100).toFixed(1)}% p.a.`,
                status: TRANSACTION_STATUS.COMPLETED,
                businessDate,
              },
            ],
            { session },
          );

          // ── Step 2: Post double-entry ledger ─────────────────────────
          // DR Loans Receivable | CR Penalty Interest Income
          await ledger.recordPenaltyCharge({
            amountInPaise: dailyPenaltyInPaise,
            transaction: penaltyTxn._id,
            transactionRef: penaltyRequestId,
            performedBy: SYSTEM_PERFORMER_ID,
            requestId: penaltyRequestId,
            businessDate,
            session,
          });

          // ── Step 3: Atomic update on loan ────────────────────────────
          await LoanAccount.findByIdAndUpdate(
            freshLoan._id,
            {
              $inc: {
                outstandingBalanceInPaise: +dailyPenaltyInPaise,
                penaltyAmountInPaise: +dailyPenaltyInPaise,
              },
              $set: {
                status: LOAN_STATUS.OVERDUE,
                lastPenaltyAppliedDate: businessDate,
              },
            },
            { session },
          );

          totalPenaltyInPaise += dailyPenaltyInPaise;
          processedCount++;

          logger.info(
            `[PenaltyJob]  ${freshLoan.loanAccountNumber} | ` +
            `Day ${daysOverdue} | ` +
            `Penalty: ₹${(dailyPenaltyInPaise / 100).toFixed(2)}`,
          );
        });
      } catch (err) {
        errorCount++;
        logger.error(
          `[PenaltyJob]  FAILED | ${loan.loanAccountNumber} | ${err.message}`,
        );
        // Intentionally continue — one loan failure must not block others
      }
    }

    // ── Job summary ───────────────────────────────────────────────────────
    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    const summary = {
      processedLoans: processedCount,
      skippedLoans: skippedCount,
      errors: errorCount,
      totalPenaltyInPaise,
      totalPenaltyDisplay: `₹${(totalPenaltyInPaise / 100).toFixed(2)}`,
      durationSeconds: elapsed,
      businessDate,
    };

    await AuditLog.log({
      performedBy: SYSTEM_PERFORMER_ID,
      action: AUDIT_ACTIONS.PENALTY_APPLIED,
      entity: "LoanAccount",
      entityId: null,
      newData: summary,
      businessDate,
      status: errorCount > 0 ? AUDIT_STATUS.FAILURE : AUDIT_STATUS.SUCCESS,
      errorMessage: errorCount > 0 ? `${errorCount} loans failed` : null,
    }).catch((e) => logger.error(`[PenaltyJob] AuditLog failed: ${e.message}`));

    logger.info(
      `[PenaltyJob] Complete | ` +
      `Processed: ${processedCount} | ` +
      ` Skipped: ${skippedCount} | ` +
      ` Errors: ${errorCount} | ` +
      `Total: ₹${(totalPenaltyInPaise / 100).toFixed(2)} | ` +
      `Duration: ${elapsed}s`,
    );

    return summary;
  } finally {
    await releaseLock(LOCK_KEYS.PENALTY);
    logger.info(`[PenaltyJob] 🔓 Lock released (PID: ${process.pid})`);
  }
};

module.exports = { runPenaltyAndOverdueJob };
