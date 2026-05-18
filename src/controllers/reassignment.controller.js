// src/controllers/reassignment.controller.js
"use strict";

const reassignmentService = require("../services/reassignment.service");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { PAGINATION } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET REASSIGNMENT QUEUE
// GET /api/v1/agents/reassignment/queue
// Query: ?type=pigmy|customers|all  ?page=1  ?limit=20
// ─────────────────────────────────────────────────────────────────────────────
const getReassignmentQueue = asyncHandler(async (req, res) => {
  const { type, page, limit } = req.query;

  const result = await reassignmentService.getReassignmentQueue({
    type,
    page: page ? parseInt(page, 10) : PAGINATION.DEFAULT_PAGE,
    limit: limit ? parseInt(limit, 10) : PAGINATION.DEFAULT_LIMIT,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(200, result, "Reassignment queue fetched successfully."),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. REASSIGN AGENTS
// POST /api/v1/agents/reassignment/assign
// Body: { entityType, entityIds, newAgentId }
// ─────────────────────────────────────────────────────────────────────────────
const reassignAgents = asyncHandler(async (req, res) => {
  const { entityType, entityIds, newAgentId } = req.body;

  const result = await reassignmentService.reassignAgents({
    entityType,
    entityIds,
    newAgentId,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.headers["x-request-id"] || null,
  });

  return res.status(200).json(new ApiResponse(200, result, result.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET REASSIGNMENT STATS
// GET /api/v1/agents/reassignment/stats
// ─────────────────────────────────────────────────────────────────────────────
const getReassignmentStats = asyncHandler(async (req, res) => {
  const result = await reassignmentService.getReassignmentStats();

  return res
    .status(200)
    .json(
      new ApiResponse(200, result, "Reassignment stats fetched successfully."),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET AGENT PORTFOLIO
// GET /api/v1/agents/:id/portfolio
// ─────────────────────────────────────────────────────────────────────────────
const getAgentPortfolio = asyncHandler(async (req, res) => {
  const { cPage, pPage, limit } = req.query;
  const result = await reassignmentService.getAgentPortfolio(
    req.agentUser._id,
    cPage ? parseInt(cPage, 10) : PAGINATION.DEFAULT_PAGE,
    pPage ? parseInt(pPage, 10) : PAGINATION.DEFAULT_PAGE,
    limit ? parseInt(limit, 10) : PAGINATION.DEFAULT_LIMIT
  );
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Agent portfolio fetched successfully."));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. HANDOVER AGENT PORTFOLIO
// POST /api/v1/agents/:id/portfolio/handover
// ─────────────────────────────────────────────────────────────────────────────
const handoverPortfolio = asyncHandler(async (req, res) => {
  const { targetAgentId, transferAll, customerIds, pigmyIds } = req.body;

  const result = await reassignmentService.handoverPortfolio({
    sourceAgentId: req.agentUser._id,
    targetAgentId,
    transferAll,
    customerIds,
    pigmyIds,
    performedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.headers["x-request-id"] || null,
  });

  return res.status(200).json(new ApiResponse(200, result, result.message));
});

module.exports = {
  getReassignmentQueue,
  reassignAgents,
  getReassignmentStats,
  getAgentPortfolio,
  handoverPortfolio,
};
