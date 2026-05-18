// src/routes/devPanel.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Dev Panel routes — vendor-level configuration API.
//
// ACCESS CONTROL:
//   authenticate  → verifies JWT, loads req.user
//   authorize('DEV_PANEL') → restricts to ROLES.DEV only
//
// ENDPOINT SUMMARY:
//   GET  /institution              → read Institution singleton
//   PATCH /institution             → update Institution (partial PATCH)
//   POST /upload-logo              → upload logo file to Cloudinary
//   GET  /config-audit             → read AppConfig docs with metadata
//   PATCH /password                → change own (dev user) password
//   PATCH /superadmin-password     → force-reset superadmin password (no old pw needed)
//
// No superadmin, admin, or agent can reach these routes.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const { uploadLogo } = require("../middleware/uploaders");
const {
  getInstitution,
  updateInstitution,
  getConfigAudit,
  changeDevPassword,
  uploadLogo: uploadLogoCtrl,
  resetSuperadminPassword,
} = require("../controllers/devPanel.controller");

// All Dev Panel routes require a valid JWT AND the DEV_PANEL permission.
router.use(authenticate);
router.use(authorize("DEV_PANEL"));

// ── Institution Master ────────────────────────────────────────────────────────
router.get("/institution", getInstitution);
router.patch("/institution", updateInstitution);

// ── Logo Upload (multipart/form-data, field: "file") ─────────────────────────
router.post("/upload-logo", uploadLogo, uploadLogoCtrl);

// ── AppConfig Audit (read-only oversight) ────────────────────────────────────
router.get("/config-audit", getConfigAudit);

// ── Dev Account Password Management ──────────────────────────────────────────
router.patch("/password", changeDevPassword);

// ── Superadmin Password Reset (dev-privileged, no current-password required) ─
router.patch("/superadmin-password", resetSuperadminPassword);

module.exports = router;
