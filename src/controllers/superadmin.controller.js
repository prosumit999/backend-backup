// src/controllers/superadmin.controller.js

"use strict";

const service = require("../services/superadmin.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");

// ══════════════════════════════════════════════════════════
// ADMIN MANAGEMENT
// ══════════════════════════════════════════════════════════

const createAdmin = asyncHandler(async (req, res) => {
  const result = await service.createAdmin({
    ...req.body,
    createdBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(new ApiResponse(201, result, "Admin created successfully"));
});

const listAdmins = asyncHandler(async (req, res) => {
  const result = await service.listAdmins(req.query);
  return res.status(200).json(new ApiResponse(200, result, "Admins fetched"));
});

const getAdmin = asyncHandler(async (req, res) => {
  const result = await service.getAdmin(req.targetAdmin._id);
  return res.status(200).json(new ApiResponse(200, result, "Admin fetched"));
});

const resetAdminPassword = asyncHandler(async (req, res) => {
  const result = await service.resetAdminPassword({
    adminId: req.targetAdmin._id,
    newPassword: req.body.newPassword,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const toggleAdminStatus = asyncHandler(async (req, res) => {
  const result = await service.toggleAdminStatus({
    adminId: req.targetAdmin._id,
    isActive: req.body.isActive,
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
        `Admin ${req.body.isActive ? "activated" : "deactivated"}`,
      ),
    );
});

// ══════════════════════════════════════════════════════════
// SYSTEM CONTROL
// ══════════════════════════════════════════════════════════

const lockSystem = asyncHandler(async (req, res) => {
  const result = await service.lockSystem({
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const unlockSystem = asyncHandler(async (req, res) => {
  const result = await service.unlockSystem({
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const toggleSms = asyncHandler(async (req, res) => {
  const enabled = req.body.enabled;
  const result = await service.toggleSms({
    enabled,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ══════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════

const getAllConfig = asyncHandler(async (req, res) => {
  const result = await service.getAllConfig();
  return res.status(200).json(new ApiResponse(200, result, "Config fetched"));
});

const updateConfig = asyncHandler(async (req, res) => {
  const result = await service.updateConfig({
    key: req.body.key,
    value: req.body.value,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ══════════════════════════════════════════════════════════
// LOAN PLANS
// ══════════════════════════════════════════════════════════

const createLoanPlan = asyncHandler(async (req, res) => {
  const result = await service.createLoanPlan({
    ...req.body,
    createdBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(new ApiResponse(201, result, "Loan plan created successfully"));
});

const listLoanPlans = asyncHandler(async (req, res) => {
  const result = await service.listLoanPlans(req.query);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Loan plans fetched"));
});

const getLoanPlan = asyncHandler(async (req, res) => {
  const result = await service.getLoanPlan(req.params.id);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Loan plan fetched"));
});

const updateLoanPlan = asyncHandler(async (req, res) => {
  const result = await service.updateLoanPlan({
    planId: req.params.id,
    updates: req.body,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Loan plan updated"));
});

// ══════════════════════════════════════════════════════════
// LEDGER ACCOUNTS
// ══════════════════════════════════════════════════════════

const createLedgerAccount = asyncHandler(async (req, res) => {
  const result = await service.createLedgerAccount({
    ...req.body,
    createdBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(new ApiResponse(201, result, "Ledger account created successfully"));
});

const listLedgerAccounts = asyncHandler(async (req, res) => {
  const result = await service.listLedgerAccounts(req.query);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Ledger accounts fetched"));
});

const getLedgerAccount = asyncHandler(async (req, res) => {
  const result = await service.getLedgerAccount(req.params.id);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Ledger account fetched"));
});

const updateLedgerAccount = asyncHandler(async (req, res) => {
  const result = await service.updateLedgerAccount({
    accountId: req.params.id,
    updates: req.body,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Ledger account updated"));
});

// ══════════════════════════════════════════════════════════
// READ-ONLY VIEWS
// ══════════════════════════════════════════════════════════

const getAuditLogs = asyncHandler(async (req, res) => {
  const result = await service.getAuditLogs(req.query);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Audit logs fetched"));
});

const getDashboard = asyncHandler(async (req, res) => {
  const result = await service.getDashboard();
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Dashboard fetched"));
});

module.exports = {
  // Admin
  createAdmin,
  listAdmins,
  getAdmin,
  resetAdminPassword,
  toggleAdminStatus,
  // System
  lockSystem,
  unlockSystem,
  toggleSms,
  // Config
  getAllConfig,
  updateConfig,
  // Loan plans
  createLoanPlan,
  listLoanPlans,
  getLoanPlan,
  updateLoanPlan,
  // Ledger
  createLedgerAccount,
  listLedgerAccounts,
  getLedgerAccount,
  updateLedgerAccount,
  // Views
  getAuditLogs,
  getDashboard,
};
