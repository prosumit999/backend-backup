// src/middleware/validate.js
// Universal Joi validation middleware
// Usage: router.post('/login', validate(loginSchema), controller.login)
"use strict";

const ApiError = require("../utils/ApiError");

const validate =
  (schema, source = "body") =>
  (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false, // Collect ALL errors, not just first
      stripUnknown: true, // Remove fields not in schema (security)
      convert: true, // Auto-convert types (e.g. string "true" → boolean)
    });

    if (error) {
      if (req.file || req.files) {
        const cloudinary = require("../config/cloudinary");
        const files = req.file 
          ? [req.file] 
          : (Array.isArray(req.files) ? req.files : Object.values(req.files).flat());
        files.forEach((f) => {
          const publicId = f.filename || f.public_id;
          if (publicId) {
            cloudinary.uploader.destroy(publicId).catch(() => {});
          }
        });
      }

      const errors = error.details.map((d) => ({
        field: d.path.join("."),
        message: d.message.replace(/['"]/g, ""),
      }));
      // TEMP DEBUG: log full Joi errors for diagnosis
      const logger = require("../utils/logger");
      logger.warn(`[Validate] Joi errors: ${JSON.stringify(errors)}`);
      return next(ApiError.unprocessable("Validation failed", errors));
    }

    // Replace req[source] with sanitized + validated value (unknown fields stripped)
    req[source] = value;
    next();
  };

module.exports = validate;
