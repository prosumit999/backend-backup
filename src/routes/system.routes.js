// src/routes/system.routes.js
// NOTE: Institution configuration (GET/PUT) is managed exclusively via the Dev Panel
// (/api/v1/dev/institution — requires DEV_PANEL permission). These endpoints have been
// removed from the system router to prevent superadmin/admin access to institution config.
"use strict";

const express = require("express");
const router = express.Router();
const systemController = require("../controllers/system.controller");

// ── Public route (used by login screen, no auth needed) ──────────────────────
router.get("/branding", systemController.getPublicBranding);

module.exports = router;
