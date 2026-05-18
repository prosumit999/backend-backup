// src/models/PigmyAccount.model.js
// Pigmy account — daily collection account managed by assigned agent.
// Linked to a SavingAccount (required) + optional active loan.
"use strict";

const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { ACCOUNT_STATUS } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const PigmyAccountSchema = new mongoose.Schema(
  {
    accountNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },

    // savingAccount is required — must be passed on create (enforced in service)
    savingAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SavingAccount",
      required: true,
      index: true,
    },

    // When a loan is active, applyPigmyToLoan() reduces loan outstanding.
    // null = no active loan linked right now.
    activeLoan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanAccount",
      default: null,
    },

    assignedAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ── Collection Config ──────────────────────────────────────────────────
    dailyDepositAmountInPaise: {
      type: Number,
      required: true,
      min: 100, // Minimum ₹1/day
    },

    collectionFrequency: {
      type: String,
      enum: ["daily", "weekly"],
      default: "daily",
    },

    // ── Running Totals ─────────────────────────────────────────────────────
    balanceInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalCollectedInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalCollectionDays: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastCollectionDate: {
      type: Date,
      default: null,
    },

    // ── Status ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(ACCOUNT_STATUS),
      default: ACCOUNT_STATUS.ACTIVE,
      index: true,
    },

    // ── Lifecycle — Open ──────────────────────────────────────────────────
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    openedAt: {
      type: Date,
      default: null,
    },

    // ── Lifecycle — Close ─────────────────────────────────────────────────
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    closureReason: {
      type: String,
      default: null,
      maxlength: 300,
    },

    // ── Lifecycle — Freeze ────────────────────────────────────────────────
    frozenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    frozenAt: {
      type: Date,
      default: null,
    },

    freezeReason: {
      type: String,
      default: null,
      maxlength: 300,
    },
    // Fields to add (after freezeReason field):
    requiresReassignment: {
      type: Boolean,
      default: false,
    },

    reassignmentReason: {
      type: String,
      enum: ["agent_terminated", "manual"],
      default: null,
    },

    // ── Meta ──────────────────────────────────────────────────────────────
    businessDate: {
      type: Date,
      required: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

PigmyAccountSchema.index(
  { customer: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    },
    name: "unique_active_pigmy_per_customer",
  },
);

// Standard compound query indexes
PigmyAccountSchema.index({ customer: 1, status: 1 });
PigmyAccountSchema.index({ assignedAgent: 1, status: 1 });
PigmyAccountSchema.index({ activeLoan: 1 });
PigmyAccountSchema.index({ businessDate: 1 });
PigmyAccountSchema.index({ lastCollectionDate: 1 });
PigmyAccountSchema.index(
  { lastCollectionDate: 1, status: 1, isDeleted: 1 },
  { name: "missed_collection_scan" }, // used by getMissedCollections query
);
PigmyAccountSchema.index(
  { requiresReassignment: 1, status: 1, isDeleted: 1 },
  { name: "reassignment_queue_scan" },
);

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FIND HOOK: auto-exclude soft-deleted
// Uses options._skipDeletedFilter for consistency with User.model.js pattern.
// Previous pattern (getFilter().isDeleted === undefined) had no bypass mechanism.
// ─────────────────────────────────────────────────────────────────────────────
PigmyAccountSchema.pre(/^find/, function () {
  if (!this.options._skipDeletedFilter) {
    this.where({ isDeleted: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findActiveByCustomer
// ─────────────────────────────────────────────────────────────────────────────
PigmyAccountSchema.statics.findActiveByCustomer = function (customerId) {
  return this.findOne({
    customer: customerId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: assertOperable
// ─────────────────────────────────────────────────────────────────────────────
PigmyAccountSchema.statics.assertOperable = async function (accountId) {
  const account = await this.findById(accountId);

  if (!account) {
    throw new ApiError(404, "Pigmy account not found");
  }
  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    throw new ApiError(
      403,
      `Pigmy account ${account.accountNumber} is ${account.status}. No collections allowed.`,
    );
  }
  return account;
};

module.exports = mongoose.model("PigmyAccount", PigmyAccountSchema);
