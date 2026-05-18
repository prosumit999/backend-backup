// src/models/Collection.model.js
"use strict";

const mongoose = require("mongoose");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");
const { COLLECTION_STATUS, COLLECTION_TYPES } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const CollectionSchema = new mongoose.Schema(
  {
    receiptNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    pigmyAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PigmyAccount",
      required: true,
      index: true,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },

    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
      default: null,
    },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Amounts ───────────────────────────────────────────
    amountInPaise: {
      type: Number,
      required: true,
      min: 100,
    },

    balanceAfterInPaise: {
      type: Number,
      required: true,
      min: 0,
    },

    collectionType: {
      type: String,
      enum: Object.values(COLLECTION_TYPES),
      default: COLLECTION_TYPES.DAILY,
    },

    status: {
      type: String,
      enum: Object.values(COLLECTION_STATUS),
      default: COLLECTION_STATUS.COLLECTED,
      index: true,
    },

    // ── Loan Repayment Mapping ─────────────────────────────
    appliedToLoan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanAccount",
      default: null,
    },

    loanRepaymentTxn: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    loanRepaymentAppliedInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    collectionLedgerDebitCode: {
      type: String,
      default: null,
    },

    // ── Dates ─────────────────────────────────────────────
    collectionDate: {
      type: Date,
      required: true,
      index: true,
    },

    businessDate: {
      type: Date,
      required: true,
    },

    recordedAt: {
      type: Date,
      default: Date.now,
    },

    note: {
      type: String,
      default: "",
    },

    idempotencyKey: {
      type: String,
      default: null,
    },

    // ── SMS ───────────────────────────────────────────────
    smsSent: { type: Boolean, default: false },
    smsSentAt: { type: Date, default: null },

    // ── Reversal ──────────────────────────────────────────
    isReversed: {
      type: Boolean,
      default: false,
      index: true,
    },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversedAt: { type: Date, default: null },
    reversalReason: { type: String, default: null },
    reversalTxnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    // ── Transaction link ──────────────────────────────────
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
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
CollectionSchema.index({ agent: 1, collectionDate: -1 });
CollectionSchema.index({ customer: 1, collectionDate: -1 });
CollectionSchema.index({ pigmyAccount: 1, collectionDate: -1 });
CollectionSchema.index({ businessDate: 1 });
CollectionSchema.index({ isReversed: 1, status: 1 });

CollectionSchema.index(
  { pigmyAccount: 1, collectionDate: 1 },
  {
    unique: true,
    partialFilterExpression: { isReversed: false, isDeleted: false },
    name: "unique_pigmy_daily_collection",
  },
);

CollectionSchema.index(
  { agent: 1, collectionDate: -1, isReversed: 1, isDeleted: 1 },
  { name: "agent_daily_sheet" },
);

CollectionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true, name: "unique_idempotency_key" },
);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Same-day duplicate check
// ─────────────────────────────────────────────────────────────────────────────
CollectionSchema.statics.findSameDayCollection = function (
  pigmyAccountId,
  date,
  session // CM-1 FIX: Propagate MongoDB transaction session context
) {
  return this.findOne({
    pigmyAccount: pigmyAccountId,
    collectionDate: {
      $gte: startOfDay(date), // IST midnight in UTC
      $lte: endOfDay(date), // IST 23:59:59 in UTC
    },
    isReversed: false,
    isDeleted: false,
  }).session(session);
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Daily total — used by getDailySummary + dayClose
// Returns { count, totalInPaise, totalRepaidInPaise }
// ─────────────────────────────────────────────────────────────────────────────
CollectionSchema.statics.getDailyTotal = async function (date) {
  const result = await this.aggregate([
    {
      $match: {
        collectionDate: {
          $gte: date,
          $lte: endOfDay(date),
        },
        status: COLLECTION_STATUS.COLLECTED,
        isReversed: false,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalInPaise: { $sum: "$amountInPaise" },
        totalRepaidInPaise: { $sum: "$loanRepaymentAppliedInPaise" },
      },
    },
  ]);

  return {
    count: result[0]?.count ?? 0,
    totalInPaise: result[0]?.totalInPaise ?? 0,
    totalRepaidInPaise: result[0]?.totalRepaidInPaise ?? 0,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
CollectionSchema.methods.markSmsSent = async function () {
  const now = new Date();
  // Write to DB first — never leave in-memory ahead of DB
  await this.updateOne({ $set: { smsSent: true, smsSentAt: now } });
  this.smsSent = true;
  this.smsSentAt = now;
};

module.exports = mongoose.model("Collection", CollectionSchema);
