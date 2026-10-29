// src/controllers/auth.controller.js
"use strict";

const authService = require("../services/auth.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const env = require("../config/env");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// COOKIE EXPIRY HELPER
// ─────────────────────────────────────────────────────────────────────────────
const parseExpiryMs = (str = "7d") => {
  const units = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const match = /^(\d+)([smhdw])$/.exec(str);
  if (!match) {
    throw new Error(`CRITICAL STARTUP ERROR: Invalid JWT_REFRESH_EXPIRES_IN format "${str}". Must be e.g. "7d".`);
  }
  return parseInt(match[1], 10) * units[match[2]];
};

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH TOKEN COOKIE OPTIONS
// path scoped to /api/v1/auth/refresh — browser ONLY sends this cookie on
// refresh requests, NOT on every /loans /customers /agents request.
// This reduces the token's exposure surface significantly.
// ─────────────────────────────────────────────────────────────────────────────
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/v1/auth/refresh",
  maxAge: parseExpiryMs(env.JWT_REFRESH_EXPIRES_IN),
};

const refreshCookieOptions = (staySignedIn) => {
  const options = { ...REFRESH_COOKIE_OPTIONS };
  if (!staySignedIn) delete options.maxAge;
  return options;
};

// clearCookie MUST use identical options (especially path) — otherwise the
// browser does not find the cookie to clear and it silently stays alive.
const CLEAR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/v1/auth/refresh",
};



// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/login
// ─────────────────────────────────────────────────────────────────────────────
const login = asyncHandler(async (req, res) => {
  const { phone, password, staySignedIn = false } = req.body;

  const result = await authService.login({
    phone,
    password,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    requestId: req.id,
    staySignedIn,
  });

  res.cookie("refreshToken", result.refreshToken, refreshCookieOptions(staySignedIn));

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: result.user,
        accessToken: result.accessToken,
      },
      "Login successful",
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/refresh
// Web:    reads from httpOnly cookie (browser sends automatically)
// Mobile: reads from request body (X-Client-Type: mobile + body.refreshToken)
// ─────────────────────────────────────────────────────────────────────────────
const refreshToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken || null;

  if (!token) {
    throw new ApiError(400, "Refresh token is required.");
  }

  const result = await authService.refreshAccessToken({
    refreshToken: token,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    requestId: req.id,
  });

  // Rotate cookie on every refresh
  res.cookie(
    "refreshToken",
    result.refreshToken,
    refreshCookieOptions(result.staySignedIn),
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        accessToken: result.accessToken,
      },
      "Token refreshed successfully",
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
const logout = asyncHandler(async (req, res) => {
  await authService.logout({
    userId: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
    userAgent: req.headers["user-agent"],
  });

  res.clearCookie("refreshToken", CLEAR_COOKIE_OPTIONS);

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Logged out successfully."));
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  await authService.changePassword({
    userId: req.user._id,
    currentPassword,
    newPassword,
    ipAddress: req.ip,
    requestId: req.id,
    userAgent: req.headers["user-agent"],
  });

  res.clearCookie("refreshToken", CLEAR_COOKIE_OPTIONS);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        null,
        "Password changed successfully. Please login again on all devices.",
      ),
    );
});

module.exports = { login, refreshToken, logout, changePassword };
