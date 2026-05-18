"use strict";

const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const Transaction = require("../models/Transaction.model");
const { ROLES, PAGINATION } = require("../config/constants");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");
const mongoose = require("mongoose");

const toObjId = (id) => new mongoose.Types.ObjectId(id);

// ── GET /api/v1/transactions ──────────────────────────────────────────────────
// Query params: fromDate, toDate, type, customerId, accountNumber, status, page, limit
// Roles: admin, superadmin only
const listTransactions = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (![ROLES.ADMIN, ROLES.SUPERADMIN].includes(role)) {
    throw ApiError.forbidden("Access denied: admin or superadmin only.");
  }

  const {
    fromDate, toDate, type, customerId, status,
    page = 1, limit = 50,
  } = req.query;

  const safeLimit = Math.min(Number(limit), 200);
  const skip = (Number(page) - 1) * safeLimit;

  // ── Build match ─────────────────────────────────────────────────────────
  const match = { isDeleted: false };

  if (fromDate || toDate) {
    match.businessDate = {};
    if (fromDate) match.businessDate.$gte = startOfDay(new Date(fromDate));
    if (toDate) match.businessDate.$lte = endOfDay(new Date(toDate));
  }

  if (type) match.type = type;
  if (status) match.status = status;
  if (customerId && /^[0-9a-fA-F]{24}$/.test(customerId)) {
    match.customer = toObjId(customerId);
  }

  const [transactions, total] = await Promise.all([
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate("customer", "name customerCode phone")
      .populate("performedBy", "name role adminCode agentCode")
      .populate("fromSavingAccount", "accountNumber")
      .populate("toSavingAccount", "accountNumber")
      .populate("fromPigmyAccount", "accountNumber")
      .populate("toPigmyAccount", "accountNumber")
      .populate("fromLoanAccount", "loanAccountNumber")
      .populate("toLoanAccount", "loanAccountNumber")
      .lean(),
    Transaction.countDocuments(match),
  ]);

  return res.status(200).json(
    new ApiResponse(200, {
      transactions,
      pagination: {
        total,
        page: Number(page),
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    }, "Transactions fetched")
  );
});

// ── GET /api/v1/transactions/:txnId ──────────────────────────────────────────
// Accepts: MongoDB ObjectId OR transactionId string (e.g. TXN-2026-00001)
const getTransaction = asyncHandler(async (req, res) => {
  const role = req.user.role;
  if (![ROLES.ADMIN, ROLES.SUPERADMIN].includes(role)) {
    throw ApiError.forbidden("Access denied: admin or superadmin only.");
  }

  const { txnId } = req.params;
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(txnId);

  const query = isObjectId
    ? { _id: txnId, isDeleted: false }
    : { transactionId: txnId.toUpperCase(), isDeleted: false };

  const txn = await Transaction.findOne(query)
    .populate("customer", "name customerCode phone")
    .populate("performedBy", "name role adminCode agentCode")
    .populate("fromSavingAccount", "accountNumber")
    .populate("toSavingAccount", "accountNumber")
    .populate("fromPigmyAccount", "accountNumber")
    .populate("toPigmyAccount", "accountNumber")
    .populate("fromLoanAccount", "loanAccountNumber")
    .populate("toLoanAccount", "loanAccountNumber")
    .lean();

  if (!txn) throw new ApiError(404, `Transaction not found: ${txnId}`);

  return res.status(200).json(
    new ApiResponse(200, { transaction: txn }, "Transaction fetched")
  );
});

module.exports = { listTransactions, getTransaction };
