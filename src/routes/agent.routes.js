// src/routes/agent.routes.js
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const ctrl = require("../controllers/agent.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const resolveAgent = require("../middleware/resolveAgent");
const validate = require("../middleware/validate");
const { uploadAgentKycDocs } = require("../middleware/uploaders");
const {
  createAgentSchema,
  updateAgentSchema,
  updateAgentProfileSchema,
  uploadKycDocsSchema,
  verifyAgentKycSchema,
  toggleAgentStatusSchema,
  suspendAgentSchema,
  reassignAgentSchema,
  changeAgentPasswordSchema,
  requestPhoneChangeSchema,
  verifyPhoneChangeOtpSchema,
  verifyAgentCreationOtpSchema,
  handoverPortfolioSchema,
} = require("../validators/agent.validator");

const reassignmentCtrl = require("../controllers/reassignment.controller");
const { AGENT_KYC_STATUS } = require("../config/constants");
const ApiError = require("../utils/ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITERS
// ─────────────────────────────────────────────────────────────────────────────
const otpResendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many OTP resend requests. Please wait 5 minutes.",
  },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many OTP verification attempts. Try again later.",
  },
});

const phoneChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // only 3 phone change OTP requests per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many phone change requests. Please wait 15 minutes.",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD: block KYC uploads for already-verified agents
// ─────────────────────────────────────────────────────────────────────────────
const checkAgentKycUploadAllowed = (req, res, next) => {
  if (!req.agentProfile) {
    return next(ApiError.notFound("Agent profile not found."));
  }
  if (req.agentProfile.kycStatus === AGENT_KYC_STATUS.KYC_VERIFIED) {
    return next(
      ApiError.badRequest(
        "Cannot upload KYC documents for a verified agent. Please reset KYC first."
      )
    );
  }
  next();
};

router.use(authenticate);

// ── CREATE + LIST ─────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_AGENT"),
  validate(createAgentSchema),
  ctrl.createAgent,
);
router.get("/", authorize("VIEW_AGENT"), ctrl.listAgents);

// ── STATIC — must come BEFORE /:id ───────────────────────
router.get(
  "/kyc/pending",
  authorize("MANAGE_AGENT_KYC"),
  ctrl.getKycPendingList,
);

// ── REASSIGNMENT QUEUE ────────────────────────────────────
router.get(
  "/reassignment/stats",
  authorize("REASSIGN_AGENT"),
  reassignmentCtrl.getReassignmentStats,
);
router.get(
  "/reassignment/queue",
  authorize("REASSIGN_AGENT"),
  reassignmentCtrl.getReassignmentQueue,
);
router.post(
  "/reassignment/assign",
  authorize("REASSIGN_AGENT"),
  validate(reassignAgentSchema),
  reassignmentCtrl.reassignAgents,
);

// ── SINGLE AGENT CRUD ─────────────────────────────────────
router.get("/:id", authorize("VIEW_AGENT"), resolveAgent, ctrl.getAgent);
router.patch(
  "/:id",
  authorize("UPDATE_AGENT"),
  resolveAgent,
  validate(updateAgentSchema),
  ctrl.updateAgent,
);
router.patch(
  "/:id/profile",
  authorize("UPDATE_AGENT"),
  resolveAgent,
  validate(updateAgentProfileSchema),
  ctrl.updateAgentProfile,
);

// ── AGENT PORTFOLIO HANDOVER ──────────────────────────────
router.get(
  "/:id/portfolio",
  authorize("HANDOVER_AGENT_PORTFOLIO"),
  resolveAgent,
  reassignmentCtrl.getAgentPortfolio,
);
router.post(
  "/:id/portfolio/handover",
  authorize("HANDOVER_AGENT_PORTFOLIO"),
  resolveAgent,
  validate(handoverPortfolioSchema),
  reassignmentCtrl.handoverPortfolio,
);

// ── ADMIN: RESET AGENT PASSWORD ───────────────────────────
// No OTP required — admin is already authenticated.
// Agent sessions are invalidated immediately on success.
router.patch(
  "/:id/password",
  authorize("UPDATE_AGENT"),
  resolveAgent,
  validate(changeAgentPasswordSchema),
  ctrl.changeAgentPassword,
);

// ── ADMIN: PHONE CHANGE (2-step OTP flow) ────────────────
// Step 1: Send OTP to the new number
router.post(
  "/:id/phone/request-otp",
  phoneChangeLimiter,
  authorize("UPDATE_AGENT"),
  resolveAgent,
  validate(requestPhoneChangeSchema),
  ctrl.requestAgentPhoneChange,
);
// Step 2: Verify OTP and commit the phone swap
router.post(
  "/:id/phone/verify-otp",
  otpVerifyLimiter,
  authorize("UPDATE_AGENT"),
  resolveAgent,
  validate(verifyPhoneChangeOtpSchema),
  ctrl.verifyAgentPhoneChange,
);

// ── CREATION PHONE VERIFICATION OTP ──────────────────────
// Sent automatically on agent creation; admin enters it here.
router.post(
  "/:id/resend-otp",
  otpResendLimiter,
  authorize("CREATE_AGENT"),
  resolveAgent,
  ctrl.resendAgentCreationOtp,
);
router.post(
  "/:id/verify-otp",
  otpVerifyLimiter,
  authorize("CREATE_AGENT"),
  resolveAgent,
  validate(verifyAgentCreationOtpSchema),
  ctrl.verifyAgentCreationOtp,
);

// ── STATUS MANAGEMENT ─────────────────────────────────────
router.patch(
  "/:id/status",
  authorize("CHANGE_AGENT_STATUS"),
  resolveAgent,
  validate(toggleAgentStatusSchema),
  ctrl.toggleAgentStatus,
);
router.patch(
  "/:id/action",
  authorize("CHANGE_AGENT_STATUS"),
  resolveAgent,
  validate(suspendAgentSchema),
  ctrl.changeAgentStatus,
);

// ── KYC DOCUMENTS + VERIFICATION ─────────────────────────
router.post(
  "/:id/kyc/documents",
  authorize("MANAGE_AGENT_KYC"),
  resolveAgent,
  checkAgentKycUploadAllowed,
  uploadAgentKycDocs,
  validate(uploadKycDocsSchema),
  ctrl.uploadAgentKycDocs,
);
router.patch(
  "/:id/kyc/verify",
  authorize("MANAGE_AGENT_KYC"),
  resolveAgent,
  validate(verifyAgentKycSchema),
  ctrl.verifyAgentKyc,
);

// ── SENSITIVE PII — admin + superadmin only ────────────────────────────────
// Strict rate limit: 5 PII access requests per minute per IP.
// Every successful access is written to AuditLog (BLOCKING).
const piiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many PII access requests. Please wait before trying again.",
  },
});

router.get(
  "/:id/aadhaar",
  piiLimiter,
  authorize("VIEW_DECRYPTED_PII"),
  resolveAgent,
  ctrl.getDecryptedAadhar,
);
router.get(
  "/:id/pan-card",
  piiLimiter,
  authorize("VIEW_DECRYPTED_PII"),
  resolveAgent,
  ctrl.getDecryptedPanCard,
);

module.exports = router;

