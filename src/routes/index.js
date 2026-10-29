// src/routes/index.js
// ─── Central router — mounts all feature routers ──────────
"use strict";

const express = require("express");
const router = express.Router();

// ── Auth (login, logout, refresh, change-password) ────────
router.use("/auth", require("./auth.routes"));

// ── Superadmin (create-admin,legder,loanPlan, etc view aduit, create appConfigs) ────────
router.use("/superadmin", require("./superadmin.routes"));

// ── User (GET /me, PATCH /me) ─────────────────────────────
router.use("/user", require("./user.routes"));

// ── Admin — agent management ──────────────────────────────
router.use("/agents", require("./agent.routes"));

// ── Customers ─────────────────────────────────────────────
router.use("/customers", require("./customer.routes"));

// ── Saving accounts ───────────────────────────────────────
router.use("/accounts", require("./account.routes"));

// ── Pigmy accounts ────────────────────────────────────────
// ADDED: pigmy.service.js existed but had no reachable routes
router.use("/pigmy-accounts", require("./pigmy.routes"));

// ── Collections ───────────────────────────────────────────
router.use("/collections", require("./collection.routes"));

// ── Loans ─────────────────────────────────────────────────
router.use("/loans", require("./loan.routes"));

// ── Reports ───────────────────────────────────────────────
router.use("/reports", require("./report.routes"));

// Data backups (JSON download + emailed download links)
router.use("/backups", require("./backup.routes"));

// ── Day Control (open / close business day) ───────────────
router.use("/day-control", require("./dayControl.routes"));

// ── Agent Deposits (cash handover from agent to office) ───
router.use("/agent-deposits", require("./agentDeposit.routes"));

// ── Ledger (general ledger, account statements, journal, JV) ─────────────
router.use("/ledger", require("./ledger.routes"));

// ── System / Config / Branding ────────────────────────────
router.use("/system", require("./system.routes"));

// ── Agent Reports (agent-scoped pigmy/loan/collection/deposit reports) ────
router.use("/agent/reports", require("./agentReport.routes"));

// ── Transaction History (admin/superadmin — list & deep-link lookup) ──────
router.use("/transactions", require("./transaction.routes"));

// ── Capital Infusion (DR Cash | CR Owner's Capital) ───────────────────────
router.use("/capital-infusion", require("./capitalInfusion.routes"));

// ── Dev Panel (DEV role only — institution config, genesis date, legal docs) ─
// Access: ROLES.DEV exclusively. Superadmin/admin cannot reach these routes.
router.use("/dev-panel", require("./devPanel.routes"));

module.exports = router;
