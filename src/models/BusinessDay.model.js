// src/models/BusinessDay.model.js
// ─────────────────────────────────────────────────────────────────────────────
// INDUSTRY-STANDARD BANKING: One immutable record per business date.
// Replaces the thin DayClose.model — stores open/close metadata, open mode
// (NORMAL / CORRECTION / CATCHUP), EOD job results, and a full day summary.
//
// IMMUTABILITY RULE (RBI/Banking Standard):
//   Once a BusinessDay is closed (isImmutable = true), no field may be mutated.
//   Any mistake in a closed day must be corrected via a Journal Voucher on the
//   next open day — the historical record must never be changed.
//
// EOD GUARD:
//   BusinessDay.hasEodBeenApplied(date) is called before every catch-up open
//   to prevent double-charging penalties on the same date.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { startOfDay } = require("../utils/dateHelpers");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

// ── EOD JOB RESULT SUB-SCHEMA ──────────────────────────────────────────────
const eodJobResultSchema = new Schema(
  {
    processed: { type: Number, default: 0 },
    penalized: { type: Number, default: 0 },
    markedOverdue: { type: Number, default: 0 },
    warned: { type: Number, default: 0 },
    isBalanced: { type: Boolean },
    differenceInPaise: { type: Number },
    error: { type: String },
  },
  { _id: false }
);

// ── MAIN SCHEMA ───────────────────────────────────────────────────────────
const businessDaySchema = new Schema(
  {
    // ── IDENTITY (one document per business date) ────────────────────────
    businessDate: {
      type: Date,
      required: true,
      unique: true,
      index: true,
    },
    // Pre-computed YYYY-MM-DD string in IST — never run date math on the client
    businessDateFormatted: {
      type: String,
      required: true,
      index: true,
    },

    // ── LIFECYCLE ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
      index: true,
    },

    // ── OPEN METADATA ────────────────────────────────────────────────────
    openedBy: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    openedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // NORMAL    = regular daily open (next calendar date)
    // CORRECTION= superadmin opens past date for ledger corrections — EOD SKIPPED
    // CATCHUP   = superadmin opens genuinely missed past date — EOD RUNS on close
    openMode: {
      type: String,
      enum: ["NORMAL", "CORRECTION", "CATCHUP"],
      required: true,
      default: "NORMAL",
    },

    // ── CLOSE METADATA ───────────────────────────────────────────────────
    closedBy: {
      type: ObjectId,
      ref: "User",
    },
    closedAt: {
      type: Date,
    },
    // Was force-close used to override pre-flight checks?
    isForceClose: {
      type: Boolean,
      default: false,
    },

    // ── EOD STATE — CRITICAL DOUBLE-PENALTY GUARD ────────────────────────
    // PENDING   = day is open, EOD not yet run
    // COMPLETED = all 4 EOD jobs ran (normal day close or catch-up close)
    // PARTIAL   = some EOD jobs ran but one or more failed with errors
    // SKIPPED   = correction backdate — EOD intentionally not run
    eodStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED", "PARTIAL", "SKIPPED"],
      default: "PENDING",
      index: true,
    },
    eodAppliedAt: {
      type: Date,
    },
    // Detailed result of each EOD job — null fields mean job did not run
    eodResults: {
      missedDayTracking: { type: eodJobResultSchema, default: null },
      penaltyAndOverdue: { type: eodJobResultSchema, default: null },
      deficitWarning: { type: eodJobResultSchema, default: null },
      reconcile: { type: eodJobResultSchema, default: null },
    },
    // Human-readable reason why EOD was skipped
    eodSkipReason: {
      type: String,
    },

    // ── DAY SUMMARY SNAPSHOT (written on close) ──────────────────────────
    // Denormalised for fast dashboard queries without hitting multiple collections.
    summary: {
      totalCollectionsCount: { type: Number, default: 0 },
      totalCollectedInPaise: { type: Number, default: 0 },
      totalLoanRepaidInPaise: { type: Number, default: 0 },
      newOverdueLoanCount: { type: Number, default: 0 },
      totalOverdueLoanCount: { type: Number, default: 0 },
      unsettledAgentCount: { type: Number, default: 0 },
      totalUnsettledInPaise: { type: Number, default: 0 },
      // "BALANCED" or "IMBALANCED (force closed)"
      ledgerIntegrity: { type: String },
      ledgerDifferenceInPaise: { type: Number, default: 0 },
    },

    // ── IMMUTABILITY LOCK (set to true on close — never mutated after) ───
    // Pre-save hook below enforces this at the application layer.
    // The unique index on businessDate enforces it at the DB layer.
    isImmutable: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── NOTES ─────────────────────────────────────────────────────────────
    note: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── INDEXES ────────────────────────────────────────────────────────────────
// businessDate DESC for history queries
businessDaySchema.index({ businessDate: -1 });
// Compound: date + status for "is this day open?" check
businessDaySchema.index({ businessDate: 1, status: 1 });
// eodStatus for "has EOD been applied for this date?" guard
businessDaySchema.index({ businessDate: 1, eodStatus: 1 });

// ── PRE-SAVE IMMUTABILITY HOOK ────────────────────────────────────────────
// Called before every .save() — REJECTS writes to closed day records.
// findOneAndUpdate bypasses this hook, so the service uses .save() for close.
businessDaySchema.pre("save", function (next) {
  if (this.isImmutable && !this.isNew) {
    return next(
      new Error(
        `[BusinessDay] IMMUTABILITY VIOLATION: BusinessDay for ` +
        `${this.businessDateFormatted} is closed and locked. ` +
        `Post a Journal Voucher on the next open day to correct any errors.`
      )
    );
  }
  next();
});

// ── STATIC: EOD DOUBLE-CHARGE GUARD ──────────────────────────────────────
// Called before every CATCHUP open. Returns true if EOD already ran for
// this date so the service can auto-downgrade to CORRECTION mode.
businessDaySchema.statics.hasEodBeenApplied = async function (date) {
  const doc = await this.findOne({
    businessDate: startOfDay(new Date(date)),
    eodStatus: { $in: ["COMPLETED", "PARTIAL"] },
  }).lean();
  return !!doc;
};

// ── STATIC: FIND BY DATE ──────────────────────────────────────────────────
businessDaySchema.statics.findByDate = async function (date) {
  return this.findOne({ businessDate: startOfDay(new Date(date)) }).lean();
};

// ── STATIC: GET HISTORY ────────────────────────────────────────────────────
// Returns last N records sorted by businessDate DESC.
// Used by GET /day-control/history and the frontend history panel.
businessDaySchema.statics.getHistory = function (limit = 30) {
  return this
    .find({})
    .sort({ businessDate: -1 })
    .limit(Math.min(limit, 90))
    .populate("openedBy", "name role")
    .populate("closedBy", "name role")
    .lean();
};

// ── STATIC: IS DATE CLOSED (used by transaction guards) ──────────────────
businessDaySchema.statics.isDateClosed = async function (date) {
  const doc = await this.findOne({
    businessDate: startOfDay(new Date(date)),
    status: "CLOSED",
  }).lean();
  return !!doc;
};

module.exports = mongoose.model("BusinessDay", businessDaySchema);
