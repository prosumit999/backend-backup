// src/validators/ledger.validator.js
// ─────────────────────────────────────────────────────────────────────────────
// Joi validation schemas for all ledger API endpoints.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Joi = require("joi");

// ─── ACCOUNT STATEMENT ────────────────────────────────────────────────────────
// GET /ledger/accounts/:id/statement?fromDate=&toDate=&page=&limit=
const accountStatementSchema = Joi.object({
  fromDate: Joi.date().iso().required().messages({
    "any.required": "fromDate is required (ISO 8601: YYYY-MM-DD)",
    "date.base": "fromDate must be a valid date",
  }),
  toDate: Joi.date().iso().min(Joi.ref("fromDate")).required().messages({
    "any.required": "toDate is required (ISO 8601: YYYY-MM-DD)",
    "date.min": "toDate must be on or after fromDate",
  }),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(100),
});

// ─── LEDGER JOURNAL (all entries) ────────────────────────────────────────────
// GET /ledger/journal?fromDate=&toDate=&page=&limit=&entryType=&ledgerCode=
const ledgerJournalQuerySchema = Joi.object({
  fromDate: Joi.date().iso().required().messages({
    "any.required": "fromDate is required",
  }),
  toDate: Joi.date().iso().min(Joi.ref("fromDate")).required().messages({
    "any.required": "toDate is required",
    "date.min": "toDate must be on or after fromDate",
  }),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(100),
  entryType: Joi.string().valid("debit", "credit").optional(),
  ledgerCode: Joi.string().trim().optional(), // filter by account code e.g. "1001"
});

// ─── JOURNAL VOUCHER ─────────────────────────────────────────────────────────
// POST /ledger/journal-voucher
// A manual multi-leg entry for adjustments. DR total must === CR total.
const journalVoucherSchema = Joi.object({
  narration: Joi.string().trim().min(10).max(500).required().messages({
    "string.min": "Narration must be at least 10 characters — be specific about the reason",
    "string.max": "Narration cannot exceed 500 characters",
    "any.required": "Narration is mandatory for every Journal Voucher",
  }),
  entries: Joi.array()
    .items(
      Joi.object({
        ledgerCode: Joi.string().trim().required().messages({
          "any.required": "ledgerCode is required for each entry",
        }),
        type: Joi.string().valid("debit", "credit").required().messages({
          "any.required": "type (debit|credit) is required for each entry",
          "any.only": "type must be either 'debit' or 'credit'",
        }),
        amountInPaise: Joi.number().integer().min(1).required().messages({
          "number.min": "amountInPaise must be at least 1 paise",
          "any.required": "amountInPaise is required for each entry",
        }),
        description: Joi.string().trim().max(200).optional(),
      }),
    )
    .min(2)
    .required()
    .messages({
      "array.min": "A Journal Voucher requires at least 2 entries (minimum: one debit, one credit)",
      "any.required": "entries array is required",
    }),
  requestId: Joi.string().trim().optional(), // idempotency key
});

// ─── INTEGRITY CHECK ─────────────────────────────────────────────────────────
// GET /ledger/integrity?asOfDate=
const integrityCheckSchema = Joi.object({
  asOfDate: Joi.date().iso().optional().messages({
    "date.base": "asOfDate must be a valid ISO 8601 date",
  }),
});

module.exports = {
  accountStatementSchema,
  ledgerJournalQuerySchema,
  journalVoucherSchema,
  integrityCheckSchema,
};
