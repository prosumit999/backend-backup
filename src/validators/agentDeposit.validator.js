// src/validators/agentDeposit.validator.js
// ─────────────────────────────────────────────────────────────────────────────
// JOI VALIDATION SCHEMAS — Agent Deposit
//
// RULES:
//   1. Only structural/type/range validation here — ZERO business logic.
//   2. Business logic (e.g. agent must be active, day must be open) lives
//      exclusively in agentDeposit.service.js.
//   3. All messages are human-readable — they go directly to the API response.
//   4. abortEarly: false is set in validate.middleware.js — all errors
//      are collected and returned in one shot, not one by one.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Joi = require("joi");

// ── Reusable primitives ───────────────────────────────────────────────────────
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

const objectId = Joi.string().pattern(OBJECT_ID_REGEX).messages({
  "string.pattern.base":
    "{{#label}} must be a valid MongoDB ObjectId (24 hex characters).",
  "string.base": "{{#label}} must be a string.",
  "any.required": "{{#label}} is required.",
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. RECORD AGENT DEPOSIT
//    POST /api/v1/agent-deposits
//    Body: { agentId, amountInPaise, note? }
// ═════════════════════════════════════════════════════════════════════════════
const recordDepositSchema = Joi.object({
  agentId: objectId.required().label("agentId"),

  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(100_000_000)
    .required()
    .label("amountInPaise")
    .messages({
      "number.base": "amountInPaise must be a number.",
      "number.integer":
        "amountInPaise must be a whole number in paise (no decimals).",
      "number.min": "Minimum deposit is ₹1.00 (100 paise).",
      "number.max":
        "Single deposit cannot exceed ₹10,00,000. Split into multiple deposits if needed.",
      "any.required": "amountInPaise is required.",
    }),

  note: Joi.string()
    .trim()
    .max(300)
    .optional()
    .allow("")
    .label("note")
    .messages({
      "string.max": "Note cannot exceed 300 characters.",
    }),
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. REVERSE AGENT DEPOSIT
//    POST /api/v1/agent-deposits/:depositId/reverse
//    Body: { reversalReason }
//
//    :depositId param — NOT validated here.
//    The service handles all three valid formats:
//      ObjectId  → MongoDB _id
//      DEP-*     → original deposit ref
//      DRCP-*    → receipt ref (if your generateCode uses DRCP prefix)
//    Invalid identifiers → 404 from service, not 422 from validator.
// ═════════════════════════════════════════════════════════════════════════════
const reverseDepositSchema = Joi.object({
  reversalReason: Joi.string()
    .trim()
    .min(5)
    .max(500)
    .required()
    .label("reversalReason")
    .messages({
      "string.min":
        "reversalReason must be at least 5 characters. Provide a clear reason.",
      "string.max": "reversalReason cannot exceed 500 characters.",
      "any.required": "reversalReason is required.",
    }),
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. LIST AGENT DEPOSITS — query params
//    GET /api/v1/agent-deposits?page=1&limit=20&agentId=...
// ═════════════════════════════════════════════════════════════════════════════
const listDepositsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1).label("page").messages({
    "number.min": "page must be at least 1.",
  }),

  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20)
    .label("limit")
    .messages({
      "number.max": "limit cannot exceed 100 per request.",
    }),

  // Admin filter — agents cannot use this (service enforces ownership)
  agentId: objectId.optional().label("agentId"),

  fromDate: Joi.date().iso().optional().label("fromDate").messages({
    "date.format": "fromDate must be a valid ISO date string (YYYY-MM-DD).",
  }),

  toDate: Joi.date()
    .iso()
    .min(Joi.ref("fromDate"))
    .optional()
    .label("toDate")
    .messages({
      "date.format": "toDate must be a valid ISO date string (YYYY-MM-DD).",
      "date.min": "toDate cannot be before fromDate.",
    }),

  // Filter by reversal state — admin use only
  isReversed: Joi.boolean().optional().label("isReversed").messages({
    "boolean.base": "isReversed must be true or false.",
  }),

  // Status filter — allows filtering deposits by completion state
  // The service checks `if (status) filter.status = status` — but status was never
  // reaching the service because Joi's unknown-field stripping removed it first.
  status: Joi.string()
    .valid("completed", "reversed")
    .optional()
    .label("status")
    .messages({
      "any.only": "status must be \"completed\" or \"reversed\".",
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  recordDepositSchema,
  reverseDepositSchema,
  listDepositsSchema,
};
