// src/controllers/agent.controller.js
"use strict";

const agentService = require("../services/agent.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");

// ── CREATE ─────────────────────────────────────────────────
const createAgent = asyncHandler(async (req, res) => {
  const {
    name,
    phone,
    password,
    email,
    fullName,
    dateOfBirth,
    gender,
    area,
    assignedPincodes,
    commissionType,
    commissionRateBps,
    joiningDate,
  } = req.body;

  const result = await agentService.createAgent({
    name,
    phone,
    password,
    email,
    fullName,
    dateOfBirth,
    gender,
    area,
    assignedPincodes,
    commissionType,
    commissionRateBps,
    joiningDate,
    createdBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(new ApiResponse(201, result, "Agent created successfully"));
});

// ── LIST ───────────────────────────────────────────────────
const listAgents = asyncHandler(async (req, res) => {
  const result = await agentService.listAgents(req.query);
  return res.status(200).json(new ApiResponse(200, result, "Agents fetched"));
});

// ── GET SINGLE ─────────────────────────────────────────────
const getAgent = asyncHandler(async (req, res) => {
  // BUG FIX: req.agentUser is a User mongoose doc — it has no .profile field.
  // Profile is separately attached to req.agentProfile by resolveAgent middleware.
  // Destructuring profile from agentUser always yielded undefined (Bug #1).
  // Also removed console.log PII leaks (Bug #2).
  const safeUser = (() => {
    const {
      password,
      refreshTokenHash,
      refreshTokenFamily,
      refreshTokenVersion,
      passwordChangedAt,
      loginAttempts,
      lockUntil,
      ...rest
    } = req.agentUser.toObject();
    return rest;
  })();
  return res
    .status(200)
    .json(new ApiResponse(200, { user: safeUser, profile: req.agentProfile }, "Agent fetched"));
});

// ── UPDATE AUTH FIELDS (name, email, smsEnabled) ──────────
const updateAgent = asyncHandler(async (req, res) => {
  const user = await agentService.updateAgent({
    agentId: req.agentUser._id,
    updates: req.body,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, { user }, "Agent updated"));
});

// ── UPDATE PROFILE (compliance fields) ────────────────────
const updateAgentProfile = asyncHandler(async (req, res) => {
  const profile = await agentService.updateAgentProfile({
    agentId: req.agentUser._id,
    updates: req.body,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { profile }, "Agent profile updated"));
});

// ── TOGGLE ACTIVE / INACTIVE ───────────────────────────────
const toggleAgentStatus = asyncHandler(async (req, res) => {
  // AGT-C-5: explicit boolean coercion — guards against string "true"/"false" from body
  const isActive = req.body.isActive === true || req.body.isActive === "true";

  const result = await agentService.toggleAgentStatus({
    agentId: req.agentUser._id,
    isActive,
    reason: req.body.reason,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        result,
        `Agent ${isActive ? "activated" : "deactivated"}`,
      ),
    );
});

// ── SUSPEND / UNSUSPEND / TERMINATE ───────────────────────
const changeAgentStatus = asyncHandler(async (req, res) => {
  const result = await agentService.changeAgentStatus({
    agentId: req.agentUser._id,
    action: req.body.action,
    reason: req.body.reason,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── UPLOAD KYC DOCS ────────────────────────────────────────
const uploadAgentKycDocs = asyncHandler(async (req, res) => {
  const { aadhaarNumber, panNumber } = req.body;

  const profile = await agentService.uploadAgentKycDocs({
    agentId: req.agentUser._id,
    agentCode: req.agentUser.agentCode,
    files: req.files || {},
    aadhaarNumber,
    panNumber,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { profile }, "KYC documents uploaded"));
});

// ── VERIFY / REJECT KYC ────────────────────────────────────
const verifyAgentKyc = asyncHandler(async (req, res) => {
  const result = await agentService.verifyAgentKyc({
    agentId: req.agentUser._id,
    action: req.body.action,
    note: req.body.note,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── KYC PENDING LIST ───────────────────────────────────────
const getKycPendingList = asyncHandler(async (req, res) => {
  const profiles = await agentService.getKycPendingList({
    page: req.query.page,
    limit: req.query.limit,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, profiles, "KYC pending agents fetched"));
});

// ── RESEND AGENT CREATION OTP ──────────────────────────────
const resendAgentCreationOtp = asyncHandler(async (req, res) => {
  const result = await agentService.resendAgentCreationOtp({
    agentId: req.agentUser._id,
    agentCode: req.agentUser.agentCode,
    phone: req.agentUser.phone,
    name: req.agentUser.name,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── VERIFY AGENT CREATION OTP ──────────────────────────────
const verifyAgentCreationOtp = asyncHandler(async (req, res) => {
  const result = await agentService.verifyAgentCreationOtp({
    agentId: req.agentUser._id,
    otp: req.body.otp,
    verifiedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── RESET AGENT PASSWORD (Admin only, no OTP needed) ───────
const changeAgentPassword = asyncHandler(async (req, res) => {
  const result = await agentService.changeAgentPassword({
    agentId: req.agentUser._id,
    newPassword: req.body.newPassword,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── REQUEST PHONE CHANGE (sends OTP to new number) ─────────
const requestAgentPhoneChange = asyncHandler(async (req, res) => {
  const result = await agentService.requestAgentPhoneChange({
    agentId: req.agentUser._id,
    newPhone: req.body.newPhone,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── VERIFY PHONE CHANGE OTP (commits the phone swap) ───────
const verifyAgentPhoneChange = asyncHandler(async (req, res) => {
  const result = await agentService.verifyAgentPhoneChange({
    agentId: req.agentUser._id,
    otp: req.body.otp,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ── GET DECRYPTED AADHAAR (admin/superadmin only, access is audited) ─────────
const getDecryptedAadhar = asyncHandler(async (req, res) => {
  const result = await agentService.getDecryptedAgentAadhar({
    agentProfile: req.agentProfile,
    requestingUserRole: req.user.role,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Aadhaar accessed."));
});

// ── GET DECRYPTED PAN (admin/superadmin only, access is audited) ─────────────
const getDecryptedPanCard = asyncHandler(async (req, res) => {
  const result = await agentService.getDecryptedAgentPan({
    agentProfile: req.agentProfile,
    requestingUserRole: req.user.role,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "PAN accessed."));
});

module.exports = {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  updateAgentProfile,
  toggleAgentStatus,
  changeAgentStatus,
  uploadAgentKycDocs,
  verifyAgentKyc,
  getKycPendingList,
  // Phone OTP — agent creation
  resendAgentCreationOtp,
  verifyAgentCreationOtp,
  // Admin actions
  changeAgentPassword,
  requestAgentPhoneChange,
  verifyAgentPhoneChange,
  // PII decryption (admin/superadmin only, access audited)
  getDecryptedAadhar,
  getDecryptedPanCard,
};
