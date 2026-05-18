// src/controllers/collection.controller.js
"use strict";

const collectionService = require("../services/collection.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { ROLES } = require("../config/constants");
const { toObjId } = require("../utils/dateHelpers");

const recordCollection = asyncHandler(async (req, res) => {
  // Only admin/superadmin can manually record under a different agent
  let agentId;
  if (req.user.role === ROLES.ADMIN || req.user.role === ROLES.SUPERADMIN) {
    agentId = req.body.agentId || req.user._id;
  } else {
    // AGENT role: always their own ID, body.agentId is ignored
    agentId = req.user._id;
  }

  const { accountId, amountInPaise, note, collectionDate, collectionType } = req.body;

  const collection = await collectionService.recordCollection({
    accountId,
    amountInPaise,
    collectionType,
    note: note?.trim() || "",
    collectionDate,
    agentId,
    recordedBy: req.user._id,
    requestingUserRole: req.user.role,
    ipAddress: req.ip,
    requestId: req.id,
  });

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        collection,
      },
      `Collection recorded. Receipt: ${collection.receiptNumber}`,
    ),
  );
});

const getCollection = asyncHandler(async (req, res) => {
  const collection = await collectionService.getCollection(req.params.id);
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        collection,
      },
      "Collection fetched",
    ),
  );
});

const listCollections = asyncHandler(async (req, res) => {
  const result = await collectionService.listCollections({
    ...req.query,
    requestingUserRole: req.user.role,
    requestingUserId: req.user._id,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Collections fetched"));
});

const getAgentDailySheet = asyncHandler(async (req, res) => {
  const agentId = req.params.agentId
    ? toObjId(req.params.agentId, "agentId")
    : req.user._id;

  const result = await collectionService.getAgentDailySheet({
    agentId,
    date: req.query.date,
    requestingUserId: req.user._id,
    requestingUserRole: req.user.role,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Daily sheet fetched"));
});

const reverseCollection = asyncHandler(async (req, res) => {
  const collectionId = toObjId(req.params.id, "collectionId");
  const result = await collectionService.reverseCollection({
    collectionId,
    reversalReason: req.body.reversalReason,
    reversedBy: req.user._id,
    ipAddress: req.ip,
    requestId: req.id,
  });
  return res.status(200).json(new ApiResponse(200, result, result.message));
});

const getDailySummary = asyncHandler(async (req, res) => {
  const result = await collectionService.getDailySummary(req.query.date);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Daily summary fetched"));
});

const getMissedCollections = asyncHandler(async (req, res) => {
  const result = await collectionService.getMissedCollections({
    date: req.query.date,
    agentId: req.query.agentId,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Missed collections fetched"));
});

const getAgentWiseReport = asyncHandler(async (req, res) => {
  const result = await collectionService.getAgentWiseReport({
    fromDate: req.query.fromDate,
    toDate: req.query.toDate,
    agentId: req.query.agentId,
  });
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Agent-wise collection report fetched"));
});

module.exports = {
  recordCollection,
  getCollection,
  listCollections,
  getAgentDailySheet,
  reverseCollection,
  getDailySummary,
  getMissedCollections,
  getAgentWiseReport,
};
