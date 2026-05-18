// src/validators/collection.validator.js
"use strict";

const Joi = require("joi");
const constants = require("../config/constants");

const { COLLECTION_STATUS } = constants;

const COLLECTION_TYPES = constants.COLLECTION_TYPES;
if (!COLLECTION_TYPES || typeof COLLECTION_TYPES !== "object") {
  throw new Error(
    "[collection.validator] COLLECTION_TYPES is not defined in config/constants.js. " +
    "Add COLLECTION_TYPES: { DAILY: 'daily', CATCH_UP: 'catch_up' } (or the correct values).",
  );
}

const objectId = Joi.string()
  .regex(/^[0-9a-fA-F]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

// ─── RECORD COLLECTION ───────────────────────────────────
const recordCollectionSchema = Joi.object({
  accountId: objectId
    .required()
    .messages({ "any.required": "Account ID is required" }),

  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(50000000)
    .required()
    .messages({
      "number.min": "Minimum collection amount is ₹1 (100 paise)",
      "number.max": "Maximum collection amount is ₹5,00,000 per day",
      "any.required": "Amount is required",
    }),

  collectionDate: Joi.date().iso().max("now").optional().messages({
    "date.max": "Collection date cannot be in the future",
  }),

  collectionType: Joi.string()
    .valid(...Object.values(COLLECTION_TYPES))
    .default(COLLECTION_TYPES.DAILY),

  agentId: objectId.optional(),

  note: Joi.string().trim().max(300).optional().allow(""),
});

// ─── REVERSE COLLECTION ──────────────────────────────────
const reverseCollectionSchema = Joi.object({
  reversalReason: Joi.string().trim().min(10).max(300).required().messages({
    "string.min": "Reversal reason must be at least 10 characters",
    "any.required": "Reversal reason is required",
  }),
});

// ─── LIST QUERY ──────────────────────────────────────────
const listCollectionsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  fromDate: Joi.date().iso().optional(),
  toDate: Joi.date().iso().min(Joi.ref("fromDate")).optional().messages({
    "date.min": "toDate must be on or after fromDate",
  }),
  agentId: objectId.optional(),
  customerId: objectId.optional(),
  accountId: objectId.optional(),
  status: Joi.string()
    .valid(...Object.values(COLLECTION_STATUS))
    .optional(),
});

// ─── AGENT DAILY SHEET QUERY ─────────────────────────────
const dailySheetSchema = Joi.object({
  date: Joi.date().iso().max("now").optional().messages({
    "date.max": "Date cannot be in the future",
  }),
});

// ─── DAILY SUMMARY + MISSED QUERY ────────────────────────
const dateQuerySchema = Joi.object({
  date: Joi.date().iso().optional(),
  agentId: objectId.optional(),
});

// ─── AGENT-WISE REPORT QUERY ─────────────────────────────
const agentWiseReportSchema = Joi.object({
  fromDate: Joi.date().iso().required().messages({
    "any.required": "fromDate is required",
  }),
  toDate: Joi.date().iso().min(Joi.ref("fromDate")).required().messages({
    "any.required": "toDate is required",
    "date.min": "toDate must be on or after fromDate",
  }),
  agentId: objectId.optional(),
});

module.exports = {
  recordCollectionSchema,
  reverseCollectionSchema,
  listCollectionsSchema,
  dailySheetSchema,
  dateQuerySchema,
  agentWiseReportSchema,
};
