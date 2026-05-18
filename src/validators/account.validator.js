// src/validators/account.validator.js
"use strict";

const Joi = require("joi");
const { ACCOUNT_STATUS, COLLECTION_TYPES, PAYMENT_MODES } = require("../config/constants");

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

// ─────────────────────────────────────────────────────────
// REUSABLE — :customerId route param
// Used by:
//   GET /accounts/customer/:customerId  (account.routes.js)
// Both account + pigmy routes use the same shape.
// ─────────────────────────────────────────────────────────
const customerIdParamSchema = Joi.object({
  customerId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid customer ID format",
    "any.required": "Customer ID is required",
  }),
});

// ─────────────────────────────────────────────────────────
// SAVING ACCOUNT — CREATE
// Only needs customerId. All config (opening charge etc.) from AppConfig.
// ─────────────────────────────────────────────────────────
const createAccountSchema = Joi.object({
  customerId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid customer ID format",
    "any.required": "Customer ID is required",
  }),
});

// ─────────────────────────────────────────────────────────
// PIGMY ACCOUNT — CREATE
// Needs dailyDepositAmountInPaise + collectionFrequency
// in addition to customerId. These are pigmy-specific fields.
// ─────────────────────────────────────────────────────────
const createPigmyAccountSchema = Joi.object({
  customerId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid customer ID format",
    "any.required": "Customer ID is required",
  }),
  dailyDepositAmountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(10000000)
    .required()
    .messages({
      "number.base": "Daily deposit amount must be a number",
      "number.integer": "Daily deposit amount must be whole number in paise",
      "number.min": "Minimum daily deposit is ₹1 (100 paise)",
      "number.max": "Maximum daily deposit is ₹1,00,000",
      "any.required": "Daily deposit amount is required",
    }),
  collectionFrequency: Joi.string()
    .valid(...Object.values(COLLECTION_TYPES))
    .default(COLLECTION_TYPES.DAILY)
    .messages({
      "any.only": `Collection frequency must be one of: ${Object.values(COLLECTION_TYPES).join(", ")}`,
    }),
  assignedAgent: Joi.string().pattern(objectIdRegex).optional().messages({
    "string.pattern.base": "Invalid agent ID format",
  }),
});

// ─────────────────────────────────────────────────────────
// PIGMY ACCOUNT — UPDATE SETTINGS
// Only admin/superadmin. At least one field required.
// No financial side-effects — purely a settings change.
// ─────────────────────────────────────────────────────────
const updatePigmyAccountSchema = Joi.object({
  dailyDepositAmountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(10000000)
    .optional()
    .messages({
      "number.base": "Daily deposit amount must be a number",
      "number.integer": "Daily deposit amount must be whole number in paise",
      "number.min": "Minimum daily deposit is ₹1 (100 paise)",
      "number.max": "Maximum daily deposit is ₹1,00,000",
    }),
  collectionFrequency: Joi.string()
    .valid(...Object.values(COLLECTION_TYPES))
    .optional()
    .messages({
      "any.only": `Collection frequency must be one of: ${Object.values(COLLECTION_TYPES).join(", ")}`,
    }),
}).min(1).messages({
  "object.min": "At least one field (dailyDepositAmountInPaise or collectionFrequency) must be provided",
});

