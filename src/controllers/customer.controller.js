// src/controllers/customer.controller.js
"use strict";

const customerService = require("../services/customer.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");

const createCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer({
    ...req.body,
    createdBy: req.user._id,
    createdByRole: req.user.role,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { customer },
        "Customer created. OTP sent to phone.",
      ),
    );
});

const listCustomers = asyncHandler(async (req, res) => {
  const result = await customerService.listCustomers({
    ...req.query,
    requestingUserRole: req.user.role,
    requestingUserId: req.user._id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Customers fetched."));
});

const getKycPending = asyncHandler(async (req, res) => {
  const result = await customerService.getKycPendingList({
    page: req.query.page,
    limit: req.query.limit,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "KYC pending list fetched."));
});

// ── All below receive req.customer from resolveCustomer middleware ─────────────

const resendOtp = asyncHandler(async (req, res) => {
  const result = await customerService.resendPhoneOtp({
    customer: req.customer,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const verifyOtp = asyncHandler(async (req, res) => {
  const result = await customerService.verifyPhoneOtp({
    customer: req.customer,
    otp: req.body.otp,
    verifiedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const submitKyc = asyncHandler(async (req, res) => {
  const files = req.files || {};

  const extractFile = (fieldName) => {
    const file = files[fieldName]?.[0];
    if (!file) return null;
    return { url: file.path, publicId: file.filename };
  };

  const kycDocuments = {
    aadhaarFront: extractFile("aadhaarFront"),
    aadhaarBack: extractFile("aadhaarBack"),
    panCard: extractFile("panCard"),
    photo: extractFile("photo"),
    signature: extractFile("signature"),
  };

  const result = await customerService.submitKycDocuments({
    customer: req.customer,
    aadharRaw: req.body.aadharRaw,
    panRaw: req.body.panRaw,
    kycDocuments,
    submittedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const verifyKyc = asyncHandler(async (req, res) => {
  const result = await customerService.verifyKyc({
    customer: req.customer,
    verifiedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const rejectKyc = asyncHandler(async (req, res) => {
  const result = await customerService.rejectKyc({
    customer: req.customer,
    reason: req.body.reason,
    rejectedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const getCustomer = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomer({
    customer: req.customer,
    requestingUserRole: req.user.role,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { customer: result }, "Customer fetched."));
});

const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer({
    customer: req.customer,
    updates: req.body,
    updatedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { customer }, "Customer updated."));
});

const assignAgent = asyncHandler(async (req, res) => {
  const customer = await customerService.assignAgent({
    customer: req.customer,
    agentId: req.body.agentId,
    assignedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { customer }, "Agent assigned successfully."));
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const result = await customerService.deleteCustomer({
    customer: req.customer,
    deletedBy: req.user._id,
    adminId: req.user._id,
    adminPassword: req.body.adminPassword,
    deletedReason: req.body.reason,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, null, result.message));
});

// ── 2-Step Phone Change ────────────────────────────────────────────────────────

const requestPhoneChange = asyncHandler(async (req, res) => {
  const result = await customerService.requestCustomerPhoneChange({
    customer: req.customer,
    newPhone: req.body.newPhone,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const verifyPhoneChange = asyncHandler(async (req, res) => {
  const result = await customerService.verifyCustomerPhoneChange({
    customer: req.customer,
    otp: req.body.otp,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const getDecryptedAadhar = asyncHandler(async (req, res) => {
  const result = await customerService.getDecryptedAadhar({
    customer: req.customer,
    requestingUserRole: req.user.role,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Aadhaar accessed."));
});

const getDecryptedPanCard = asyncHandler(async (req, res) => {
  const result = await customerService.getDecryptedPanCard({
    customer: req.customer,
    requestingUserRole: req.user.role,
    requestedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, "PAN accessed."));
});

const lookupCustomerAndAccounts = asyncHandler(async (req, res) => {
  const result = await customerService.lookupCustomerAndAccounts({
    search: req.query.search,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Customer and accounts loaded successfully."));
});

const restoreCustomer = asyncHandler(async (req, res) => {
  const result = await customerService.restoreCustomer({
    customerId: req.params.id,
    restoredBy: req.user._id,
    adminId: req.user._id,
    adminPassword: req.body.adminPassword,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, { customer: result.customer }, result.message));
});

module.exports = {
  createCustomer,
  resendOtp,
  verifyOtp,
  submitKyc,
  verifyKyc,
  rejectKyc,
  getKycPending,
  getCustomer,
  listCustomers,
  updateCustomer,
  assignAgent,
  deleteCustomer,
  restoreCustomer,
  requestPhoneChange,
  verifyPhoneChange,
  getDecryptedAadhar,
  getDecryptedPanCard,
  lookupCustomerAndAccounts,
};
