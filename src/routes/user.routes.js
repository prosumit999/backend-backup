// src/routes/user.routes.js

// ─── Operations on the CURRENTLY LOGGED-IN user ──────────
// Only self-service: read own profile, update own profile
// Password change → auth.routes.js (/auth/change-password)
// Role/phone changes → admin-only operations

"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/user.controller");
const authenticate = require("../middleware/authenticate");
const validate = require("../middleware/validate");
const { updateProfileSchema } = require("../validators/user.validator");

// All user routes require a valid access token
router.use(authenticate);

// GET  /api/v1/user/me → own full profile
router.get("/me", ctrl.getMe);

// PATCH /api/v1/user/me → name, email only
router.patch("/me", validate(updateProfileSchema), ctrl.updateMe);

module.exports = router;