// ─────────────────────────────────────────────────────────
// SAVING ACCOUNT — MANUAL DEPOSIT
// Used for admin/agent initiated cash deposits only.
// Pigmy daily collections → collection.validator.js
//
// Max per-txn cap: ₹10,00,000 (₹10 lakh). The real risk control
// is role-based auth + idempotency + audit log, not this cap.
// ─────────────────────────────────────────────────────────
const depositSchema = Joi.object({
  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(100000000) // ₹10,00,000 (10 lakh)
    .required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be in paise (integer)",
      "number.min": "Minimum deposit amount is ₹1 (100 paise)",
      "number.max": "Maximum single deposit is ₹10,00,000",
      "any.required": "Amount is required",
    }),
  note: Joi.string().trim().max(300).allow("").optional(),
  paymentMode: Joi.string().valid(...Object.values(PAYMENT_MODES)).default(PAYMENT_MODES.CASH),
  // bankLedgerCode is only relevant for bank/cheque payments.
  // For cash deposits, the ledger engine automatically routes to Cash in Hand (1001).
  // Requiring it for cash forced the UI to send a meaningless GL code.
  bankLedgerCode: Joi.string().trim().min(1).when("paymentMode", {
    is: PAYMENT_MODES.CASH,
    then: Joi.optional().allow(null, ""),
    otherwise: Joi.required().messages({
      "any.required": "GL Code is required for bank transfer or cheque deposits.",
      "string.empty": "GL Code cannot be empty.",
    }),
  }),
  utrNumber: Joi.string().trim().allow("").optional(),
  chequeNumber: Joi.string().when("paymentMode", {
    is: PAYMENT_MODES.CHEQUE,
    then: Joi.required().messages({
      "any.required": "Cheque Number is required when payment mode is Cheque.",
    }),
    otherwise: Joi.optional().allow(null, ""),
  }),
  chequeDate: Joi.date().iso().when("paymentMode", {
    is: PAYMENT_MODES.CHEQUE,
    then: Joi.required().messages({
      "any.required": "Cheque Date is required when payment mode is Cheque.",
    }),
    otherwise: Joi.optional().allow(null, ""),
  }),
});

// ─────────────────────────────────────────────────────────
// SAVING ACCOUNT — WITHDRAWAL
//
// Max per-txn cap: ₹10,00,000. The real overdraft guard
// is the atomic $gte filter inside withdrawFromSaving().
// ─────────────────────────────────────────────────────────
const withdrawSchema = Joi.object({
  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .max(100000000) // ₹10,00,000 (10 lakh)
    .required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be in paise (integer)",
      "number.min": "Minimum withdrawal amount is ₹1 (100 paise)",
      "number.max": "Maximum single withdrawal is ₹10,00,000",
      "any.required": "Amount is required",
    }),
  note: Joi.string().trim().max(300).allow("").optional(),
  paymentMode: Joi.string().valid(...Object.values(PAYMENT_MODES)).default(PAYMENT_MODES.CASH),
  bankLedgerCode: Joi.string().trim().min(1).when("paymentMode", {
    is: PAYMENT_MODES.CASH,
    then: Joi.optional().allow(null, ""),
    otherwise: Joi.required().messages({
      "any.required": "GL Code is required for bank transfer or cheque withdrawals.",
      "string.empty": "GL Code cannot be empty.",
    }),
  }),
  utrNumber: Joi.string().trim().allow("").optional(),
  chequeNumber: Joi.string().when("paymentMode", {
    is: PAYMENT_MODES.CHEQUE,
    then: Joi.required().messages({
      "any.required": "Cheque Number is required when payment mode is Cheque.",
    }),
    otherwise: Joi.optional().allow(null, ""),
  }),
  chequeDate: Joi.date().iso().when("paymentMode", {
    is: PAYMENT_MODES.CHEQUE,
    then: Joi.required().messages({
      "any.required": "Cheque Date is required when payment mode is Cheque.",
    }),
    otherwise: Joi.optional().allow(null, ""),
  }),
});

// ─────────────────────────────────────────────────────────
// REPAY LOAN FROM SAVING
// No max cap — the service enforces outstandingBalance >= amount
// atomically inside the MongoDB session. Adding a Joi max here
// would silently block valid large-loan repayments.
// ─────────────────────────────────────────────────────────
const repayLoanSchema = Joi.object({
  loanAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid loan account ID format",
    "any.required": "Loan account ID is required",
  }),
  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be in paise (integer)",
      "number.min": "Minimum repayment amount is ₹1 (100 paise)",
      "any.required": "Amount is required",
    }),
  note: Joi.string().trim().max(300).allow("").optional(),
});

