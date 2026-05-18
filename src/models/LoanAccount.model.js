// src/models/LoanAccount.model.js
// Loan account — created at disbursement, repaid through daily pigmy collections.
// outstandingBalanceInPaise reduces as pigmy collections are applied via loan.service.js
"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { LOAN_STATUS } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const LoanAccountSchema = new mongoose.Schema(
  {
    loanAccountNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true, // kept — useful for customer-only queries without status
    },
    savingAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SavingAccount",
      required: true,
    },
    // Pigmy account whose daily collections repay this loan
    pigmyAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PigmyAccount",
      required: true,
      index: true, // kept — useful for pigmyAccount-only queries without status
    },
    loanPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanPlan",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Disbursement Snapshot ─────────────────────────────────────────────
    // Rates captured at disbursement — plan rate changes don't affect existing loans
    interestRateBps: { type: Number, required: true }, // e.g. 1200 = 12%
    processingFeeBps: { type: Number, required: true }, // e.g. 200  =  2%
    durationMonths: { type: Number, required: true },

    // ── Amounts ───────────────────────────────────────────────────────────
    principalAmountInPaise: { type: Number, required: true, min: 1 },
    interestInPaise: { type: Number, required: true, min: 0 }, // upfront flat
    processingFeeInPaise: { type: Number, required: true, min: 0 },
    netDisbursalInPaise: { type: Number, required: true, min: 1 }, // cash to customer
    // Invariant (enforced in service):
    //   principal = interest + processingFee + netDisbursal

    // ── Live Outstanding ──────────────────────────────────────────────────
    // Starts at principalAmountInPaise.
    // Decreases as pigmy collections are applied (loan.service → applyPigmyToLoan).
    // Increases as penalty is applied (cronJob → penaltyCalculation).
    outstandingBalanceInPaise: { type: Number, required: true, min: 0 },
    totalPaidInPaise: { type: Number, default: 0, min: 0 },

    // ── Penalty (post-tenure) ─────────────────────────────────────────────
    penaltyAmountInPaise: { type: Number, default: 0, min: 0 },
    lastPenaltyAppliedDate: { type: Date, default: null },
    penaltyLastCalculatedDays: { type: Number, default: 0 },
    currentMonthMissedDays: { type: Number, default: 0, min: 0 },
    currentMonthYear: { type: String, default: null }, // "YYYY-MM"
    totalMissedDaysAllTime: { type: Number, default: 0, min: 0 },

    // ── Pigmy Deficit Warning Tracking ────────────────────────────────────────
    //
    // FORMULA (runs in deficitWarning.job.js each day-close):
    //   expected = businessDaysElapsed × pigmyAccount.dailyDepositAmountInPaise
    //   actual   = loan.totalPaidInPaise + pigmyAccount.balanceInPaise
    //   deficit  = max(0, expected − actual)
    //   WARNING  = deficit ≥ dailyDepositAmountInPaise  (behind by ≥1 full day)
    //
    // Key insight: applying pigmy to loan keeps (totalPaid + balance) constant,
    // so no false alarms are triggered by internal fund transfers.
    // Saving→loan repayment increments totalPaidInPaise, reducing deficit
    // automatically without touching pigmy at all.
    //
    // businessDaysElapsed:
    //   How many business days (= day-close events) have passed since disbursedAt.
    //   Incremented ×1 by deficitWarning.job.js each cron run. Never reset.
    businessDaysElapsed: { type: Number, default: 0, min: 0 },

    // consecutiveDeficitDays:
    //   Days in a row the customer has been in deficit (≥1 daily deposit behind).
    //   Reset to 0 when customer catches up (deficit clears).
    consecutiveDeficitDays: { type: Number, default: 0, min: 0 },

    // lifelinesRemaining:
    //   null = not yet initialized (no deficit has occurred yet).
    //   Initialized to MAX_WARNINGS on first deficit day.
    //   Decremented by 1 on each warning SMS sent.
    //   When hits 0 → isPenaltyEligible = true.
    //   Restored to MAX when customer catches up OR admin manually resets.
    lifelinesRemaining: { type: Number, default: null, min: 0 },

    // totalWarningsSentCount:
    //   Lifetime count of warning SMS ever sent for this loan. Never resets.
    totalWarningsSentCount: { type: Number, default: 0, min: 0 },

    // isPenaltyEligible:
    //   true  = admin CAN click "Apply Penalty" in the Deficit Dashboard.
    //   false = Apply Penalty button is disabled.
    //   Set true when lifelinesRemaining reaches 0.
    //   Reset to false after admin applies penalty or manually resets lifelines to >0.
    isPenaltyEligible: { type: Boolean, default: false },

    // lastDeficitWarningDate:
    //   Date of the most recent deficit warning SMS. Prevents double-SMS same day
    //   when cron runs more than once (idempotency guard).
    lastDeficitWarningDate: { type: Date, default: null },

    status: {
      type: String,
      enum: Object.values(LOAN_STATUS),
      default: LOAN_STATUS.ACTIVE,
      index: true, // kept — useful for status-only counts in dashboard
    },

    // ── Lifecycle Timestamps ──────────────────────────────────────────────
    disbursedAt: { type: Date, required: true },
    maturityDate: {
      type: Date,
      required: true,
      // Compound indexes below cover all maturityDate query patterns.
    },

    closedAt: { type: Date, default: null },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    closeNote: { type: String, default: null },

    writtenOffAt: { type: Date, default: null },
    writtenOffBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    writeOffReason: { type: String, default: null },

    businessDate: { type: Date, required: true },
    isDeleted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// PARTIAL UNIQUE INDEX — only one ACTIVE or OVERDUE loan per customer at a time.
