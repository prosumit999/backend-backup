// src/validators/auth.validator.js
"use strict";

const Joi = require("joi");

// ─── Reusable field rules ─────────────────────────────────

const phone = Joi.string()
  .trim()
  .length(10)
  .pattern(/^[6-9]\d{9}$/)
  .required()
  .messages({
    "string.length": "Phone number must be exactly 10 digits",
    "string.pattern.base": "Enter a valid 10-digit Indian mobile number",
    "string.empty": "Phone number is required",
    "any.required": "Phone number is required",
  });

// .max(128) — defense-in-depth against oversized payload attacks
const password = Joi.string().min(8).max(128).required().messages({
  "string.min": "Password must be at least 8 characters",
  "string.max": "Password must not exceed 128 characters",
  "string.empty": "Password is required",
  "any.required": "Password is required",
});

const strongPassword = Joi.string()
  .min(8)
  .max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
  .required()
  .messages({
    "string.min": "Password must be at least 8 characters",
    "string.max": "Password must not exceed 128 characters",
    "string.pattern.base":
      "Password must contain uppercase, lowercase, number, and special character (@$!%*?&#)",
    "string.empty": "Password is required",
    "any.required": "Password is required",
  });

// ─── LOGIN ────────────────────────────────────────────────
const loginSchema = Joi.object({
  phone,
  password,
  staySignedIn: Joi.boolean().default(false),
});

// ─── CHANGE PASSWORD ──────────────────────────────────────
const changePasswordSchema = Joi.object({
  currentPassword: password.label("Current password"),

  // .invalid(Joi.ref('currentPassword')) — rejects when new === current.
  // Must be labelled AFTER .invalid() or Joi drops custom messages.
  newPassword: strongPassword
    .label("New password")
    .invalid(Joi.ref("currentPassword"))
    .messages({
      "any.invalid": "New password must be different from current password",
    }),

  // Joi.string() — type-safe: rejects objects/arrays/numbers that happen
  // to equal newPassword. Joi.any() would accept them silently.
  confirmNewPassword: Joi.string()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({
      "any.only": "Passwords do not match",
      "any.required": "Confirm password is required",
      "string.base": "Confirm password must be a string",
    }),
});

// ─── REFRESH TOKEN (body fallback for mobile) ─────────────
const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().max(500).optional().allow(""),
});

module.exports = {
  loginSchema,
  changePasswordSchema,
  refreshTokenSchema,
};