// ─────────────────────────────────────────────────────────
// CLOSE ACCOUNT — shared by saving + pigmy
// Both routes use the same closeAccountSchema because
// the only field needed is closureReason — identical for both.
// ─────────────────────────────────────────────────────────
const closeAccountSchema = Joi.object({
  closureReason: Joi.string().trim().min(5).max(300).required().messages({
    "string.min": "Closure reason must be at least 5 characters",
    "any.required": "Closure reason is required",
  }),
});

// ─────────────────────────────────────────────────────────
// FREEZE ACCOUNT — shared by saving + pigmy
// ─────────────────────────────────────────────────────────
const freezeAccountSchema = Joi.object({
  freezeReason: Joi.string().trim().min(5).max(300).required().messages({
    "string.min": "Freeze reason must be at least 5 characters",
    "any.required": "Freeze reason is required",
  }),
});

// ─────────────────────────────────────────────────────────
// UNFREEZE ACCOUNT — shared by saving + pigmy
// unfreezeReason is optional — admin may not always need to explain
// ─────────────────────────────────────────────────────────
const unfreezeAccountSchema = Joi.object({
  unfreezeReason: Joi.string().trim().max(300).allow("").optional(),
});

// ─────────────────────────────────────────────────────────
// LIST ACCOUNTS — shared by saving + pigmy
// Same query params for both list endpoints
// ─────────────────────────────────────────────────────────
const listAccountsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string()
    .valid(...Object.values(ACCOUNT_STATUS))
    .optional(),
  search: Joi.string().trim().max(100).optional(),
  assignedAgent: Joi.string().pattern(objectIdRegex).optional(),
});

// ─────────────────────────────────────────────────────────
// GET STATEMENT — shared by saving + pigmy
// Same pagination + date range params for both statement endpoints
// ─────────────────────────────────────────────────────────
const getStatementSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  fromDate: Joi.date().iso().optional(),
  toDate: Joi.date().iso().min(Joi.ref("fromDate")).optional().messages({
    "date.min": "toDate must be on or after fromDate",
  }),
});

// ─────────────────────────────────────────────────────────
// TRANSFER: SAVING → PIGMY
// ─────────────────────────────────────────────────────────
const savingToPigmyTransferSchema = Joi.object({
  pigmyAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid pigmy account ID format",
    "any.required": "Pigmy account ID is required",
  }),
  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be in paise (integer)",
      "number.min": "Minimum transfer amount is ₹1 (100 paise)",
      "any.required": "Amount is required",
    }),
  note: Joi.string().trim().max(300).allow("").optional(),
});

// ─────────────────────────────────────────────────────────
// TRANSFER: PIGMY → SAVING
// ─────────────────────────────────────────────────────────
const pigmyToSavingTransferSchema = Joi.object({
  savingAccountId: Joi.string().pattern(objectIdRegex).required().messages({
    "string.pattern.base": "Invalid saving account ID format",
    "any.required": "Saving account ID is required",
  }),
  amountInPaise: Joi.number()
    .integer()
    .min(100)
    .required()
    .messages({
      "number.base": "Amount must be a number",
      "number.integer": "Amount must be in paise (integer)",
      "number.min": "Minimum transfer amount is ₹1 (100 paise)",
      "any.required": "Amount is required",
    }),
  note: Joi.string().trim().max(300).allow("").optional(),
});

module.exports = {
  // Param schemas
  customerIdParamSchema,
  // Saving-specific
  createAccountSchema,
  depositSchema,
  withdrawSchema,
  repayLoanSchema,
  // Pigmy-specific
  createPigmyAccountSchema,
  updatePigmyAccountSchema,
  // Shared — saving + pigmy
  closeAccountSchema,
  freezeAccountSchema,
  unfreezeAccountSchema,
  listAccountsSchema,
  getStatementSchema,
  savingToPigmyTransferSchema,
  pigmyToSavingTransferSchema,
};
