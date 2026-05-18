// src/validators/agent.validator.js
"use strict";

const Joi = require("joi");

// ─── CREATE AGENT ─────────────────────────────────────────
const createAgentSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required().messages({
    "string.min": "Name must be at least 2 characters",
    "string.max": "Name cannot exceed 100 characters",
    "any.required": "Name is required",
  }),

  phone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .required()
    .messages({
      "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
      "any.required": "Phone is required",
    }),

  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
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

  // Profile fields — all optional at creation time
  // Admin can fill via PATCH /:id/profile later
  fullName: Joi.string().trim().min(2).max(100).optional(),
  dateOfBirth: Joi.date()
    .iso()
    .max("now")
    .optional()
    .messages({ "date.max": "Date of birth cannot be in the future" }),
  gender: Joi.string().valid("male", "female", "other").optional(),
  area: Joi.string().trim().max(200).optional().allow(""),

  assignedPincodes: Joi.array()
    .items(
      Joi.string()
        .trim()
        .pattern(/^\d{6}$/)
        .messages({ "string.pattern.base": "Invalid pincode" }),
    )
    .optional(),

  commissionType: Joi.string()
    .valid("percentage", "fixed", "none")
    .default("none"),
  commissionRateBps: Joi.number()
    .integer()
    .min(0)
    .max(5000)
    .optional()
    .messages({ "number.max": "Commission cannot exceed 50%" }),
  joiningDate: Joi.date().iso().optional(),
});

// ─── UPDATE AGENT (auth fields: name, email, smsEnabled) ──
const updateAgentSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional(),
  email: Joi.string()
    .trim()
    .email({ tlds: { allow: false } })
    .lowercase()
    .optional()
    .allow(""),
  smsEnabled: Joi.boolean().optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field must be provided to update" });

// ─── UPDATE AGENT PROFILE (compliance fields) ─────────────
const updateAgentProfileSchema = Joi.object({
  fullName: Joi.string().trim().min(2).max(100).optional(),
  dateOfBirth: Joi.date().iso().max("now").optional(),
  gender: Joi.string().valid("male", "female", "other").optional(),
  fatherOrSpouseName: Joi.string().trim().max(100).optional().allow(""),

  alternatePhone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .optional()
    .allow(""),

  personalEmail: Joi.string()
    .trim()
    .email({ tlds: { allow: false } })
    .optional()
    .allow(""),

  currentAddress: Joi.object({
    street: Joi.string().trim().optional(),
    city: Joi.string().trim().optional(),
    district: Joi.string().trim().optional(),
    state: Joi.string().trim().optional(),
    pincode: Joi.string()
      .pattern(/^\d{6}$/)
      .optional(),
  }).optional(),

  permanentAddress: Joi.object({
    street: Joi.string().trim().optional(),
    city: Joi.string().trim().optional(),
    district: Joi.string().trim().optional(),
    state: Joi.string().trim().optional(),
    pincode: Joi.string()
      .pattern(/^\d{6}$/)
      .optional(),
  }).optional(),

  isSameAddress: Joi.boolean().optional(),
  area: Joi.string().trim().max(200).optional().allow(""),

  assignedPincodes: Joi.array()
    .items(Joi.string().pattern(/^\d{6}$/))
    .optional(),

  commissionType: Joi.string().valid("percentage", "fixed", "none").optional(),
  commissionRateBps: Joi.number().integer().min(0).max(5000).optional(),
  joiningDate: Joi.date().iso().optional(),
  employeeId: Joi.string().trim().optional().allow(""),

  bankDetails: Joi.object({
    accountHolderName: Joi.string().trim().optional(),
    bankName: Joi.string().trim().optional(),
    accountNumber: Joi.string().trim().optional(),
    ifscCode: Joi.string().trim().uppercase().optional(),
    branchName: Joi.string().trim().optional(),
  }).optional(),
})
  .min(1)
  .messages({ "object.min": "At least one field must be provided to update" });

// ─── VERIFY AGENT KYC ─────────────────────────────────────
const verifyAgentKycSchema = Joi.object({
  action: Joi.string()
    .valid("approve", "reject", "reset")
    .required()
    .messages({ "any.required": "Action (approve/reject/reset) is required" }),
  note: Joi.string().trim().max(500).optional().allow("", null),
});

// ─── TOGGLE AGENT STATUS ──────────────────────────────────
const toggleAgentStatusSchema = Joi.object({
  isActive: Joi.boolean().required().messages({
    "boolean.base": "isActive must be true or false",
    "any.required": "isActive is required",
  }),
  reason: Joi.string().trim().max(300).optional(),
});

