// src/controllers/account.controller.js
"use strict";

const accountService = require("../services/saving.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { toObjId } = require("../utils/dateHelpers");
const AppConfig = require("../models/AppConfig.model");
const { CONFIG_KEYS } = require("../config/constants");

// POST /accounts
const createAccount = asyncHandler(async (req, res) => {
  const account = await accountService.createSavingAccount({
    customerId: req.body.customerId,
    openedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res
    .status(201)
    .json(
      new ApiResponse(201, { account }, "Savings account opened successfully."),
    );
});

// GET /accounts/opening-charge
// Returns the configured opening charge so the UI can show it in the
// confirmation dialog before the admin actually opens the account.
const getOpeningCharge = asyncHandler(async (_req, res) => {
  const chargeInPaise =
    Number(await AppConfig.getValue(CONFIG_KEYS.SAVINGS_OPENING_CHARGE)) || 0;
  return res.status(200).json(
    new ApiResponse(200, {
      openingChargeInPaise: chargeInPaise,
      openingChargeInRupees: (chargeInPaise / 100).toFixed(2),
    }, "Opening charge fetched."),
  );
});

// GET /accounts/:id
const getAccount = asyncHandler(async (req, res) => {
  const account = await accountService.getSavingAccount(req.savingAccount._id);
  return res
    .status(200)
    .json(new ApiResponse(200, { account }, "Account fetched."));
});

// GET /accounts
const listAccounts = asyncHandler(async (req, res) => {
  const result = await accountService.listSavingAccounts({
    ...req.query,
    // Trusted fields come AFTER spread — client cannot override them via query params
    requestingUserRole: req.user.role,
    requestingUserId: req.user._id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Accounts fetched."));
});

// GET /accounts/customer/:customerId
const getAccountsByCustomer = asyncHandler(async (req, res) => {
  const customerId = toObjId(req.params.customerId, "customerId");
  const result = await accountService.getSavingAccountsByCustomer(customerId);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Customer accounts fetched."));
});

// GET /accounts/:id/statement
const getStatement = asyncHandler(async (req, res) => {
  const result = await accountService.getSavingStatement({
    ...req.query,
    accountId: req.savingAccount._id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Account statement fetched."));
});


// POST /accounts/:id/transfer-to-pigmy
const transferToPigmy = asyncHandler(async (req, res) => {
  const result = await accountService.transferSavingToPigmy({
    accountId: req.savingAccount._id,
    pigmyAccountId: req.body.pigmyAccountId,
    amountInPaise: req.body.amountInPaise,
    note: req.body.note,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Transfer to pigmy successful."));
});

// POST /accounts/:id/deposit
const depositToSaving = asyncHandler(async (req, res) => {
  const result = await accountService.depositToSaving({
    accountId: req.savingAccount._id,
    amountInPaise: req.body.amountInPaise,
    note: req.body.note,
    paymentMode: req.body.paymentMode,
    utrNumber: req.body.utrNumber,
    chequeNumber: req.body.chequeNumber,
    chequeDate: req.body.chequeDate,
    bankLedgerCode: req.body.bankLedgerCode,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
    idempotencyKey: req.headers["idempotency-key"] || null,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// POST /accounts/:id/withdraw
const withdrawFromSaving = asyncHandler(async (req, res) => {
  const result = await accountService.withdrawFromSaving({
    accountId: req.savingAccount._id,
    amountInPaise: req.body.amountInPaise,
    note: req.body.note,
    paymentMode: req.body.paymentMode,
    utrNumber: req.body.utrNumber,
    chequeNumber: req.body.chequeNumber,
    chequeDate: req.body.chequeDate,
    bankLedgerCode: req.body.bankLedgerCode,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
    idempotencyKey: req.headers["idempotency-key"] || null,
  });
  return res.status(200).json(new ApiResponse(200, result, "Withdrawal successful."));
});

// POST /accounts/:id/repay-loan
const repayLoanFromSaving = asyncHandler(async (req, res) => {
  const result = await accountService.repayLoanFromSaving({
    accountId: req.savingAccount._id,
    loanAccountId: req.body.loanAccountId,
    amountInPaise: req.body.amountInPaise,
    note: req.body.note,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, "Loan repayment successful."));
});

// PATCH /accounts/:id/close
const closeAccount = asyncHandler(async (req, res) => {
  const result = await accountService.closeSavingAccount({
    accountId: req.savingAccount._id,
    closureReason: req.body.closureReason,
    closedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// PATCH /accounts/:id/freeze
const freezeAccount = asyncHandler(async (req, res) => {
  const result = await accountService.freezeSavingAccount({
    accountId: req.savingAccount._id,
    freezeReason: req.body.freezeReason,
    frozenBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// PATCH /accounts/:id/unfreeze
const unfreezeAccount = asyncHandler(async (req, res) => {
  const result = await accountService.unfreezeSavingAccount({
    accountId: req.savingAccount._id,
    unfreezeReason: req.body.unfreezeReason || null,
    unfrozenBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

module.exports = {
  createAccount,
  getOpeningCharge,
  getAccount,
  listAccounts,
  getAccountsByCustomer,
  getStatement,
  depositToSaving,
  withdrawFromSaving,
  repayLoanFromSaving,
  transferToPigmy,
  closeAccount,
  freezeAccount,
  unfreezeAccount,
};
