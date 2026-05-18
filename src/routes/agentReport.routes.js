// src/routes/agentReport.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Agent-specific report routes. All endpoints enforce agentId = req.user._id.
// Admin/Superadmin can also access these routes (for debugging/support).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const agentReportController = require("../controllers/agentReport.controller");

// All routes require auth + VIEW_AGENT_REPORTS permission
router.use(authenticate);

// GET /api/v1/agent/reports/pigmy  — Customer-wise pigmy summary
router.get("/pigmy", authorize("VIEW_AGENT_REPORTS"), agentReportController.getPigmyReport);

// GET /api/v1/agent/reports/loans  — Loan status for assigned customers
router.get("/loans", authorize("VIEW_AGENT_REPORTS"), agentReportController.getLoanReport);

// GET /api/v1/agent/reports/collections — Date-wise collection history
router.get("/collections", authorize("VIEW_AGENT_REPORTS"), agentReportController.getCollectionReport);

// GET /api/v1/agent/reports/deposits — Cash deposit history
router.get("/deposits", authorize("VIEW_AGENT_REPORTS"), agentReportController.getDepositReport);

module.exports = router;
