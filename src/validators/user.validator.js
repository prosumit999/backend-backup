// src/validators/user.validator.js
// ─────────────────────────────────────────────────────────
"use strict";

const Joi = require("joi");

// ─── UPDATE OWN PROFILE ───────────────────────────────────
// Only safe self-service fields — role, phone, password are NOT here.
//
// Password change  → POST /auth/change-password
// Role/phone change → admin-only operations
const updateProfileSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional().messages({
    "string.min": "Name must be at least 2 characters",
    "string.max": "Name must not exceed 100 characters",
  }),

  email: Joi.string()
    .trim()
    .email({ tlds: { allow: false } })
    .max(254)
    .lowercase()
    .optional()
    .messages({
      "string.email": "Enter a valid email address",
      "string.max": "Email must not exceed 254 characters",
    }),
})
  .min(1)
  .messages({
    "object.min": "At least one field (name, email, or area) must be provided",
  });

module.exports = {
  updateProfileSchema,
};