// ─── SUSPEND / UNSUSPEND / TERMINATE ─────────────────────
const suspendAgentSchema = Joi.object({
  action: Joi.string()
    .valid("suspend", "unsuspend", "terminate")
    .required()
    .messages({ "any.required": "Action is required" }),
  reason: Joi.string().trim().min(5).max(300).required().messages({
    "any.required": "Reason is required for suspension/termination",
  }),
});

// ─── REASSIGN AGENT ───────────────────────────────────────
const reassignAgentSchema = Joi.object({
  entityType: Joi.string().valid("pigmy", "customers").required().messages({
    "any.only": "entityType must be 'pigmy' or 'customers'",
    "any.required": "entityType is required",
  }),

  entityIds: Joi.array()
    .items(
      Joi.string()
        .pattern(/^[0-9a-fA-F]{24}$/)
        .messages({
          "string.pattern.base": "Each entityId must be a valid ObjectId",
        }),
    )
    .min(1)
    .max(50)
    .required()
    .messages({
      "array.min": "At least one entityId is required",
      "array.max": "Maximum 50 entities can be reassigned per request",
      "any.required": "entityIds is required",
    }),

  newAgentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "newAgentId must be a valid ObjectId",
      "any.required": "newAgentId is required",
    }),
});

// ─── UPLOAD KYC DOCUMENTS ─────────────────────────────────
const uploadKycDocsSchema = Joi.object({
  aadhaarNumber: Joi.string()
    .trim()
    .pattern(/^\d{12}$/)
    .optional()
    .messages({ "string.pattern.base": "Aadhaar must be 12 digits" }),

  panNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/)
    .optional()
    .messages({ "string.pattern.base": "Invalid PAN format" }),
});

// ─── ADMIN: RESET AGENT PASSWORD ──────────────────────────
// Admin sets a new password for the agent.
// No OTP required — admin is already authenticated.
// Agent is force-logged out after this action.
const changeAgentPasswordSchema = Joi.object({
  newPassword: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "Password must be at least 8 characters",
      "string.pattern.base":
        "Password must contain uppercase, lowercase, number, and special character",
      "any.required": "newPassword is required",
    }),
});

// ─── ADMIN: REQUEST PHONE CHANGE (sends OTP to new phone) ─
const requestPhoneChangeSchema = Joi.object({
  newPhone: Joi.string()
    .trim()
    .pattern(/^[6-9]\d{9}$/)
    .required()
    .messages({
      "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
      "any.required": "newPhone is required",
    }),
});

// ─── ADMIN: VERIFY OTP TO CONFIRM PHONE CHANGE ────────────
const verifyPhoneChangeOtpSchema = Joi.object({
  otp: Joi.string()
    .trim()
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      "string.pattern.base": "OTP must be a 6-digit number",
      "any.required": "otp is required",
    }),
});

// ─── VERIFY AGENT CREATION OTP ────────────────────────────
const verifyAgentCreationOtpSchema = Joi.object({
  otp: Joi.string()
    .trim()
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      "string.pattern.base": "OTP must be a 6-digit number",
      "any.required": "otp is required",
    }),
});

// ─── HANDOVER PORTFOLIO ───────────────────────────────────
const handoverPortfolioSchema = Joi.object({
  targetAgentId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "targetAgentId must be a valid ObjectId",
      "any.required": "targetAgentId is required",
    }),
  transferAll: Joi.boolean().required().messages({
    "boolean.base": "transferAll must be true or false",
    "any.required": "transferAll is required",
  }),
  customerIds: Joi.array()
    .items(
      Joi.string()
        .pattern(/^[0-9a-fA-F]{24}$/)
        .messages({
          "string.pattern.base": "Each customerId must be a valid ObjectId",
        }),
    )
    .optional(),
  pigmyIds: Joi.array()
    .items(
      Joi.string()
        .pattern(/^[0-9a-fA-F]{24}$/)
        .messages({
          "string.pattern.base": "Each pigmyId must be a valid ObjectId",
        }),
    )
    .optional(),
});

module.exports = {
  createAgentSchema,
  updateAgentSchema,
  updateAgentProfileSchema,
  uploadKycDocsSchema,
  verifyAgentKycSchema,
  toggleAgentStatusSchema,
  suspendAgentSchema,
  reassignAgentSchema,
  // New
  changeAgentPasswordSchema,
  requestPhoneChangeSchema,
  verifyPhoneChangeOtpSchema,
  verifyAgentCreationOtpSchema,
  handoverPortfolioSchema,
};

