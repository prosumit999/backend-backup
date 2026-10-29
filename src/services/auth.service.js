// src/services/auth.service.js
"use strict";

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/crypto");
const {
  ROLES,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  CONFIG_KEYS,
} = require("../config/constants");

// NOTE: hashToken removed — token hashing lives entirely in User.model.js
// (storeRefreshToken + verifyAndRotateRefreshToken).

const _getLoginConfig = async () => {
  const cfg = await AppConfig.getMany([
    CONFIG_KEYS.MAX_LOGIN_ATTEMPTS,
    CONFIG_KEYS.LOCK_DURATION_MINUTES,
  ]);
  return {
    MAX_ATTEMPTS: Number(cfg[CONFIG_KEYS.MAX_LOGIN_ATTEMPTS] ?? 5),
    LOCK_MINUTES: Number(cfg[CONFIG_KEYS.LOCK_DURATION_MINUTES] ?? 30),
  };
};

const _checkSystemLock = async (userRole) => {
  if (userRole === ROLES.SUPERADMIN) return;
  const rawLocked = await AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED);
  const isLocked = rawLocked === true || rawLocked === "true";
  if (isLocked) {
    throw new ApiError(
      503,
      "System is temporarily locked for maintenance. Contact your administrator.",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
const login = async ({ phone, password, ipAddress, userAgent, requestId, staySignedIn = false }) => {
  // Step 1: Find user — same message for "not found" and "wrong password"
  // to prevent phone number enumeration
  const user = await User.findByPhone(phone);
  if (!user) {
    // Prevent timing side-channel attack (phone enumeration)
    const bcrypt = require("bcrypt");
    await bcrypt.compare(password, "$2b$10$invalidhashinvalidhashinvalidhas");
    throw ApiError.unauthorized("Invalid phone number or password.");
  }

  // Step 2: System lock check — AFTER finding user so we know the role.
  await _checkSystemLock(user.role);

  // Step 3: Account lock check
  if (user.isLocked()) {
    const lockedUntil = new Date(user.lockUntil).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
    });
    throw new ApiError(
      423,
      `Account locked due to too many failed attempts. Try again after ${lockedUntil} IST.`,
    );
  }

  // Step 4: Active status check
  if (!user.isActive) {
    throw ApiError.forbidden(
      "Your account has been deactivated. Contact Support.",
    );
  }

  // Step 5: Password verification
  const isPasswordCorrect = await user.comparePassword(password);

  if (!isPasswordCorrect) {
    const { MAX_ATTEMPTS, LOCK_MINUTES } = await _getLoginConfig();

    // incrementLoginAttempts syncs user.loginAttempts in-memory after DB write
    await user.incrementLoginAttempts(MAX_ATTEMPTS, LOCK_MINUTES);

    const postIncrementAttempts = user.loginAttempts;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - postIncrementAttempts);

    logger.warn(
      `[Auth] Failed login | Phone: ${maskPhone(phone)} | IP: ${ipAddress} | ` +
      `Attempts: ${postIncrementAttempts}/${MAX_ATTEMPTS} | Left: ${attemptsLeft}`,
    );

    await AuditLog.log({
      performedBy: user._id,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: "User",
      entityId: user._id,
      ipAddress,
      userAgent,
      requestId,
      status: AUDIT_STATUS.FAILURE,
      errorMessage: `Invalid password. Attempts: ${postIncrementAttempts}/${MAX_ATTEMPTS}. Left: ${attemptsLeft}`,
    }).catch((e) =>
      logger.error(`[Auth] AuditLog failed (LOGIN_FAILED): ${e.message}`),
    );

    throw ApiError.unauthorized(
      attemptsLeft > 0
        ? `Invalid phone number or password. ${attemptsLeft} attempt(s) remaining.`
        : "Account locked due to too many failed attempts.",
    );
  }

  // Step 6: Reset login attempts
  await user.resetLoginAttempts();

  // Step 7: Create new session
  const { accessToken: rawAccessToken, refreshToken: rawRefreshToken } =
    await user.startNewSession(staySignedIn);

  await AuditLog.log({
    performedBy: user._id,
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entity: "User",
    entityId: user._id,
    ipAddress,
    userAgent,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[Auth] AuditLog failed (LOGIN_SUCCESS): ${e.message}`),
  );

  logger.financial("LOGIN_SUCCESS", {
    userId: user._id,
    role: user.role,
    ipAddress,
  });

  // ── Fetch agent permissions for agent role ─────────────────────────────────
  let agentPermissions = null;
  if (user.role === ROLES.AGENT) {
    try {
      const AgentProfile = require("../models/AgentProfile.model");
      const profile = await AgentProfile.findOne({ user: user._id })
        .select("permissions agentCode")
        .lean();
      agentPermissions = profile?.permissions || { canAddCustomer: true };
    } catch (e) {
      logger.warn(`[Auth] Failed to fetch agent permissions: ${e.message}`);
      agentPermissions = { canAddCustomer: true };
    }
  }

  return {
    user: {
      _id: user._id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      email: user.email || null,
      smsEnabled: user.smsEnabled,
      ...(agentPermissions && { permissions: agentPermissions }),
    },
    accessToken: rawAccessToken,
    refreshToken: rawRefreshToken,
    staySignedIn,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH ACCESS TOKEN — Rotation + Reuse Detection
// ─────────────────────────────────────────────────────────────────────────────
const refreshAccessToken = async ({
  refreshToken,
  ipAddress,
  userAgent,
  requestId,
}) => {
  if (!refreshToken) throw ApiError.unauthorized("Refresh token is required.");

  // Step 1: Verify JWT signature + expiry
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError")
      throw ApiError.unauthorized("Refresh token expired. Please login again.");
    throw ApiError.unauthorized("Invalid refresh token. Please login again.");
  }

  // Step 2: Load user with rotation fields selected
  const user = await User.findForTokenRotation(decoded._id);
  if (!user) throw ApiError.unauthorized("User not found. Please login again.");

  // Step 3: Pre-rotation guards
  if (!user.isActive)
    throw ApiError.forbidden("Account deactivated. Contact admin.");

  if (user.isLocked()) {
    throw new ApiError(
      423,
      "Next login will be in 2 minutes.",
    );
  }

  await _checkSystemLock(user.role);

  const result = await user.verifyAndRotateRefreshToken(decoded, refreshToken);

  if (!result.valid) {
    if (result.stolen) {
      logger.warn(
        `[Auth] Token reuse detected — possible theft! ` +
        `User: ${user._id} | IP: ${ipAddress}`,
      );
      await AuditLog.log({
        performedBy: user._id,
        action: AUDIT_ACTIONS.REFRESH_TOKEN_REUSE_DETECTED,
        entity: "User",
        entityId: user._id,
        ipAddress,
        userAgent,
        requestId,
        status: AUDIT_STATUS.FAILURE,
        errorMessage: "Possible token theft. All sessions invalidated.",
      }).catch((e) =>
        logger.error(`[Auth] AuditLog failed (TOKEN_REUSE): ${e.message}`),
      );
    }
    throw ApiError.unauthorized(result.reason);
  }

  await AuditLog.log({
    performedBy: user._id,
    action: AUDIT_ACTIONS.TOKEN_REFRESHED,
    entity: "User",
    entityId: user._id,
    ipAddress,
    userAgent,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[Auth] AuditLog failed (TOKEN_REFRESHED): ${e.message}`),
  );

  logger.info(`[Auth] Token rotated | User: ${user._id} | IP: ${ipAddress}`);

  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    staySignedIn: decoded.staySignedIn === true,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────

