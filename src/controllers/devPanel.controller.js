// src/controllers/devPanel.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// Dev Panel controller — thin HTTP adapter layer.
// Validates input using devPanel.validator.js, delegates all business logic
// to devPanel.service.js, and formats the ApiResponse.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const devPanelService = require("../services/devPanel.service");
const {
  updateInstitutionSchema,
  changeDevPasswordSchema,
  resetSuperadminPasswordSchema,
} = require("../validators/devPanel.validator");

// ─── GET /api/v1/dev-panel/institution ───────────────────────────────────────
const getInstitution = asyncHandler(async (req, res) => {
  const result = await devPanelService.getInstitution();
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Institution configuration fetched successfully"));
});

// ─── PATCH /api/v1/dev-panel/institution ─────────────────────────────────────
const updateInstitution = asyncHandler(async (req, res) => {
  const { error, value } = updateInstitutionSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    throw new ApiError(
      400,
      error.details.map((d) => d.message).join("; "),
    );
  }

  const result = await devPanelService.updateInstitution({
    updates: value,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Institution configuration updated successfully"));
});

// ─── GET /api/v1/dev-panel/config-audit ──────────────────────────────────────
const getConfigAudit = asyncHandler(async (req, res) => {
  const result = await devPanelService.getConfigAudit();
  return res
    .status(200)
    .json(new ApiResponse(200, result, "AppConfig audit fetched successfully"));
});

// ─── PATCH /api/v1/dev-panel/password ────────────────────────────────────────
const changeDevPassword = asyncHandler(async (req, res) => {
  const { error, value } = changeDevPasswordSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    throw new ApiError(
      400,
      error.details.map((d) => d.message).join("; "),
    );
  }

  const result = await devPanelService.changeDevPassword({
    userId: req.user._id,
    currentPassword: value.currentPassword,
    newPassword: value.newPassword,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, result.message));
});

// ─── POST /api/v1/dev-panel/upload-logo ──────────────────────────────────────
const uploadLogo = asyncHandler(async (req, res) => {
  const result = await devPanelService.uploadLogo({
    files: req.files,   // createUploader uses .fields() → req.files
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Logo uploaded successfully"));
});

// ─── PATCH /api/v1/dev-panel/superadmin-password ──────────────────────────────
const resetSuperadminPassword = asyncHandler(async (req, res) => {
  const { error, value } = resetSuperadminPasswordSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    throw new ApiError(
      400,
      error.details.map((d) => d.message).join("; "),
    );
  }

  const result = await devPanelService.resetSuperadminPassword({
    newPassword: value.newPassword,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, result.message));
});

module.exports = {
  getInstitution,
  updateInstitution,
  getConfigAudit,
  changeDevPassword,
  uploadLogo,
  resetSuperadminPassword,
};
