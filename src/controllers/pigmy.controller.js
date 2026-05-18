// src/controllers/pigmy.controller.js
"use strict";

const pigmyService = require("../services/pigmy.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { toObjId } = require("../utils/dateHelpers");

const createPigmyAccount = asyncHandler(async (req, res) => {
  const account = await pigmyService.createPigmyAccount({
    customerId: req.body.customerId,
    dailyDepositAmountInPaise: req.body.dailyDepositAmountInPaise,
    collectionFrequency: req.body.collectionFrequency,
    assignedAgent: req.body.assignedAgent,
    openedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(
      new ApiResponse(201, { account }, "Pigmy account opened successfully."),
    );
});

const getPigmyAccount = asyncHandler(async (req, res) => {
  const account = await pigmyService.getPigmyAccount(req.pigmyAccount._id);
  return res
    .status(200)
    .json(new ApiResponse(200, { account }, "Pigmy account fetched."));
});

const listPigmyAccounts = asyncHandler(async (req, res) => {
  const result = await pigmyService.listPigmyAccounts({
    ...req.query,
    requestingUserRole: req.user.role,
    requestingUserId: req.user._id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Pigmy accounts fetched."));
});

const getPigmyAccountsByCustomer = asyncHandler(async (req, res) => {
  const customerId = toObjId(req.params.customerId, "customerId");
  const result = await pigmyService.getPigmyAccountsByCustomer(customerId);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Customer pigmy accounts fetched."));
});

const getStatement = asyncHandler(async (req, res) => {
  const result = await pigmyService.getStatement({
    accountId: req.pigmyAccount._id,
    ...req.query,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Pigmy statement fetched."));
});

const closePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.closePigmyAccount({
    accountId: req.pigmyAccount._id,
    closureReason: req.body.closureReason,
    closedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const freezePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.freezePigmyAccount({
    accountId: req.pigmyAccount._id,
    freezeReason: req.body.freezeReason,
    frozenBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const unfreezePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.unfreezePigmyAccount({
    accountId: req.pigmyAccount._id,
    unfreezeReason: req.body.unfreezeReason || null,
    unfrozenBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const transferToSaving = asyncHandler(async (req, res) => {
  const result = await pigmyService.transferPigmyToSaving({
    accountId: req.pigmyAccount._id,
    savingAccountId: req.body.savingAccountId,
    amountInPaise: req.body.amountInPaise,
    note: req.body.note,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Transfer to saving successful."));
});

const updatePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.updatePigmyAccount({
    accountId: req.pigmyAccount._id,
    dailyDepositAmountInPaise: req.body.dailyDepositAmountInPaise,
    collectionFrequency: req.body.collectionFrequency,
    updatedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, { account: result.account }, result.message));
});

const deletePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.deletePigmyAccount({
    accountId: req.params.id,
    deletedBy: req.user._id,
    ipAddress: req.ip,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const restorePigmyAccount = asyncHandler(async (req, res) => {
  const result = await pigmyService.restorePigmyAccount({
    accountId: req.params.id,
    restoredBy: req.user._id,
    ipAddress: req.ip,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

module.exports = {
  createPigmyAccount,
  getPigmyAccount,
  listPigmyAccounts,
  getPigmyAccountsByCustomer,
  getStatement,
  updatePigmyAccount,
  closePigmyAccount,
  freezePigmyAccount,
  unfreezePigmyAccount,
  transferToSaving,
  deletePigmyAccount,
  restorePigmyAccount,
};