const logout = async ({ userId, ipAddress, requestId, userAgent }) => {
  const user = await User.findById(userId, null, { _skipDeletedFilter: true });
  if (!user) throw ApiError.notFound("User not found.");

  await user.invalidateAllSessions();

  await AuditLog.log({
    performedBy: userId,
    action: AUDIT_ACTIONS.LOGOUT,
    entity: "User",
    entityId: userId,
    ipAddress,
    userAgent,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[Auth] AuditLog failed (LOGOUT): ${e.message}`),
  );

  logger.info(`[Auth] Logout | User: ${userId} | IP: ${ipAddress}`);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
const changePassword = async ({
  userId,
  currentPassword,
  newPassword,
  ipAddress,
  requestId,
  userAgent,
}) => {
  const user = await User.findById(userId).select("+password");
  if (!user) throw ApiError.notFound("User not found.");

  const isCorrect = await user.comparePassword(currentPassword);

  if (!isCorrect) {
    await AuditLog.log({
      performedBy: userId,
      action: AUDIT_ACTIONS.CHANGE_PASSWORD,
      entity: "User",
      entityId: userId,
      ipAddress,
      userAgent,
      requestId,
      status: AUDIT_STATUS.FAILURE,
      errorMessage: "Incorrect current password.",
    }).catch((e) =>
      logger.error(`[Auth] AuditLog failed (CHANGE_PASSWORD): ${e.message}`),
    );
    throw ApiError.badRequest("Current password is incorrect.");
  }

  user.password = newPassword;
  await user.save();

  // Invalidate all sessions on all devices — force re-login everywhere
  await user.invalidateAllSessions();

  await AuditLog.log({
    performedBy: userId,
    action: AUDIT_ACTIONS.CHANGE_PASSWORD,
    entity: "User",
    entityId: userId,
    ipAddress,
    userAgent,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[Auth] AuditLog failed (CHANGE_PASSWORD): ${e.message}`),
  );

  logger.info(`[Auth] Password changed | User: ${userId} | IP: ${ipAddress}`);
  return true;
};

module.exports = { login, refreshAccessToken, logout, changePassword };
