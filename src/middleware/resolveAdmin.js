// src/middleware/resolveAdmin.js
"use strict";

const User = require("../models/User.model");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");

/**
 * resolveAdmin — resolves /:id to an admin User document.
 *
 * Accepts:
 *   - adminCode  → ADM-2026-0001  (frontend always sends this)
 *   - MongoDB _id → 507f1f77bc... (internal use only)
 *
 * Sets:
 *   req.targetAdmin → User doc of the admin being operated on
 */
const resolveAdmin = async (req, res, next) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return next(ApiError.badRequest("Admin ID is required"));

    let admin;

    if (/^ADM-\d{4}-\d{4,}$/i.test(id)) {
      admin = await User.findOne({
        adminCode: id.toUpperCase(),
        role: ROLES.ADMIN,
        isDeleted: false,
      });
    } else if (/^[0-9a-fA-F]{24}$/.test(id)) {
      admin = await User.findOne({
        _id: id,
        role: ROLES.ADMIN,
        isDeleted: false,
      });
    } else {
      return next(ApiError.badRequest(`Invalid admin identifier: '${id}'`));
    }

    if (!admin) return next(ApiError.notFound("Admin not found"));

    req.targetAdmin = admin;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = resolveAdmin;
