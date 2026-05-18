// src/controllers/agentDeposit.controller.js
"use strict";

const agentDepositService = require("../services/agentDeposit.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");

const recordAgentDeposit = asyncHandler(async (req, res) => {
  const { agentId: bodyAgentId, amountInPaise, note } = req.body;

  // Admin/superadmin can record for any agent; agent role is auto-assigned
  let agentId;
  if (req.user.role === ROLES.ADMIN || req.user.role === ROLES.SUPERADMIN) {
    agentId = bodyAgentId || req.user._id;
  } else {
    agentId = req.user._id;
  }

  const deposit = await agentDepositService.recordAgentDeposit({
    agentId,
    amountInPaise,
    receivedBy: req.user._id,
    note: note?.trim() || "",
    requestId: req.id,
    ipAddress: req.ip,
  });

  return res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { deposit },
        `Agent deposit of ₹${(deposit.amountInPaise / 100).toFixed(2)} recorded successfully.`,
      ),
    );
});

// ═══════════════════════════════════════════════════════
// 2. REVERSE AGENT DEPOSIT
//    POST /api/v1/agent-deposits/:depositId/reverse
// ═══════════════════════════════════════════════════════
const reverseAgentDeposit = asyncHandler(async (req, res) => {
  const { depositId } = req.params;
  const { reversalReason } = req.body;

  const result = await agentDepositService.reverseAgentDeposit({
    depositId,
    reversalReason: reversalReason?.trim(),
    reversedBy: req.user._id,
    requestId: req.id,
    ipAddress: req.ip,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(200, { result }, "Agent deposit reversed successfully."),
    );
});

// ═══════════════════════════════════════════════════════
// 3. GET SINGLE DEPOSIT
//    GET /api/v1/agent-deposits/:identifier
// ═══════════════════════════════════════════════════════
const getAgentDeposit = asyncHandler(async (req, res) => {
  const { identifier } = req.params;

  const deposit = await agentDepositService.getAgentDeposit(
    identifier,
    req.user._id,
    req.user.role,
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, { deposit }, "Agent deposit fetched successfully."),
    );
});

// ═══════════════════════════════════════════════════════
// 4. LIST DEPOSITS (paginated)
//    GET /api/v1/agent-deposits
// ═══════════════════════════════════════════════════════
const listAgentDeposits = asyncHandler(async (req, res) => {
  const { page, limit, agentId, fromDate, toDate, status } = req.query;

  const result = await agentDepositService.listAgentDeposits({
    page,
    limit,
    agentId,
    fromDate,
    toDate,
    status,
    requestingUserRole: req.user.role,
    requestingUserId: req.user._id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Agent deposits fetched successfully."));
});

// ═══════════════════════════════════════════════════════
// 5. GET AGENT CASH BALANCE
//    GET /api/v1/agent-deposits/cash-balance/:agentId
// ═══════════════════════════════════════════════════════
const getAgentCashBalance = asyncHandler(async (req, res) => {
  const { agentId } = req.params;

  if (
    req.user.role === ROLES.AGENT &&
    agentId.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "You can only view your own cash balance.");
  }

  const balance = await agentDepositService.getAgentCashBalance(agentId);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { balance },
        "Agent cash balance fetched successfully.",
      ),
    );
});

module.exports = {
  recordAgentDeposit,
  reverseAgentDeposit,
  getAgentDeposit,
  listAgentDeposits,
  getAgentCashBalance,
};
