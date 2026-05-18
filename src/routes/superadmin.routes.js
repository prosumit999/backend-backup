// src/routes/superadmin.routes.js
"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/superadmin.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const resolveAdmin = require("../middleware/resolveAdmin");
const validate = require("../middleware/validate");

const {
  createAdminSchema,
  resetAdminPasswordSchema,
  toggleAdminStatusSchema,
  toggleSmsSchema,
  updateConfigSchema,
  createLoanPlanSchema,
  updateLoanPlanSchema,
  createLedgerAccountSchema,
  updateLedgerAccountSchema,
  auditLogQuerySchema,
} = require("../validators/superadmin.validator");

// ── All superadmin routes require authentication ──────────
router.use(authenticate);

// ── Dashboard ─────────────────────────────────────────────
router.get("/dashboard", authorize("VIEW_ADMIN"), ctrl.getDashboard);

// ══════════════════════════════════════════════════════════
// ADMIN MANAGEMENT
// ══════════════════════════════════════════════════════════
router.post(
  "/admins",
  authorize("CREATE_ADMIN"),
  validate(createAdminSchema),
  ctrl.createAdmin,
);

router.get("/admins", authorize("VIEW_ADMIN"), ctrl.listAdmins);

router.get("/admins/:id", authorize("VIEW_ADMIN"), resolveAdmin, ctrl.getAdmin);

router.patch(
  "/admins/:id/password",
  authorize("RESET_ADMIN_PASSWORD"),
  resolveAdmin,
  validate(resetAdminPasswordSchema),
  ctrl.resetAdminPassword,
);

router.patch(
  "/admins/:id/status",
  authorize("MANAGE_ADMIN_STATUS"),
  resolveAdmin,
  validate(toggleAdminStatusSchema),
  ctrl.toggleAdminStatus,
);

// ══════════════════════════════════════════════════════════
// SYSTEM CONTROL
// ══════════════════════════════════════════════════════════
router.patch("/system/lock", authorize("SYSTEM_LOCK"), ctrl.lockSystem);

router.patch("/system/unlock", authorize("SYSTEM_LOCK"), ctrl.unlockSystem);

router.patch(
  "/system/sms",
  authorize("SMS_TOGGLE"),
  validate(toggleSmsSchema),
  ctrl.toggleSms,
);

// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════
router.get("/config", authorize("CONFIG_UPDATE"), ctrl.getAllConfig);

router.patch(
  "/config",
  authorize("CONFIG_UPDATE"),
  validate(updateConfigSchema),
  ctrl.updateConfig,
);

// ══════════════════════════════════════════════════════════
// LOAN PLANS
// ══════════════════════════════════════════════════════════
router.post(
  "/loan-plans",
  authorize("CREATE_LOAN_PLAN"),
  validate(createLoanPlanSchema),
  ctrl.createLoanPlan,
);

router.get("/loan-plans", authorize("VIEW_LOAN_PLAN"), ctrl.listLoanPlans);

router.get("/loan-plans/:id", authorize("VIEW_LOAN_PLAN"), ctrl.getLoanPlan);

router.patch(
  "/loan-plans/:id",
  authorize("UPDATE_LOAN_PLAN"),
  validate(updateLoanPlanSchema),
  ctrl.updateLoanPlan,
);

// ══════════════════════════════════════════════════════════
// LEDGER ACCOUNTS
// ══════════════════════════════════════════════════════════
router.post(
  "/ledger-accounts",
  authorize("MANAGE_LEDGER_ACCOUNTS"),
  validate(createLedgerAccountSchema),
  ctrl.createLedgerAccount,
);

router.get(
  "/ledger-accounts",
  authorize("MANAGE_LEDGER_ACCOUNTS"),
  ctrl.listLedgerAccounts,
);

router.get(
  "/ledger-accounts/:id",
  authorize("MANAGE_LEDGER_ACCOUNTS"),
  ctrl.getLedgerAccount,
);

router.patch(
  "/ledger-accounts/:id",
  authorize("MANAGE_LEDGER_ACCOUNTS"),
  validate(updateLedgerAccountSchema),
  ctrl.updateLedgerAccount,
);

// ══════════════════════════════════════════════════════════
// READ-ONLY VIEWS
// ══════════════════════════════════════════════════════════
router.get(
  "/audit-logs",
  authorize("VIEW_AUDIT_LOGS"),
  validate(auditLogQuerySchema, "query"),
  ctrl.getAuditLogs,
);

module.exports = router;
