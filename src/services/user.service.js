// src/services/user.service.js
"use strict";

const User = require("../models/User.model");
const AuditLog = require("../models/AuditLog.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { AUDIT_ACTIONS, AUDIT_STATUS } = require("../config/constants");
// ─────────────────────────────────────────────────────────
// GET OWN PROFILE
// ─────────────────────────────────────────────────────────
const getProfile = async (userId) => {
  const user = await User.findById(userId).select(
    "name phone email role smsEnabled isActive agentCode createdAt updatedAt",
  );

  if (!user) throw new ApiError(404, "User not found");
  return user;
};

// ─────────────────────────────────────────────────────────
// UPDATE OWN PROFILE (safe fields only)
// ─────────────────────────────────────────────────────────
const updateProfile = async ({
  userId,
  updates,
  ipAddress,
  userAgent,
  requestId,
}) => {
  // Service-level whitelist — second line of defence after Joi strip.
  // Even if validate() middleware is accidentally removed from the route,
  // this ensures role/phone/password can NEVER be updated here.

  const SAFE_FIELDS = ["name", "email"];
  const safeUpdates = {};
  SAFE_FIELDS.forEach((f) => {
    if (updates[f] !== undefined) safeUpdates[f] = updates[f];
  });

  if (Object.keys(safeUpdates).length === 0)
    throw new ApiError(400, "No valid fields provided to update");

  let oldUser;
  try {
    oldUser = await User.findByIdAndUpdate(
      userId,
      { $set: safeUpdates },
      { returnDocument: "before", runValidators: true },
    ).select("name email");
  } catch (err) {
    // Explicit duplicate email handling — clearer than generic 11000 error
    if (err.code === 11000) {
      throw new ApiError(
        409,
        "This email address is already registered to another account.",
      );
    }
    throw err;
  }

  if (!oldUser) throw new ApiError(404, "User not found");

  // Fetch updated document for response
  const user = await User.findById(userId).select(
    "name phone email role smsEnabled isActive agentCode updatedAt",
  );

  // .catch() — audit failure must never crash the update response
  await AuditLog.log({
    performedBy: userId,
    action: AUDIT_ACTIONS.UPDATE_OWN_PROFILE,
    entity: "User",
    entityId: userId,
    oldData: {
      name: oldUser.name,
      email: oldUser.email ?? null,
    },
    newData: safeUpdates,
    ipAddress,
    userAgent,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[User] AuditLog failed (UPDATE_OWN_PROFILE): ${e.message}`),
  );

  logger.info(`[User] Profile updated | User: ${userId}`);
  return user;
};

module.exports = { getProfile, updateProfile };
