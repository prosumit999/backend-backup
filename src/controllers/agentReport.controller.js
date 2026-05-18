// src/controllers/agentReport.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// Agent-specific report endpoints. All data is scoped to the requesting agent
// — no param injection possible. agentId is always taken from req.user._id.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const PigmyAccount = require("../models/PigmyAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const Collection = require("../models/Collection.model");
const AgentDeposit = require("../models/AgentDeposit.model");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { ACCOUNT_STATUS, LOAN_STATUS, PAGINATION } = require("../config/constants");
const { getBusinessDate } = require("../utils/dayGuard");
const escapeRegex = require("../utils/escapeRegex");

// ─────────────────────────────────────────────────────────────────────────────
// 1. PIGMY REPORT — Customer-wise pigmy collection summary
//    Shows all pigmy accounts assigned to this agent with collection stats
// ─────────────────────────────────────────────────────────────────────────────
const getPigmyReport = asyncHandler(async (req, res) => {
  const agentId = req.user._id;
  const { fromDate, toDate, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, PAGINATION.MAX_LIMIT);

  // Fetch all active pigmy accounts assigned to this agent
  const filter = {
    assignedAgent: agentId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  };

  const accounts = await PigmyAccount.find(filter)
    .populate("customer", "name customerCode phone")
    .select("accountNumber dailyDepositAmountInPaise balanceInPaise totalCollectedInPaise customer maturityDate status createdAt")
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const total = await PigmyAccount.countDocuments(filter);

  // For each account, count collections in the date range
  const dateFilter = {};
  if (fromDate) dateFilter.$gte = new Date(fromDate);
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.$lte = end;
  }

  const accountsWithStats = await Promise.all(
    accounts.map(async (acc) => {
      const collFilter = {
        pigmyAccount: acc._id,
        isReversed: false,
      };
      if (Object.keys(dateFilter).length > 0) {
        collFilter.collectionDate = dateFilter;
      }
      const collStats = await Collection.aggregate([
        { $match: collFilter },
        {
          $group: {
            _id: null,
            totalCollected: { $sum: "$amountInPaise" },
            count: { $sum: 1 },
          },
        },
      ]);

      const stats = collStats[0] || { totalCollected: 0, count: 0 };

      return {
        ...acc,
        periodCollections: stats.count,
        periodCollectedInPaise: stats.totalCollected,
      };
    }),
  );

  return res.status(200).json(
    new ApiResponse(200, {
      accounts: accountsWithStats,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }, "Pigmy report fetched."),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOAN REPORT — Loan status for customers assigned to this agent
// ─────────────────────────────────────────────────────────────────────────────
const getLoanReport = asyncHandler(async (req, res) => {
  const agentId = req.user._id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, PAGINATION.MAX_LIMIT);

  // Find all pigmy accounts for this agent → get unique customerIds
  const assignedCustomerIds = await PigmyAccount.distinct("customer", {
    assignedAgent: agentId,
    isDeleted: false,
  });

  const filter = {
    customer: { $in: assignedCustomerIds },
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE, LOAN_STATUS.CLOSED, LOAN_STATUS.WRITTEN_OFF] },
    isDeleted: false,
  };

  const [loans, total] = await Promise.all([
    LoanAccount.find(filter)
      .populate("customer", "name customerCode phone")
      .select("loanAccountNumber principalAmountInPaise outstandingBalanceInPaise totalPaidInPaise status overdueCount penaltyAmountInPaise createdAt maturityDate")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    LoanAccount.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, {
      loans,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }, "Loan report fetched."),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. COLLECTION REPORT — Date-wise collection history for this agent
// ─────────────────────────────────────────────────────────────────────────────
const getCollectionReport = asyncHandler(async (req, res) => {
  const agentId = req.user._id;
  const { fromDate, toDate } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, PAGINATION.MAX_LIMIT);

  const filter = {
    collectedBy: agentId,
    isReversed: false,
  };

  if (fromDate || toDate) {
    filter.collectionDate = {};
    if (fromDate) filter.collectionDate.$gte = new Date(fromDate);
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      filter.collectionDate.$lte = end;
    }
  }

  const [collections, total, totals] = await Promise.all([
    Collection.find(filter)
      .populate("customer", "name customerCode")
      .populate("pigmyAccount", "accountNumber")
      .select("receiptNumber amountInPaise collectionDate collectionType status customer pigmyAccount")
      .sort({ collectionDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Collection.countDocuments(filter),
    Collection.aggregate([
      { $match: filter },
      { $group: { _id: null, totalInPaise: { $sum: "$amountInPaise" }, count: { $sum: 1 } } },
    ]),
  ]);

  const summary = totals[0] || { totalInPaise: 0, count: 0 };

  return res.status(200).json(
    new ApiResponse(200, {
      collections,
      summary: { totalInPaise: summary.totalInPaise, totalCount: summary.count },
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }, "Collection report fetched."),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DEPOSIT REPORT — Agent's own cash deposit history at office
// ─────────────────────────────────────────────────────────────────────────────
const getDepositReport = asyncHandler(async (req, res) => {
  const agentId = req.user._id;
  const { fromDate, toDate } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, PAGINATION.MAX_LIMIT);

  const filter = { agent: agentId, isDeleted: false };

  if (fromDate || toDate) {
    filter.businessDate = {};
    if (fromDate) filter.businessDate.$gte = new Date(fromDate);
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      filter.businessDate.$lte = end;
    }
  }

  const [deposits, total, totals] = await Promise.all([
    AgentDeposit.find(filter)
      .populate("receivedBy", "name")
      .select("receiptNumber amountInPaise businessDate status receivedBy createdAt note isReversed")
      .sort({ businessDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AgentDeposit.countDocuments(filter),
    AgentDeposit.aggregate([
      { $match: filter },
      { $group: { _id: null, totalInPaise: { $sum: "$amountInPaise" }, count: { $sum: 1 } } },
    ]),
  ]);

  const summary = totals[0] || { totalInPaise: 0, count: 0 };

  return res.status(200).json(
    new ApiResponse(200, {
      deposits,
      summary: { totalInPaise: summary.totalInPaise, totalCount: summary.count },
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }, "Deposit report fetched."),
  );
});

module.exports = {
  getPigmyReport,
  getLoanReport,
  getCollectionReport,
  getDepositReport,
};
