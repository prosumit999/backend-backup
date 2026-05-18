// src/validators/superadmin.validator.js
"use strict";

const Joi = require("joi");
const {
  LEDGER_ACCOUNT_TYPES,
  AUDIT_STATUS,
  LOAN_DURATIONS,
} = require("../config/constants");

// ─── CREATE ADMIN ─────────────────────────────────────────
const createAdminSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required().messages({
    "string.min": "Name must be at least 2 characters",
    "string.max": "Name cannot exceed 100 characters",
    "any.required": "Name is required",
  }),

  phone: Joi.string()
    .trim()
    .length(10)
    .pattern(/^[6-9]\d{9}$/)
    .required()
    .messages({
      "string.length": "Phone must be exactly 10 digits",
      "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
      "any.required": "Phone is required",
    }),

  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
      "string.max": "Password must not exceed 128 characters",
      "string.pattern.base":
        "Password must contain uppercase, lowercase, number, and special character",
      "any.required": "Password is required",
    }),

  email: Joi.string()
    .trim()
    .email({ tlds: { allow: false } })
    .lowercase()
    .optional()
    .allow(""),
});

// ─── RESET ADMIN PASSWORD ─────────────────────────────────
const resetAdminPasswordSchema = Joi.object({
  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
      "string.max": "Password must not exceed 128 characters",
      "string.pattern.base":
        "Password must contain uppercase, lowercase, number, and special character",
      "any.required": "New password is required",
    }),
});

// ─── TOGGLE ADMIN STATUS ──────────────────────────────────
const toggleAdminStatusSchema = Joi.object({
  isActive: Joi.boolean().required().messages({
    "boolean.base": "isActive must be true or false",
    "any.required": "isActive is required",
  }),
  reason: Joi.string().trim().min(5).max(300).optional(),
});

// ─── TOGGLE SMS ───────────────────────────────────────────

const toggleSmsSchema = Joi.object({
  enabled: Joi.boolean().required().messages({
    "boolean.base": "enabled must be true or false",
    "any.required": "enabled is required",
  }),
});

// ─── UPDATE CONFIG ────────────────────────────────────────
const updateConfigSchema = Joi.object({
  key: Joi.string().trim().required().messages({
    "any.required": "Config key is required",
  }),
  value: Joi.alternatives()
    .try(Joi.boolean(), Joi.number(), Joi.string().trim())
    .required()
    .messages({ "any.required": "Config value is required" }),
}).messages({ "object.min": "key and value are required" });

// ─── CREATE LOAN PLAN ─────────────────────────────────────
const createLoanPlanSchema = Joi.object({
  planName: Joi.string().trim().min(2).max(100).required().messages({
    "any.required": "Plan name is required",
  }),
  description: Joi.string().trim().max(500).optional().allow(""),

  durationMonths: Joi.number()
    .valid(...LOAN_DURATIONS)
    .required()
    .messages({
      "any.only": `Duration must be one of: ${LOAN_DURATIONS.join(", ")} months`,
      "any.required": "Duration is required",
    }),

  baseInterestRateBps: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .required()
    .messages({
      "number.min": "Interest rate must be at least 1 BPS",
      "number.max": "Interest rate cannot exceed 10000 BPS (100%)",
      "any.required": "Base interest rate is required",
    }),
  processingFeeBps: Joi.number()
    .integer()
    .min(0)
    .max(2000)
    .default(200)
    .messages({
      "number.max": "Processing fee cannot exceed 2000 BPS (20%)",
    }),
  minLoanAmountInPaise: Joi.number()
    .integer()
    .min(100)
    .default(100000)
    .messages({
      "number.min": "Minimum loan amount must be at least ₹1",
    }),
  maxLoanAmountInPaise: Joi.number().integer().min(100).required().messages({
    "any.required": "Maximum loan amount is required",
  }),
});

// ─── UPDATE LOAN PLAN ─────────────────────────────────────
const updateLoanPlanSchema = Joi.object({
  planName: Joi.string().trim().min(2).max(100).optional(),
  description: Joi.string().trim().max(500).optional().allow(""),
  baseInterestRateBps: Joi.number().integer().min(1).max(10000).optional(),
  processingFeeBps: Joi.number().integer().min(0).max(2000).optional(),
  minLoanAmountInPaise: Joi.number().integer().min(100).optional(),
  maxLoanAmountInPaise: Joi.number().integer().min(100).optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field must be provided" });

// ─── CREATE LEDGER ACCOUNT ────────────────────────────────
const createLedgerAccountSchema = Joi.object({
  code: Joi.string().trim().min(1).max(20).required().messages({
    "any.required": "Account code is required",
  }),
  name: Joi.string().trim().min(2).max(100).required().messages({
    "any.required": "Account name is required",
  }),
  type: Joi.string()
    .valid(...Object.values(LEDGER_ACCOUNT_TYPES))
    .required()
    .messages({
      "any.only": `Type must be one of: ${Object.values(LEDGER_ACCOUNT_TYPES).join(", ")}`,
      "any.required": "Account type is required",
    }),

  description: Joi.string().trim().max(300).optional().allow(""),
});

// ─── UPDATE LEDGER ACCOUNT ────────────────────────────────
const updateLedgerAccountSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional(),
  description: Joi.string().trim().max(300).optional().allow(""),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field must be provided" });

// ─── AUDIT LOG QUERY ──────────────────────────────────────
const auditLogQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  action: Joi.string().trim().optional(),
  entity: Joi.string().trim().optional(),
  entityId: Joi.string()
    .trim()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      "string.pattern.base": "entityId must be a valid MongoDB ObjectId",
    }),
  performedBy: Joi.string()
    .trim()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional(),
  status: Joi.string()
    .valid(...Object.values(AUDIT_STATUS))
    .optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date()
    .iso()
    .min(Joi.ref("from"))
    .optional()
    .messages({ "date.min": "End date must be after start date" }),
});

module.exports = {
  createAdminSchema,
  resetAdminPasswordSchema,
  toggleAdminStatusSchema,
  toggleSmsSchema,
  updateConfigSchema,
  createLoanPlanSchema,
  updateLoanPlanSchema,
  createLedgerAccountSchema,
  updateLedgerAccountSchema,
  auditLogQuerySchema,
};
