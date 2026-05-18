// src/models/SavingAccount.model.js
// Saving account — required before any Pigmy or Loan account can be opened.
"use strict";

const mongoose = require("mongoose");
const { ACCOUNT_STATUS } = require("../config/constants");
const ApiError = require("../utils/ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const SavingAccountSchema = new mongoose.Schema(
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
    assignedAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ── Balance ───────────────────────────────────────────
    balanceInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Opening Charge (one-time, collected as cash) ──────
    openingChargeInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    openingChargeDeducted: {
      type: Boolean,
      default: false,
    },
    openingChargeDeductedAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(ACCOUNT_STATUS),
      default: ACCOUNT_STATUS.ACTIVE,
      index: true,
    },

    // ── Lifecycle ─────────────────────────────────────────
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    openedAt: {
      type: Date,
      default: null,
    },

    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    closedAt: { type: Date, default: null },
    closureReason: { type: String, default: null },

    frozenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    frozenAt: { type: Date, default: null },
    freezeReason: { type: String, default: null },

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
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// PARTIAL UNIQUE INDEX — only ONE active saving account per customer at a time.
// Keeps partial index expression in sync with the enum constant automatically.
SavingAccountSchema.index(
  { customer: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    },
    name: "unique_active_saving_per_customer",
  },
);

// Standard compound query indexes
SavingAccountSchema.index({ customer: 1, status: 1 });
SavingAccountSchema.index({ assignedAgent: 1, status: 1 });
SavingAccountSchema.index({ businessDate: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FIND HOOK: auto-exclude soft-deleted
// ─────────────────────────────────────────────────────────────────────────────
SavingAccountSchema.pre(/^find/, function () {
  if (!this.options._skipDeletedFilter) {
    this.where({ isDeleted: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────
SavingAccountSchema.virtual("balanceInRupees").get(function () {
  return parseFloat((this.balanceInPaise / 100).toFixed(2));
});

SavingAccountSchema.virtual("openingChargeInRupees").get(function () {
  return parseFloat((this.openingChargeInPaise / 100).toFixed(2));
});

// ─────────────────────────────────────────────────────────────────────────────
// STATICS
// ─────────────────────────────────────────────────────────────────────────────
SavingAccountSchema.statics.findActiveByCustomer = function (customerId) {
  return this.findOne({
    customer: customerId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: assertOperable
// ─────────────────────────────────────────────────────────────────────────────
SavingAccountSchema.statics.assertOperable = async function (accountId) {
  const account = await this.findById(accountId);

  if (!account) {
    throw new ApiError(404, "Saving account not found");
  }

  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    const statusMessages = {
      [ACCOUNT_STATUS.FROZEN]: `Saving account ${account.accountNumber} is frozen. Contact admin.`,
      [ACCOUNT_STATUS.CLOSED]: `Saving account ${account.accountNumber} is closed. No transactions allowed.`,
    };
    throw new ApiError(
      account.status === ACCOUNT_STATUS.CLOSED ? 400 : 403,
      statusMessages[account.status] ??
        `Saving account ${account.accountNumber} is ${account.status}. No transactions allowed.`,
    );
  }

  return account;
};

module.exports = mongoose.model("SavingAccount", SavingAccountSchema);
