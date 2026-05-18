// src/models/LoanPlan.model.js
// Loan plan templates — superadmin creates these, loans are disbursed under a plan.
// NO EMI logic — flat rate interest deducted upfront at disbursement.
"use strict";

const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const { LOAN_DURATIONS } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const LoanPlanSchema = new mongoose.Schema(
  {
    planCode: {
      type: String,
      required: true,
      unique: true,
      // unique: true already creates a B-tree index internally.
      trim: true,
    },
    planName: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    durationMonths: {
      type: Number,
      required: true,
      enum: LOAN_DURATIONS, // [3, 6, 12, 18, 24]
    },

    // ── Rates (stored as BPS — never % strings) ───────
    baseInterestRateBps: {
      type: Number,
      required: true,
      min: [1, "Interest rate must be at least 1 bps"],
      // Cannot be zero interest. 12% = 1200 bps.
    },
    processingFeeBps: {
      type: Number,
      default: 200, // 2% default
      min: [0, "Processing fee cannot be negative"],
    },

    // ── Loan Amount Limits ─────────────────────────────
    minLoanAmountInPaise: {
      type: Number,
      default: 100000, // ₹1,000 minimum
      min: [100, "Minimum loan amount must be at least ₹1 (100 paise)"],
    },
    maxLoanAmountInPaise: {
      type: Number,
      default: 10000000, // ₹1,00,000 maximum
      // Added min validator.
      // Previously had no min — could be set to 0 or negative.
      // Min 200 paise (₹2) ensures max is always above the absolute floor.
      min: [200, "Maximum loan amount must be at least ₹2 (200 paise)"],
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
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
// VALIDATION HELPER
// ─────────────────────────────────────────────────────────────────────────────
LoanPlanSchema.statics.validateAmountLimits = function (
  updates,
  existingDoc = {},
) {
  const min =
    updates.minLoanAmountInPaise ?? existingDoc.minLoanAmountInPaise ?? 100000;
  const max =
    updates.maxLoanAmountInPaise ??
    existingDoc.maxLoanAmountInPaise ??
    10000000;

  if (min >= max) {
    throw new ApiError(
      400,
      `minLoanAmountInPaise (₹${(min / 100).toFixed(0)}) must be less than ` +
        `maxLoanAmountInPaise (₹${(max / 100).toFixed(0)}).`,
    );
  }
};

// PRE-SAVE: delegate to the shared static validator

LoanPlanSchema.pre("save", function () {
  this.constructor.validateAmountLimits(
    {
      minLoanAmountInPaise: this.minLoanAmountInPaise,
      maxLoanAmountInPaise: this.maxLoanAmountInPaise,
    },
    {},
  );
});

module.exports = mongoose.model("LoanPlan", LoanPlanSchema);
