// src/validators/loan.validator.js
// ─────────────────────────────────────────────────────────────────────────────
// LOAN VALIDATION SCHEMAS

// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Joi = require("joi");
const { LOAN_STATUS } = require("../config/constants");

const objectId = Joi.string()
  .regex(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid MongoDB ObjectId format" });

// ─────────────────────────────────────────────────────────
// REUSABLE — :customerId route param
// Used by:
//   GET /loans/customer/:customerId  (loan.routes.js)
// Validates that the URL param is a valid ObjectId before
// the request reaches the controller/service layer.
// ─────────────────────────────────────────────────────────
const customerIdParamSchema = Joi.object({
  customerId: objectId.required().messages({
    "string.pattern.base": "Invalid customer ID format",
    "any.required": "Customer ID is required",
  }),
});

// ─── LOAN PREVIEW ─────────────────────────────────────────
const loanPreviewSchema = Joi.object({
  principalAmountInPaise: Joi.number().integer().min(100).required().messages({
    "number.min": "Principal amount must be at least ₹1 (100 paise)",
    "any.required": "Principal amount is required",
  }),
  loanPlanId: objectId.required().messages({
    "any.required": "Loan plan ID is required",
  }),
});

// ─── APPLY PENALTY ────────────────────────────────────────
const applyPenaltySchema = Joi.object({
  penaltyAmountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(10_000_000)
    .required()
    .messages({
      "number.min": "Minimum penalty is ₹1 (100 paise)",
      "number.max": "Penalty cannot exceed ₹1,00,000 in a single entry",
      "any.required": "Penalty amount is required",
    }),
  reason: Joi.string().trim().min(5).max(300).required().messages({
    "string.min": "Reason must be at least 5 characters",
    "any.required": "Penalty reason is required",
  }),
});

// ─── CREATE LOAN ──────────────────────────────────────────
const createLoanSchema = Joi.object({
  customerId: objectId
    .required()
    .messages({ "any.required": "Customer ID is required" }),
  loanPlanId: objectId
    .required()
    .messages({ "any.required": "Loan plan ID is required" }),

  principalAmountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(100_000_000)
    .required()
    .messages({
      "number.min": "Principal amount must be a positive value in paise",
      "number.max":
        "Principal amount exceeds absolute system maximum of ₹10,00,000",
      "any.required": "Principal amount is required",
    }),

  requestId: Joi.string().trim().max(100).optional(),
  businessDate: Joi.date().iso().optional(),
});

// ─── CLOSE LOAN ───────────────────────────────────────────
const closeLoanSchema = Joi.object({
  closureReason: Joi.string().trim().min(5).max(300).required().messages({
    "string.min": "Closure reason must be at least 5 characters",
    "any.required": "Closure reason is required",
  }),
  writeOff: Joi.boolean().default(false),
  businessDate: Joi.date().iso().optional(),
});

// ─── REOPEN LOAN (Customer Returns / Reactivation) ────
// Called when a closed or written-off customer returns to resume payments.
const reopenLoanSchema = Joi.object({
  reactivationReason: Joi.string().trim().min(5).max(300).required().messages({
    "string.min": "Reactivation reason must be at least 5 characters",
    "any.required": "Reactivation reason is required — document why this loan is being reopened",
  }),
});

// ─── LIST LOANS QUERY ─────────────────────────────────────
const listLoansSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string()
    .valid(...Object.values(LOAN_STATUS))
    .optional(),
  customerId: objectId.optional(),
});

// ─── APPLY PIGMY TO LOAN ──────────────────────────────────
const applyPigmyToLoanSchema = Joi.object({
  amountInPaise: Joi.number().integer().min(100).required().messages({
    "number.min": "Amount must be at least ₹1 (100 paise)",
    "any.required": "Repayment amount is required",
  }),
  note: Joi.string().trim().max(300).optional(),
  requestId: Joi.string().trim().max(100).optional(),
  businessDate: Joi.date().iso().optional(),
});

// ─── REVERSE REPAYMENT ────────────────────────────────────
const reverseRepaymentSchema = Joi.object({
  transactionId: Joi.string().trim().required().messages({
    "any.required": "Transaction ID is required for reversal",
  }),
  reason: Joi.string().trim().max(500).required().messages({
    "any.required": "A reason for reversal is required",
  }),
});

// ─── RESET LIFELINES (Deficit Warning Management) ────────────────────────────
// resetType:
//   'full'      → restore to AppConfig.WARNING_SMS_BEFORE_PENALTY
//   'increment' → +1 (capped at max)
//   'decrement' → -1 (floored at 0)
//   'set'       → exact value — requires body.value in range [0, max]
const resetLifelinesSchema = Joi.object({
  resetType: Joi.string()
    .valid("full", "increment", "decrement", "set")
    .required()
    .messages({
      "any.only": 'resetType must be one of: full, increment, decrement, set',
      "any.required": "resetType is required",
    }),
  // Required only when resetType = 'set'
  value: Joi.number()
    .integer()
    .min(0)
    .when("resetType", {
      is: "set",
      then: Joi.required().messages({
        "any.required": "value is required when resetType is \"set\"",
      }),
      otherwise: Joi.optional(),
    }),
  reason: Joi.string().trim().max(300).optional(),
});

// ─── DEFICIT DASHBOARD QUERY ─────────────────────────────────────────────────────
const deficitDashboardQuerySchema = Joi.object({
  filter: Joi.string()
    .valid("all", "penalty_eligible", "warning_1", "warning_2")
    .default("all"),
});

module.exports = {
  // Param schemas
  customerIdParamSchema,
  // Operation schemas
  loanPreviewSchema,
  applyPenaltySchema,
  createLoanSchema,
  closeLoanSchema,
  reopenLoanSchema,
  listLoansSchema,
  applyPigmyToLoanSchema,
  reverseRepaymentSchema,
  // Deficit Warning & Lifeline Management
  resetLifelinesSchema,
  deficitDashboardQuerySchema,
};
