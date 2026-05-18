// src/routes/auth.routes.js
// Auth lifecycle: login → refresh → logout → change-password
// ─────────────────────────────────────────────────────────────────────────────
// Rate limit strategy:
//   /login   → strict limit (5 attempts/15min/IP) — prevents phone enumeration
//              and distributed brute force. Per-IP not per-user because we
//              must protect the "user not found" path too.
//   /refresh → moderate limit (30 req/15min/IP) — a legitimate user refreshes
//              at most once per 15min access token expiry. 30 allows some
//              headroom for mobile background refresh + retries.
//   /logout + /change-password → no rate limit — authenticated routes, low
//              abuse risk, and blocking these would harm UX.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const ctrl = require("../controllers/auth.controller");
const authenticate = require("../middleware/authenticate");
const validate = require("../middleware/validate");
const {
  loginSchema,
  changePasswordSchema,
  refreshTokenSchema,
} = require("../validators/auth.validator");

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITERS
// ─────────────────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message:
      "Too many login attempts from this IP. Please try again after 15 minutes.",
  },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 refresh calls per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many token refresh attempts. Please try again later.",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", loginLimiter, validate(loginSchema), ctrl.login);

router.post(
  "/refresh",
  refreshLimiter,
  validate(refreshTokenSchema),
  ctrl.refreshToken,
);

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED ROUTES — authenticate middleware runs for all routes below
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

router.post("/logout", ctrl.logout);

router.patch(
  "/change-password",
  validate(changePasswordSchema),
  ctrl.changePassword,
);

module.exports = router;