// Customer must fully repay before taking a new loan.
LoanAccountSchema.index(
  { customer: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
    },
    name: "unique_active_loan_per_customer",
  },
);

// Standard compound query indexes
LoanAccountSchema.index({ customer: 1, status: 1 });
LoanAccountSchema.index({ pigmyAccount: 1, status: 1 });
LoanAccountSchema.index({ maturityDate: 1, status: 1 }); // penalty cron: date+status
LoanAccountSchema.index({ status: 1, maturityDate: 1 }); // day close: status+date
LoanAccountSchema.index({ businessDate: 1 });
LoanAccountSchema.index({ currentMonthMissedDays: 1, status: 1 }); // penalty dashboard
LoanAccountSchema.index(
  { customer: 1, status: 1, isDeleted: 1 },
  { name: "customer_status_active" },
);
// Deficit warning dashboard queries
LoanAccountSchema.index({ isPenaltyEligible: 1, status: 1 });
LoanAccountSchema.index({ consecutiveDeficitDays: 1, status: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: isOverdue
// Warns if _businessDate is not injected (falls back to wall clock).
// Usage: loan._businessDate = businessDate; return loan;
// ─────────────────────────────────────────────────────────────────────────────
LoanAccountSchema.virtual("isOverdue").get(function () {
  const liveStatuses = [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE];
  if (!liveStatuses.includes(this.status)) return false;
  if (this.outstandingBalanceInPaise <= 0) return false;

  let compareDate;
  if (this._businessDate) {
    compareDate = new Date(this._businessDate);
  } else {

    logger.warn(
      `[LoanAccount.isOverdue] _businessDate not injected for loan ` +
        `${this.loanAccountNumber || this._id}. ` +
        `Falling back to server wall clock — result may be incorrect. ` +
        `Inject loan._businessDate = businessDate before serializing.`,
    );
    compareDate = new Date();
  }

  return compareDate > new Date(this.maturityDate);
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findActiveByCustomer
// ─────────────────────────────────────────────────────────────────────────────
LoanAccountSchema.statics.findActiveByCustomer = function (customerId) {
  return this.findOne({
    customer: customerId,
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
    isDeleted: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findOverdueLoans (used by penalty cron)
// Finds loans that are past maturity AND still active/overdue.
// Includes ACTIVE status as a safety net in case day close missed a transition.
// ─────────────────────────────────────────────────────────────────────────────
LoanAccountSchema.statics.findOverdueLoans = function (businessDate) {
  if (!businessDate) {
    throw new Error(
      "[LoanAccount.findOverdueLoans] businessDate is required — " +
        "never use wall clock for financial queries.",
    );
  }
  return this.find({
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
    maturityDate: { $lt: new Date(businessDate) },
    outstandingBalanceInPaise: { $gt: 0 },
    isDeleted: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findExceededLeaveLoans (used by penalty cron)
// Finds loans whose missed-days count this month exceeded the allowed threshold.
// ─────────────────────────────────────────────────────────────────────────────
LoanAccountSchema.statics.findExceededLeaveLoans = function (maxLeaves) {
  return this.find({
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
    currentMonthMissedDays: { $gt: maxLeaves },
    isDeleted: false,
  });
};

module.exports = mongoose.model("LoanAccount", LoanAccountSchema);
