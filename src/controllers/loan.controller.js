// src/controllers/loan.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// THIN HTTP LAYER — no business logic, no DB operations here.
// Each handler:  (1) extracts request data, (2) calls service, (3) returns response
// All DB queries, calculations, validations → loan.service.js
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const loanService = require("../services/loan.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { toObjId } = require("../utils/dateHelpers");

// GET /loans/preview
const getLoanPreview = asyncHandler(async (req, res) => {
  const result = await loanService.getLoanPreview(req.query);
  return res.status(200).json(new ApiResponse(200, result, "Loan preview calculated."));
});

// POST /loans
const createLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.createLoan({
    customerId:              req.body.customerId,
    loanPlanId:              req.body.loanPlanId,
    principalAmountInPaise:  req.body.principalAmountInPaise,
    createdBy:               req.user._id,
    ipAddress:               req.ip,
    requestId:               req.id,
  });
  return res.status(201).json(
    new ApiResponse(201, { loan }, `Loan created. Account: ${loan.loanAccountNumber}`)
  );
});

// GET /loans/repayment-dashboard
const getLoanRepaymentDashboard = asyncHandler(async (req, res) => {
  const daysThreshold = parseInt(req.query.daysThreshold) || 30;
  const result = await loanService.getLoanRepaymentDashboard({ daysThreshold });
  return res.status(200).json(new ApiResponse(200, result, "Repayment dashboard fetched"));
});

// POST /loans/:id/apply-pigmy
const applyPigmyToLoan = asyncHandler(async (req, res) => {
  const result = await loanService.applyPigmyToLoan({
    loanId:        req.loanAccount._id,
    amountInPaise: req.body.amountInPaise,
    note:          req.body.note,
    appliedBy:     req.user._id,
    ipAddress:     req.ip,
    requestId:     req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// GET /loans/:id
const getLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.getLoan(req.params.id);
  return res.status(200).json(new ApiResponse(200, { loan }, "Loan fetched"));
});

// GET /loans
const listLoans = asyncHandler(async (req, res) => {
  const result = await loanService.listLoans({
    ...req.query,
    requestingUserRole: req.user.role,
    requestingUserId:   req.user._id,
  });
  return res.status(200).json(new ApiResponse(200, result, "Loans fetched"));
});

// GET /loans/customer/:customerId?page=1&limit=20
const getLoansByCustomer = asyncHandler(async (req, res) => {
  const customerId = toObjId(req.params.customerId, "customerId");
  const result = await loanService.getLoansByCustomer(customerId, {
    page:  req.query.page,
    limit: req.query.limit,
  });
  return res.status(200).json(new ApiResponse(200, result, "Customer loans fetched."));
});

// PATCH /loans/:id/close
const closeLoan = asyncHandler(async (req, res) => {
  const result = await loanService.closeLoan({
    loanId:        req.params.id,
    closureReason: req.body.closureReason,
    writeOff:      req.body.writeOff === true,
    closedBy:      req.user._id,
    ipAddress:     req.ip,
    requestId:     req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// POST /loans/:id/reopen
const reopenLoan = asyncHandler(async (req, res) => {
  const result = await loanService.reopenLoan({
    loanId:             req.params.id,
    reactivationReason: req.body.reactivationReason,
    reopenedBy:         req.user._id,
    ipAddress:          req.ip,
    requestId:          req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});


// POST /loans/:id/apply-penalty
const applyPenalty = asyncHandler(async (req, res) => {
  const result = await loanService.applyPenalty({
    loanId:              req.loanAccount._id,
    penaltyAmountInPaise: req.body.penaltyAmountInPaise,
    reason:              req.body.reason,
    appliedBy:           req.user._id,
    ipAddress:           req.ip,
    requestId:           req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, "Penalty applied successfully."));
});

// POST /loans/:id/send-reminder
const sendLoanReminder = asyncHandler(async (req, res) => {
  const result = await loanService.sendLoanReminder({
    loanId:    req.loanAccount._id,
    sentBy:    req.user._id,
    ipAddress: req.ip,
  });
  return res.status(200).json(new ApiResponse(200, result, "Reminder sent."));
});

// GET /loans/:id/statement
const getLoanStatement = asyncHandler(async (req, res) => {
  const result = await loanService.getLoanStatement({
    loanId:   req.loanAccount._id,
    page:     req.query.page,
    limit:    req.query.limit,
    fromDate: req.query.fromDate,
    toDate:   req.query.toDate,
  });
  return res.status(200).json(new ApiResponse(200, result, "Loan transactions fetched."));
});

// POST /loans/repayment/reverse
const reverseRepayment = asyncHandler(async (req, res) => {
  const result = await loanService.reverseRepayment({
    transactionId: req.body.transactionId,
    reversedBy:    req.user._id,
    reason:        req.body.reason,
    ipAddress:     req.ip,
    requestId:     req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// GET /loans/deficit-dashboard
// Returns all loans behind on cumulative pigmy collection.
// Penalty amount and max warnings come from AppConfig (superadmin-configured).
const getDeficitDashboard = asyncHandler(async (req, res) => {
  const result = await loanService.getDeficitDashboard({
    filter: req.query.filter || "all",
  });
  return res.status(200).json(
    new ApiResponse(200, result, "Deficit dashboard fetched."),
  );
});

// PATCH /loans/:id/lifelines
// Admin adjusts lifeline count. resetType: full|increment|decrement|set
const resetLifelines = asyncHandler(async (req, res) => {
  const result = await loanService.resetLifelines({
    loanId:      req.loanAccount._id,
    resetType:   req.body.resetType,
    value:       req.body.value,
    reason:      req.body.reason,
    performedBy: req.user._id,
    ipAddress:   req.ip,
    requestId:   req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

module.exports = {
  getLoanPreview,
  createLoan,
  getLoan,
  listLoans,
  getLoansByCustomer,
  closeLoan,
  reopenLoan,
  applyPenalty,
  sendLoanReminder,
  getLoanRepaymentDashboard,
  applyPigmyToLoan,
  getLoanStatement,
  reverseRepayment,
  // Deficit Warning & Lifeline Management
  getDeficitDashboard,
  resetLifelines,
};
