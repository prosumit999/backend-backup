// src/models/Transaction.model.js
"use strict";

const mongoose = require("mongoose");

const {
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  PAYMENT_MODES,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const TransactionSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
    },

    requestId: {
      type: String,
      default: null,
    },

    idempotencyKey: {
      type: String,
      default: null,
    },

    type: {
      type: String,
      required: true,
      enum: Object.values(TRANSACTION_TYPES),
    },

    // ── Account References (sparse — only relevant ones filled per type) ──
    fromSavingAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SavingAccount",
      default: null,
    },
    toSavingAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SavingAccount",
      default: null,
    },
    fromPigmyAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PigmyAccount",
      default: null,
    },
    toPigmyAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PigmyAccount",
      default: null,
    },
    fromLoanAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanAccount",
      default: null,
    },
    toLoanAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanAccount",
      default: null,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
      sparse: true,
    },

    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amountInPaise: {
      type: Number,
      required: true,
      min: 1,
    },
    feeInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmountInPaise: {
      type: Number,
      required: true,
      min: 0,
    },

    balanceAfterInPaise: {
      type: Number,
      required: true,
      min: 0,
    },
    
    // For transfers bridging two accounts, stores the balance of the receiving/secondary account
    secondaryBalanceAfterInPaise: {
      type: Number,
      default: null,
      min: 0,
    },

    reference: {
      type: String,
      index: true,
      sparse: true,
    },
    note: {
      type: String,
      default: "",
    },

    // ── Payment Details ───────────────────────────────────────────────────
    paymentMode: {
      type: String,
      enum: Object.values(PAYMENT_MODES), // single source of truth — see constants.js
      default: PAYMENT_MODES.CASH,
    },
    utrNumber: {
      type: String,
      default: null,
    },
    chequeNumber: {
      type: String,
      default: null,
    },
    chequeDate: {
      type: Date,
      default: null,
    },
    bankName: {
      type: String, // Which bank the payment hit or was drawn from
      default: null,
    },
    bankLedgerCode: {
      type: String, // The specific GL Account code used (e.g., 1000 for Cash, 1001 for Axis)
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(TRANSACTION_STATUS),
      default: TRANSACTION_STATUS.COMPLETED,
    },

    // ── Reversal ──────────────────────────────────────────────────────────
    isReversed: { type: Boolean, default: false },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversedAt: { type: Date, default: null },
    reversalNote: { type: String, default: null },
    reversalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    businessDate: {
      type: Date,
      required: true,
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
// IMMUTABILITY ENFORCEMENT
// Hard deletion of financial records is not permitted.
// Corrections require a reversal transaction. Use isDeleted:true for soft delete.
// Updates ARE allowed — reversal marking (isReversed, reversedBy, reversedAt)
// requires updateOne. Only hard deletes are blocked.
// ─────────────────────────────────────────────────────────────────────────────
const IMMUTABILITY_ERROR =
  "Transaction records are immutable. " +
  "Hard deletion of financial records is not permitted. " +
  "Use isDeleted:true for soft deletion. " +
  "Corrections require a reversal transaction.";

TransactionSchema.pre(
  ["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove"],
  function () {
    throw new Error(IMMUTABILITY_ERROR);
  },
);

TransactionSchema.pre("bulkWrite", function (next) {
  throw new Error(IMMUTABILITY_ERROR);
});

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
TransactionSchema.index({ customer: 1, businessDate: -1 });
TransactionSchema.index({ agent: 1, businessDate: -1 });
TransactionSchema.index({ type: 1, businessDate: -1 });
TransactionSchema.index({ fromLoanAccount: 1 });
TransactionSchema.index({ fromPigmyAccount: 1 });
TransactionSchema.index({ toPigmyAccount: 1 });
TransactionSchema.index({ requestId: 1 }, { sparse: true });

TransactionSchema.index(
  { idempotencyKey: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "unique_idempotencyKey_type",
  },
);

// Soft-delete safe hot path — getStatement, customer transaction history
TransactionSchema.index(
  { customer: 1, type: 1, businessDate: -1, isDeleted: 1 },
  { name: "customer_type_date_active" },
);

// Agent reconciliation — agent daily transaction report
TransactionSchema.index(
  { agent: 1, type: 1, businessDate: -1, isDeleted: 1 },
  { name: "agent_type_date_active" },
);

const Transaction = mongoose.model("Transaction", TransactionSchema);

module.exports = Transaction;
module.exports.TRANSACTION_STATUS = TRANSACTION_STATUS;
