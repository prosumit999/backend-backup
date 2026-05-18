// src/routes/customer.routes.js
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const ctrl = require("../controllers/customer.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const resolveCustomer = require("../middleware/resolveCustomer");
const { uploadKycDocs } = require("../middleware/uploaders");
const {
  createCustomerSchema,
  verifyOtpSchema,
  submitKycSchema,
  rejectKycSchema,
  updateCustomerSchema,
  assignAgentSchema,
  requestPhoneChangeSchema,
  verifyPhoneChangeOtpSchema,
  deleteCustomerSchema,
} = require("../validators/customer.validator");

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER — OTP Resend
// ─────────────────────────────────────────────────────────────────────────────
const otpResendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // 3 resend attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many OTP resend requests. Please wait 5 minutes.",
  },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 verify attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many OTP verification attempts. Try again later.",
  },
});

// Strict limiter for phone change OTPs — 3 attempts per 15 min per IP
const phoneChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    statusCode: 429,
    message: "Too many phone change requests. Please wait 15 minutes.",
  },
});

router.use(authenticate);

// ── CREATE + LIST ─────────────────────────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_CUSTOMER"),
  validate(createCustomerSchema),
  ctrl.createCustomer,
);
router.get("/", authorize("VIEW_CUSTOMER"), ctrl.listCustomers);

// ── STATIC ROUTES — must come BEFORE /:id ────────────────────────────────────
router.get(
  "/lookup",
  authorize("VIEW_CUSTOMER"),
  ctrl.lookupCustomerAndAccounts,
);

router.get(
  "/kyc/pending",
  authorize("MANAGE_CUSTOMER_KYC"),
  ctrl.getKycPending,
);

// ── OTP FLOW ──────────────────────────────────────────────────────────────────
router.post(
  "/:id/resend-otp",
  otpResendLimiter,
  authorize("CREATE_CUSTOMER"),
  resolveCustomer,
  ctrl.resendOtp,
);
router.post(
  "/:id/verify-otp",
  otpVerifyLimiter,
  authorize("CREATE_CUSTOMER"),
  resolveCustomer,
  validate(verifyOtpSchema),
  ctrl.verifyOtp,
);

// ── KYC SUBMIT ────────────────────────────────────────────────────────────────
router.post(
  "/:id/kyc/submit",
  authorize("CREATE_CUSTOMER"),
  resolveCustomer,
  uploadKycDocs,
  validate(submitKycSchema),
  ctrl.submitKyc,
);

// ── KYC APPROVE / REJECT ──────────────────────────────────────────────────────
router.patch(
  "/:id/kyc/verify",
  authorize("MANAGE_CUSTOMER_KYC"),
  resolveCustomer,
  ctrl.verifyKyc,
);
router.patch(
  "/:id/kyc/reject",
  authorize("MANAGE_CUSTOMER_KYC"),
  resolveCustomer,
  validate(rejectKycSchema),
  ctrl.rejectKyc,
);

// ── SINGLE CUSTOMER CRUD ─────────────────────────────────────────────────────
router.get(
  "/:id",
  authorize("VIEW_CUSTOMER"),
  resolveCustomer,
  ctrl.getCustomer,
);
router.patch(
  "/:id",
  authorize("UPDATE_CUSTOMER"),
  resolveCustomer,
  validate(updateCustomerSchema),
  ctrl.updateCustomer,
);
// CRITICAL: DELETE is password-protected — admin must re-authenticate.
// Backend enforces via bcrypt.compare, not just frontend modal.
router.delete(
  "/:id",
  authorize("DELETE_CUSTOMER"),
  resolveCustomer,
  validate(deleteCustomerSchema),
  ctrl.deleteCustomer,
);

// ── ASSIGN AGENT ─────────────────────────────────────────────────────────────────────
router.patch(
  "/:id/assign-agent",
  authorize("ASSIGN_AGENT"),
  resolveCustomer,
  validate(assignAgentSchema),
  ctrl.assignAgent,
);

// ── PHONE CHANGE (2-step OTP) ─────────────────────────────────────────────────────
// Step 1: Admin sends new phone → OTP sent to new number (NOT committed yet)
router.post(
  "/:id/phone/request-otp",
  phoneChangeLimiter,
  authorize("UPDATE_CUSTOMER"),
  resolveCustomer,
  validate(requestPhoneChangeSchema),
  ctrl.requestPhoneChange,
);
// Step 2: Admin enters OTP → new phone is committed atomically
router.post(
  "/:id/phone/verify-otp",
  otpVerifyLimiter,
  authorize("UPDATE_CUSTOMER"),
  resolveCustomer,
  validate(verifyPhoneChangeOtpSchema),
  ctrl.verifyPhoneChange,
);

// ── SENSITIVE PII — admin + superadmin only ───────────────────────────────────
// Strict rate limit — 5 PII access requests per minute per IP
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
  resolveCustomer,
  ctrl.getDecryptedAadhar,
);
router.get(
  "/:id/pan-card",
  piiLimiter,
  authorize("VIEW_DECRYPTED_PII"),
  resolveCustomer,
  ctrl.getDecryptedPanCard,
);

// ── RESTORE SOFT-DELETED CUSTOMER (admin only) ────────────────────────────────
// Uses DELETE_CUSTOMER permission (same gate as delete — only admins can do both).
// Does NOT use resolveCustomer because that middleware filters out deleted records.
// Password re-auth is handled inside the service layer.
router.patch(
  "/:id/restore",
  authorize("DELETE_CUSTOMER"),
  ctrl.restoreCustomer,
);

module.exports = router;
