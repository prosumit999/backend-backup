// src/middleware/authenticate.js
// ─────────────────────────────────────────────────────────────────────────────
// JWT authentication middleware + user session cache + system-lock guard.
//
// CACHE DESIGN (A-1 FIX):
//   TTL reduced from 30s to 10s — halves the deactivation window without
//   meaningfully increasing DB load (10s still absorbs typical burst traffic).
//   evictUserCache(userId) exported so admin deactivation / role-change
//   services can force-invalidate the entry immediately rather than waiting
//   for natural TTL expiry.
//
// LOCK STATUS CACHE (A-2 FIX):
//   AppConfig.getValue(SYSTEM_LOCKED) was called on every non-GET mutation from
//   non-superadmin users — one extra DB round-trip on every single write request.
//   A 5-second in-process cache eliminates the DB hit on the hot path.
//   Max staleness accepted: 5s — aggressive enough for an emergency lock
//   scenario (admin can lock, system stops accepting mutations within 5s).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const User = require("../models/User.model");
const AppConfig = require("../models/AppConfig.model");
const { ROLES, CONFIG_KEYS } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// A-1 FIX: User session cache — TTL reduced to 10s + explicit eviction export
//
// WHY 10s (not 30s):
//   An admin deactivates a user. With 30s TTL, that user can keep making API
//   calls for up to 30 seconds — long enough to record several collections on
//   a busy mobile network day. 10s is a reasonable balance between DB reduction
//   and security responsiveness.
//
// evictUserCache(userId):
//   Should be called by:
//     - user.service.js → deactivateUser()
//     - user.service.js → updateRole()
//     - auth.service.js → changePassword() (passwordChangedAt also invalidates,
//                          but early eviction avoids one wasted DB read)
// ─────────────────────────────────────────────────────────────────────────────
const userCache = new Map();
const USER_CACHE_TTL_MS = 10 * 1000; // 10 seconds (was 30s)

const getCachedUser = async (userId) => {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL_MS) {
    return cached.user;
  }
  const user = await User.findById(userId).select("+passwordChangedAt").lean();
  if (user) {
    userCache.set(userId, { user, timestamp: Date.now() });
  } else {
    // User deleted from DB — remove stale cache entry
    userCache.delete(userId);
  }
  return user;
};

/**
 * Force-evict a user from the in-process session cache.
 * Call this immediately after deactivating a user, changing their role,
 * or resetting their password so the next request re-reads from MongoDB.
 *
 * @param {string|mongoose.Types.ObjectId} userId
 */
const evictUserCache = (userId) => {
  const key = userId?.toString();
  if (key && userCache.has(key)) {
    userCache.delete(key);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// A-2 FIX: System lock status cache — 5s TTL
//
// AppConfig.getValue(SYSTEM_LOCKED) is called on every non-GET request from
// every non-superadmin user — pure DB overhead on the critical request path.
//
// A 5-second cache means:
//   • Zero DB overhead on burst traffic (multiple agents posting simultaneously)
//   • Emergency lock takes effect within 5s — acceptable for a maintenance lock
//   • Cache is a plain object (not Map) — single value, no per-user scoping needed
// ─────────────────────────────────────────────────────────────────────────────
const LOCK_CACHE_TTL_MS = 5 * 1000; // 5 seconds
let lockStatusCache = { value: null, timestamp: 0 };

const getCachedLockStatus = async () => {
  if (Date.now() - lockStatusCache.timestamp < LOCK_CACHE_TTL_MS) {
    return lockStatusCache.value;
  }
  const isLocked = await AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED);
  lockStatusCache = { value: isLocked, timestamp: Date.now() };
  return isLocked;
};

/**
 * Force-evict the system lock cache.
 * Call this from superadmin.service.js after toggling SYSTEM_LOCKED
 * so the change takes effect on the very next request.
 */
const evictLockCache = () => {
  lockStatusCache = { value: null, timestamp: 0 };
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    throw ApiError.unauthorized("No access token provided.");

  const token = authHeader.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError")
      throw ApiError.unauthorized(
        "Access token expired. Please refresh your token.",
      );
    throw ApiError.unauthorized("Invalid access token. Please login again.");
  }

  if (!mongoose.isValidObjectId(decoded._id))
    throw ApiError.unauthorized("Invalid access token. Please login again.");

  const user = await getCachedUser(decoded._id);

  if (!user) throw ApiError.unauthorized("User no longer exists.");
  if (!user.isActive)
    throw ApiError.forbidden("Account deactivated. Contact admin.");

  if (user.passwordChangedAt) {
    const changedTs = Math.floor(
      new Date(user.passwordChangedAt).getTime() / 1000,
    );
    if (changedTs >= decoded.iat) {
      throw ApiError.unauthorized(
        "Password was recently changed. Please login again.",
      );
    }
  }

  // A-2 FIX: Use cached lock status — eliminates DB call on every write request.
  // DEV and SUPERADMIN bypass the system lock — they are the ones who unlock it.
  const isPrivilegedRole = user.role === ROLES.SUPERADMIN || user.role === ROLES.DEV;
  if (!isPrivilegedRole && req.method !== "GET") {
    const isLocked = await getCachedLockStatus();
    if (isLocked) {
      throw ApiError.serviceUnavailable(
        "System is temporarily locked for maintenance. Contact your administrator.",
      );
    }
  }

  req.user = {
    id: user._id,
    _id: user._id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    email: user.email || null,
    isActive: user.isActive,
    smsEnabled: user.smsEnabled || false,
  };

  next();
});

module.exports = authenticate;
module.exports.evictUserCache = evictUserCache;   // call on deactivate / role change
module.exports.evictLockCache = evictLockCache;   // call on SYSTEM_LOCKED toggle
