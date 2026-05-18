// src/validators/report.validator.js
"use strict";

const Joi = require("joi");
const { KYC_STATUS } = require("../config/constants");

const objectId = Joi.string()
  .regex(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

// ─── Reusable date range block ────────────────────────────
// Spread into schemas that need fromDate + toDate.
// toDate.min(Joi.ref('fromDate')) ensures end is never before start.
const dateRange = {
  fromDate: Joi.date().iso().optional(),
  toDate: Joi.date()
    .iso()
    .min(Joi.ref("fromDate"))
    .optional()
    .messages({ "date.min": "toDate must be after fromDate" }),
};

// ─── COLLECTION REPORT ───────────────────────────────────
const collectionReportSchema = Joi.object({
  ...dateRange,
  agentId: objectId.optional(),
});

// ─── AGENT PERFORMANCE ───────────────────────────────────
const agentPerformanceSchema = Joi.object({
  ...dateRange,
});

// ─── OVERDUE REPORT ──────────────────────────────────────
const overdueReportSchema = Joi.object({
  agentId: objectId.optional(),
});

// ─── TRIAL BALANCE ───────────────────────────────────────
const trialBalanceSchema = Joi.object({
  asOfDate: Joi.date()
    .iso()
    .max("now")
    .optional()
    .messages({ "date.max": "asOfDate cannot be in the future" }),
});

// ─── P&L REPORT ──────────────────────────────────────────
const pnlReportSchema = Joi.object({
  ...dateRange,
});

// ─── CUSTOMER REPORT ─────────────────────────────────────
const customerReportSchema = Joi.object({
  ...dateRange,
  kycStatus: Joi.string()
    .valid(...Object.values(KYC_STATUS))
    .optional()
    .messages({
      "any.only": `kycStatus must be one of: ${Object.values(KYC_STATUS).join(", ")}`,
    }),
  assignedAgent: objectId.optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

// ─── DAILY TRANSACTION REPORT ─────────────────────────────
const dailyTransactionReportSchema = Joi.object({
  date: Joi.date().iso().optional(),
  type: Joi.string().optional(), // TRANSACTION_TYPES
});

// ─── LEDGER HISTORY ───────────────────────────────────────
const ledgerHistorySchema = Joi.object({
  ...dateRange,
  ledgerCode: Joi.string().required().messages({
    "any.required": "Ledger account code is required",
  }),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
});

module.exports = {
  collectionReportSchema,
  agentPerformanceSchema,
  overdueReportSchema,
  trialBalanceSchema,
  pnlReportSchema,
  customerReportSchema,
  dailyTransactionReportSchema,
  ledgerHistorySchema,
};
