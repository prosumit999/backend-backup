// src/validators/system.validator.js
// System-level validators.
// Note: Institution config validation is in devPanel.validator.js (DEV role).
"use strict";

const Joi = require("joi");

const updateVendorConfigSchema = Joi.object({
  companyName:        Joi.string().min(2).max(100).optional(),
  websiteUrl:         Joi.string().uri().allow("", null).optional(),
  supportEmail:       Joi.string().email().allow("", null).optional(),
  supportPhone:       Joi.string().pattern(/^\d{10}$/).allow("", null).messages({
    "string.pattern.base": "Support phone must be exactly 10 digits",
  }).optional(),
  termsAndConditions: Joi.string().allow("", null).optional(),
  privacyPolicy:      Joi.string().allow("", null).optional(),
  licenseValidUntil:  Joi.date().iso().optional(),
  softwareVersion:    Joi.string().allow("", null).optional(),
});

module.exports = {
  updateVendorConfigSchema,
};
