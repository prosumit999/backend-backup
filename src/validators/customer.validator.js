// src/validators/customer.validator.js
"use strict";

const Joi = require("joi");

const phone = Joi.string()
  .trim()
  .pattern(/^[6-9]\d{9}$/)
  .required()
  .messages({
    "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
    "any.required": "Phone number is required",
  });

const pincode = Joi.string()
  .trim()
  .pattern(/^\d{6}$/)
  .optional()
  .allow("")
  .messages({ "string.pattern.base": "Enter valid 6-digit pincode" });

// ─── CREATE CUSTOMER ──────────────────────────────────────
const createCustomerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required().messages({
    "any.required": "Name is required",
    "string.min": "Name must be at least 2 characters",
  }),
  phone,
  alternatePhone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .optional()
    .allow("")
    .messages({
      "string.pattern.base": "Enter a valid alternate mobile number",
    }),
  address: Joi.string()
    .trim()
    .min(5)
    .max(300)
    .required()
    .messages({ "any.required": "Address is required" }),
  city: Joi.string().trim().max(100).optional().allow(""),
  pincode,
  nomineeName: Joi.string().trim().max(150).optional().allow(""),
  nomineeRelation: Joi.string().trim().max(100).optional().allow(""),
});

// ─── VERIFY PHONE OTP (creation) ─────────────────────────
const verifyOtpSchema = Joi.object({
  otp: Joi.string()
    .trim()
    .length(6)
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      "string.length": "OTP must be exactly 6 digits",
      "string.pattern.base": "OTP must be numeric",
      "any.required": "OTP is required",
    }),
});

// ─── SUBMIT KYC DOCUMENTS ─────────────────────────────────
// NOTE: No kycDocuments field here — files come from req.files via
//       multer/Cloudinary, NOT from req.body. Only text fields validated.
const submitKycSchema = Joi.object({
  aadharRaw: Joi.string()
    .trim()
    .length(12)
    .pattern(/^\d{12}$/)
    .required()
    .messages({
      "string.length": "Aadhaar must be exactly 12 digits",
      "string.pattern.base": "Aadhaar must contain only digits",
      "any.required": "Aadhaar number is required",
    }),
  panRaw: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/)
    .required()
    .messages({
      "string.pattern.base": "Enter a valid PAN number (e.g. ABCDE1234F)",
      "any.required": "PAN number is required",
    }),
});

// ─── REJECT KYC ──────────────────────────────────────────
const rejectKycSchema = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required().messages({
    "string.min": "Rejection reason must be at least 10 characters",
    "any.required": "Rejection reason is required",
  }),
});

// ─── UPDATE CUSTOMER ─────────────────────────────────────
const updateCustomerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).optional(),
  alternatePhone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .optional()
    .allow(""),
  address: Joi.string().trim().min(5).max(300).optional(),
  city: Joi.string().trim().max(100).optional().allow(""),
  pincode,
  nomineeName: Joi.string().trim().max(150).optional().allow(""),
  nomineeRelation: Joi.string().trim().max(100).optional().allow(""),
  smsEnabled: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field must be provided to update" });

// ─── ASSIGN AGENT ─────────────────────────────────────────
const assignAgentSchema = Joi.object({
  agentId: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid agent ID format",
      "any.required": "Agent ID is required",
    }),
});

// ─── PHONE CHANGE — Step 1: Request OTP ──────────────────
// Admin submits the new phone number → OTP is sent to the new number.
// Phone is NOT changed until OTP is verified (Step 2).
const requestPhoneChangeSchema = Joi.object({
  newPhone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .required()
    .messages({
      "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
      "any.required": "New phone number is required",
    }),
});

// ─── PHONE CHANGE — Step 2: Verify OTP ───────────────────
// Admin enters the OTP delivered to the NEW number to prove ownership.
// On success, phone is atomically committed and old OTPs are invalidated.
const verifyPhoneChangeOtpSchema = Joi.object({
  otp: Joi.string()
    .trim()
    .length(6)
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      "string.length": "OTP must be exactly 6 digits",
      "string.pattern.base": "OTP must be numeric",
      "any.required": "OTP is required",
    }),
});

// ─── DELETE CUSTOMER (password-protected) ────────────────
// CRITICAL OPERATION: Customer deletion is irreversible from a data-integrity
// standpoint even with soft-delete because customerId is referenced in Transactions,
// Collections, LoanAccounts, SavingAccounts, PigmyAccounts.
// Admin must re-authenticate with their own password — enforced at the backend
// via bcrypt.compare, NOT just a frontend check.
const deleteCustomerSchema = Joi.object({
  adminPassword: Joi.string().min(6).required().messages({
    "string.min": "Password must be at least 6 characters",
    "any.required": "Admin password is required to authorize this sensitive operation",
  }),
});

module.exports = {
  createCustomerSchema,
  verifyOtpSchema,
  submitKycSchema,
  rejectKycSchema,
  updateCustomerSchema,
  assignAgentSchema,
  requestPhoneChangeSchema,
  verifyPhoneChangeOtpSchema,
  deleteCustomerSchema,
};
