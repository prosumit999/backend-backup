// src/controllers/ledger.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// LEDGER CONTROLLER — thin HTTP adapter for ledger.service.js
// All business logic lives in the service; this layer only handles:
//   • Request param extraction
//   • Unified success response shape
//   • Error forwarding via next(err)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const svc = require("../services/ledger.service");
const ApiError = require("../utils/ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/general
// Returns: Chart of Accounts grouped by type, with balance sheet & P&L totals
// ─────────────────────────────────────────────────────────────────────────────
const getGeneralLedger = async (req, res, next) => {
  try {
    const data = await svc.getGeneralLedger();
    return res.status(200).json({
      success: true,
      requestId: req.id,
      message: "General Ledger retrieved successfully.",
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/accounts/:id/statement
// Query params: fromDate, toDate, page, limit
// Returns: account header + opening balance + entries with running balance + closing balance
// ─────────────────────────────────────────────────────────────────────────────
const getAccountStatement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fromDate, toDate, page, limit } = req.query;

    const data = await svc.getAccountStatement({
      ledgerAccountId: id,
      fromDate,
      toDate,
      page: Number(page) || 1,
      limit: Number(limit) || 100,
    });

    return res.status(200).json({
      success: true,
      requestId: req.id,
      message: `Account statement for [${data.account.code}] ${data.account.name} retrieved.`,
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/journal
// Query params: fromDate, toDate, page, limit, entryType, ledgerCode
// Returns: all ledger entries in date range with pagination and period totals
// ─────────────────────────────────────────────────────────────────────────────
const getLedgerJournal = async (req, res, next) => {
  try {
    const { fromDate, toDate, page, limit, entryType, ledgerCode } = req.query;

    const data = await svc.getLedgerJournal({
      fromDate,
      toDate,
      page: Number(page) || 1,
      limit: Number(limit) || 100,
      entryType: entryType || null,
      ledgerCode: ledgerCode || null,
    });

    return res.status(200).json({
      success: true,
      requestId: req.id,
      message: "Ledger journal retrieved successfully.",
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/integrity
// Optional query: asOfDate
// Returns: isBalanced, totalDebits, totalCredits, difference
// ─────────────────────────────────────────────────────────────────────────────
const checkLedgerIntegrity = async (req, res, next) => {
  try {
    const { asOfDate } = req.query;
    const data = await svc.checkLedgerIntegrity(asOfDate || null);

    const statusCode = data.isBalanced ? 200 : 500;
    return res.status(statusCode).json({
      success: data.isBalanced,
      requestId: req.id,
      message: data.integrityStatus,
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /ledger/journal-voucher
// Body: { narration, entries: [{ ledgerCode, type, amountInPaise, description? }] }
// Returns: voucherId, entries posted, confirmation
// ─────────────────────────────────────────────────────────────────────────────
const postJournalVoucher = async (req, res, next) => {
  try {
    const { narration, entries } = req.body;

    const data = await svc.postManualJournalVoucher({
      narration,
      entries,
      performedBy: req.user._id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    return res.status(201).json({
      success: true,
      requestId: req.id,
      message: data.message,
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/accounts/code/:code
// Returns: details of a single ledger account by its string code
// ─────────────────────────────────────────────────────────────────────────────
const getAccountByCode = async (req, res, next) => {
  try {
    const { code } = req.params;
    const data = await svc.getAccountByCode(code);
    return res.status(200).json({
      success: true,
      requestId: req.id,
      message: `Ledger account [${code}] retrieved successfully.`,
      data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /ledger/transaction/:transactionId/trail
// Returns: the double-entry ledger pair for a given transaction
// ─────────────────────────────────────────────────────────────────────────────
const getTransactionTrail = async (req, res, next) => {
  try {
    const { transactionId } = req.params;
    const data = await svc.getTransactionLedgerTrail(transactionId);
    return res.status(200).json({
      success: true,
      requestId: req.id,
      message: `Ledger trail for transaction [${transactionId}] retrieved.`,
      data,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getGeneralLedger,
  getAccountStatement,
  getLedgerJournal,
  checkLedgerIntegrity,
  postJournalVoucher,
  getAccountByCode,
  getTransactionTrail,
};
