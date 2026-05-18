// src/controllers/system.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// System Controller — public-facing endpoints only.
// Institution config is managed exclusively via the Dev Panel
// (devPanel.routes.js — DEV role only). This controller exposes ONLY the
// public branding endpoint used by the login screen.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const Institution = require("../models/Institution.model");

// ── GET /api/v1/system/branding ───────────────────────────────────────────────
// Public route for login page — no auth needed.
// Returns only minimal, safe branding data (NO internal fields).
const getPublicBranding = asyncHandler(async (req, res) => {
  const institution = await Institution.getInstance();

  return res.status(200).json(
    new ApiResponse(200, {
      institution: {
        name:               institution.name,
        shortName:          institution.shortName,
        logoUrl:            institution.logoUrl,          // virtual → logo.url
        primaryColor:       institution.primaryColor,
        tagline:            institution.tagline,
        receiptTagline:     institution.receiptTagline,
        registrationNumber: institution.registrationNumber,
        address:            institution.address,
        phone:              institution.phone,
        email:              institution.email,
        website:            institution.website,
      },
    }, "Public branding fetched")
  );
});

module.exports = {
  getPublicBranding,
};
