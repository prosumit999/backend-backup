// src/validators/devPanel.validator.js
// ─────────────────────────────────────────────────────────────────────────────
// Joi validation schemas for the Dev Panel API endpoints.
//
// All Institution fields are optional in updates (PATCH semantics).
// The updateInstitutionSchema provides field-level validation while keeping
// each field independent — partial updates are first-class.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Joi = require("joi");

// ─── UPDATE INSTITUTION ──────────────────────────────────────────────────────
const updateInstitutionSchema = Joi.object({
  // ── Identity
  name: Joi.string().trim().min(2).max(150).optional().messages({
    "string.min": "Institution name must be at least 2 characters",
    "string.max": "Institution name cannot exceed 150 characters",
  }),
  shortName: Joi.string().trim().min(2).max(60).optional().allow("").messages({
    "string.max": "Short name cannot exceed 60 characters",
  }),
  registrationNumber: Joi.string().trim().max(50).uppercase().optional().allow("").messages({
    "string.max": "Registration number cannot exceed 50 characters",
  }),
  gstNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
    .optional()
    .allow("")
    .messages({
      "string.pattern.base": "Enter a valid 15-character GST number",
    }),

  // ── Branding
  logo: Joi.object({
    url:      Joi.string().uri({ scheme: ["http", "https"] }).allow("", null).optional(),
    publicId: Joi.string().allow("", null).optional(),
  }).optional(),
  primaryColor: Joi.string()
    .trim()
    .pattern(/^$|^#([0-9a-fA-F]{6})$/)
    .optional()
    .allow("")
    .messages({
      "string.pattern.base": "Primary color must be a valid hex code (e.g. #1a56db)",
    }),
  tagline: Joi.string().trim().max(200).optional().allow("").messages({
    "string.max": "Tagline cannot exceed 200 characters",
  }),
  receiptTagline: Joi.string().trim().max(200).optional().allow("").messages({
    "string.max": "Receipt tagline cannot exceed 200 characters",
  }),

  // ── SMS DLT Footer
  // TRAI compliance: must match the registered entity/brand name exactly.
  smsFooter: Joi.string().trim().max(60).optional().allow("").messages({
    "string.max": "SMS footer cannot exceed 60 characters",
  }),

  // ── Contact
  address: Joi.object({
    line1: Joi.string().trim().max(200).optional().allow(""),
    line2: Joi.string().trim().max(200).optional().allow(""),
    city: Joi.string().trim().max(100).optional().allow(""),
    district: Joi.string().trim().max(100).optional().allow(""),
    state: Joi.string().trim().max(100).optional().allow(""),
    pincode: Joi.string()
      .trim()
      .pattern(/^$|^\d{6}$/)
      .optional()
      .allow("")
      .messages({
        "string.pattern.base": "Pincode must be 6 digits",
      }),
  }).optional(),

  phone: Joi.string()
    .trim()
    .pattern(/^$|^[6-9]\d{9}$/)
    .optional()
    .allow("")
    .messages({
      "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
    }),
  email: Joi.string().trim().email({ tlds: { allow: false } }).optional().allow("").messages({
    "string.email": "Enter a valid email address",
  }),
  website: Joi.string().trim().uri({ scheme: ["http", "https"] }).optional().allow("").messages({
    "string.uri": "Website must be a valid http/https URL",
  }),

  // ── System Genesis Date
  // IMPORTANT: Validated further at service level (cannot be in future, cannot
  // move forward past existing BusinessDay records).
  systemGenesisDate: Joi.date().iso().max("now").optional().messages({
    "date.max": "System genesis date cannot be in the future",
    "date.base": "System genesis date must be a valid ISO date",
  }),

  // ── Legal Documents
  privacyPolicy: Joi.string()
    .max(100 * 1024) // 100KB limit
    .optional()
    .allow("")
    .messages({
      "string.max": "Privacy Policy cannot exceed 100KB",
    }),
  microfinanceRules: Joi.string()
    .max(100 * 1024)
    .optional()
    .allow("")
    .messages({
      "string.max": "Microfinance Rules cannot exceed 100KB",
    }),
  termsAndConditions: Joi.string()
    .max(100 * 1024)
    .optional()
    .allow("")
    .messages({
      "string.max": "Terms and Conditions cannot exceed 100KB",
    }),
})
  .min(1)
  .messages({
    "object.min": "At least one field must be provided for update",
  });

// ─── CHANGE DEV PASSWORD ─────────────────────────────────────────────────────
const changeDevPasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    "any.required": "Current password is required",
    "string.empty": "Current password cannot be empty",
  }),
  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "New password must be at least 8 characters",
      "string.max": "New password must not exceed 128 characters",
      "string.pattern.base":
        "New password must contain uppercase, lowercase, number, and special character",
      "any.required": "New password is required",
    }),
  confirmPassword: Joi.string()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({
      "any.only": "Confirm password must match new password",
      "any.required": "Confirm password is required",
    }),
});

// ─── RESET SUPERADMIN PASSWORD (by Dev) ────────────────────────────────────────────
const resetSuperadminPasswordSchema = Joi.object({
  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .required()
    .messages({
      "string.min": "New password must be at least 8 characters",
      "string.max": "New password must not exceed 128 characters",
      "string.pattern.base":
        "Password must contain uppercase, lowercase, number, and special character",
      "any.required": "New password is required",
    }),
  confirmPassword: Joi.string()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({
      "any.only": "Confirm password must match new password",
      "any.required": "Confirm password is required",
    }),
});

module.exports = {
  updateInstitutionSchema,
  changeDevPasswordSchema,
  resetSuperadminPasswordSchema,
};
