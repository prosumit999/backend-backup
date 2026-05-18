// src/services/ledger.service.js
// ═════════════════════════════════════════════════════════════════════════════
// LEDGER SERVICE — Production-grade double-entry ledger API layer
//
// All functions are READ-ONLY except postManualJournalVoucher().
// Reads use .lean() for maximum performance.
// Writes are wrapped in withTransaction() for atomicity.
// ═════════════════════════════════════════════════════════════════════════════
"use strict";

const mongoose = require("mongoose");
const LedgerAccount = require("../models/LedgerAccount.model");
const LedgerEntry = require("../models/LedgerEntry.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const ledger = require("../utils/ledger");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const withTransaction = require("../utils/withTransaction");
const { generateTransactionId } = require("../utils/generateCode");
const {
  AUDIT_ACTIONS,
  AUDIT_STATUS,
} = require("../config/constants");


const { startOfDay, endOfDay } = require("../utils/dateHelpers");

// ─────────────────────────────────────────────────────────────────────────────
// Industry standard: Assets→ Liab → Equity → Income → Exp
const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];

// ═════════════════════════════════════════════════════════════════════════════
// 1. GENERAL LEDGER — Chart of Accounts with running balances
//
// Returns all ledger accounts grouped by type, with:
//   - Per-account: code, name, type, normalBalance, runningBalance, isSystem
//   - Per-group totals
//   - Balance sheet summary: totalAssets, totalLiabilities, netWorth
//   - P&L summary: totalIncome, totalExpense, netProfit
//   - Accounting equation check: Assets = Liabilities + Equity
// ═════════════════════════════════════════════════════════════════════════════
const getGeneralLedger = async () => {
  const accounts = await LedgerAccount.find({ isActive: true })
    .sort({ code: 1 })
    .lean();

  // Group by type
  const groups = {};
  for (const type of TYPE_ORDER) {
    groups[type] = {
      type,
      accounts: [],
      totalBalanceInPaise: 0,
    };
  }

  for (const acc of accounts) {
    const group = groups[acc.type];
    if (!group) continue;
    group.accounts.push({
      _id: acc._id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.normalBalance,
      runningBalanceInPaise: acc.runningBalanceInPaise || 0,
      description: acc.description,
      isSystem: acc.isSystem,
      isAgentAccount: acc.isAgentAccount || false,
      agentRef: acc.agentRef,
    });
    group.totalBalanceInPaise += acc.runningBalanceInPaise || 0;
  }

  const totalAssetsInPaise = groups.asset.totalBalanceInPaise;
  const totalLiabilitiesInPaise = groups.liability.totalBalanceInPaise;
  const totalEquityInPaise = groups.equity.totalBalanceInPaise;
  const totalIncomeInPaise = groups.income.totalBalanceInPaise;
  const totalExpenseInPaise = groups.expense.totalBalanceInPaise;

  // Balance Sheet: Net Worth = Assets − Liabilities
  const netWorthInPaise = totalAssetsInPaise - totalLiabilitiesInPaise;
  // P&L: Net Profit = Income − Expense
  const netProfitInPaise = totalIncomeInPaise - totalExpenseInPaise;

  // Accounting Equation: Assets = Liabilities + Equity + Retained Earnings (Net Profit)
  // In a growing company: Right Side = Liabilities + Capital + Profit
  const isEquationBalanced =
    Math.abs(
      totalAssetsInPaise -
      (totalLiabilitiesInPaise + totalEquityInPaise + netProfitInPaise)
    ) <= 1; // 1 paise rounding tolerance

  return {
    generatedAt: new Date().toISOString(),
    groups: TYPE_ORDER.map((t) => groups[t]).filter((g) => g.accounts.length > 0),
    summary: {
      totalAssetsInPaise,
      totalLiabilitiesInPaise,
      totalEquityInPaise,      // NEW: Owner's Capital + Opening Balance Equity
      totalIncomeInPaise,
      totalExpenseInPaise,
      netWorthInPaise,          // Assets − Liabilities
      netProfitInPaise,         // Income − Expense (P&L)
      isEquationBalanced,       // Assets = Liabilities + Equity + NetProfit
      totalAccounts: accounts.length,
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. ACCOUNT STATEMENT — Entries for one account within a date range
//
// Industry standard: shows opening balance + all entries + closing balance.
// Opening balance = sum of all entries BEFORE fromDate.
// Running balance column is computed server-side for the statement period.
// ═════════════════════════════════════════════════════════════════════════════
const getAccountStatement = async ({
  ledgerAccountId,
  fromDate,
  toDate,
  page = 1,
  limit = 100,
}) => {
  // Validate account exists
  const account = await LedgerAccount.findById(ledgerAccountId).lean();
  if (!account) throw new ApiError(404, "Ledger account not found.");

  const from = startOfDay(fromDate);
  const to = endOfDay(toDate);
  const skip = (page - 1) * limit;

  // Opening balance = sum of all entries BEFORE the from date
  const openingAgg = await LedgerEntry.aggregate([
    {
      $match: {
        ledgerAccount: new mongoose.Types.ObjectId(ledgerAccountId),
        businessDate: { $lt: from },
      },
    },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: "$debitInPaise" },
        totalCredit: { $sum: "$creditInPaise" },
      },
    },
  ]);

  const openingRaw = openingAgg[0] || { totalDebit: 0, totalCredit: 0 };
  // Opening balance = net of debits and credits, sign depends on normalBalance
  const openingBalanceInPaise =
    account.normalBalance === "debit"
      ? openingRaw.totalDebit - openingRaw.totalCredit
      : openingRaw.totalCredit - openingRaw.totalDebit;

  // Fetch entries in date range
  const [entries, total, periodAgg] = await Promise.all([
    LedgerEntry.find({
      ledgerAccount: ledgerAccountId,
      businessDate: { $gte: from, $lte: to },
    })
      .populate("performedBy", "name role")
      .populate("transaction", "transactionId type")
      .sort({ businessDate: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    LedgerEntry.countDocuments({
      ledgerAccount: ledgerAccountId,
      businessDate: { $gte: from, $lte: to },
    }),

    // Period totals (for the FULL range, not just this page)
    LedgerEntry.aggregate([
      {
        $match: {
          ledgerAccount: new mongoose.Types.ObjectId(ledgerAccountId),
          businessDate: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: "$debitInPaise" },
          totalCredit: { $sum: "$creditInPaise" },
        },
      },
    ]),
  ]);

  const period = periodAgg[0] || { totalDebit: 0, totalCredit: 0 };

  // Compute running balance for each entry on this page
  // Start from opening balance, add entries in order
  // This only works correctly for page 1; for subsequent pages we need the balance
  // at the end of the previous page — we compute it via a separate query.
  let runningBalancePriorToPage = openingBalanceInPaise;
  if (page > 1) {
    const priorPageAgg = await LedgerEntry.aggregate([
      {
        $match: {
          ledgerAccount: new mongoose.Types.ObjectId(ledgerAccountId),
          businessDate: { $gte: from, $lte: to },
        },
      },
      { $sort: { businessDate: 1, createdAt: 1 } },
      { $limit: skip },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: "$debitInPaise" },
          totalCredit: { $sum: "$creditInPaise" },
        },
      },
    ]);
    const priorRaw = priorPageAgg[0] || { totalDebit: 0, totalCredit: 0 };
    const priorDelta =
      account.normalBalance === "debit"
        ? priorRaw.totalDebit - priorRaw.totalCredit
        : priorRaw.totalCredit - priorRaw.totalDebit;
    runningBalancePriorToPage = openingBalanceInPaise + priorDelta;
  }

  let runningBalance = runningBalancePriorToPage;
  const enrichedEntries = entries.map((e) => {
    const delta =
      account.normalBalance === "debit"
        ? e.debitInPaise - e.creditInPaise
        : e.creditInPaise - e.debitInPaise;
    runningBalance += delta;
    return {
      ...e,
      runningBalanceInPaise: runningBalance,
    };
  });

  // Closing balance = opening + net movement in period (always for full period)
  const periodDelta =
    account.normalBalance === "debit"
      ? period.totalDebit - period.totalCredit
      : period.totalCredit - period.totalDebit;
  const closingBalanceInPaise = openingBalanceInPaise + periodDelta;

  return {
    account: {
      _id: account._id,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      currentRunningBalanceInPaise: account.runningBalanceInPaise || 0,
    },
    period: {
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    },
    openingBalanceInPaise,
    closingBalanceInPaise,
    periodTotals: {
      totalDebitInPaise: period.totalDebit,
      totalCreditInPaise: period.totalCredit,
      netMovementInPaise: periodDelta,
    },
    entries: enrichedEntries,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. LEDGER JOURNAL — All entries (full audit trail)
//
// This is the complete ledger journal — every debit and credit entry ever
// posted in the system, filterable by date range, account, and entry type.
// Essential for auditors and reconciliation.
// ═════════════════════════════════════════════════════════════════════════════
const getLedgerJournal = async ({
  fromDate,
  toDate,
  page = 1,
  limit = 100,
  entryType, // "debit" | "credit" | undefined (all)
  ledgerCode, // filter by account code e.g. "1001"
}) => {
  const from = startOfDay(fromDate);
  const to = endOfDay(toDate);
  const skip = (page - 1) * limit;

  // Build match filter
  const match = {
    businessDate: { $gte: from, $lte: to },
  };

  // Filter by entry type
  if (entryType === "debit") {
    match.debitInPaise = { $gt: 0 };
  } else if (entryType === "credit") {
    match.creditInPaise = { $gt: 0 };
  }

  // Filter by ledger account code — requires lookup
  let ledgerAccountFilter = null;
  if (ledgerCode) {
    const acc = await LedgerAccount.findOne({ code: ledgerCode.trim().toUpperCase() }).lean();
    if (!acc) throw new ApiError(404, `Ledger account [${ledgerCode}] not found.`);
    match.ledgerAccount = acc._id;
    ledgerAccountFilter = acc;
  }

  const [entries, total, totalsAgg] = await Promise.all([
    LedgerEntry.find(match)
      .populate("ledgerAccount", "code name type normalBalance")
      .populate("performedBy", "name role")
      .populate("transaction", "transactionId type")
      .sort({ businessDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    LedgerEntry.countDocuments(match),

    // Always compute totals for the FULL filter (not just this page)
    LedgerEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalDebitInPaise: { $sum: "$debitInPaise" },
          totalCreditInPaise: { $sum: "$creditInPaise" },
          totalEntries: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totals = totalsAgg[0] || {
    totalDebitInPaise: 0,
    totalCreditInPaise: 0,
    totalEntries: 0,
  };

  return {
    period: {
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    },
    filters: {
      entryType: entryType || "all",
      ledgerCode: ledgerCode || null,
      ledgerAccountName: ledgerAccountFilter?.name || null,
    },
    totals: {
      totalDebitInPaise: totals.totalDebitInPaise,
      totalCreditInPaise: totals.totalCreditInPaise,
      isBalanced: totals.totalDebitInPaise === totals.totalCreditInPaise,
      differenceInPaise: Math.abs(
        totals.totalDebitInPaise - totals.totalCreditInPaise,
      ),
    },
    entries,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. LEDGER INTEGRITY CHECK — DR total === CR total
//
// The most important health check in any double-entry system.
// If totalDebits !== totalCredits at ANY point in time, the ledger is
// permanently corrupted and all financial data is unreliable.
// ═════════════════════════════════════════════════════════════════════════════
const checkLedgerIntegrity = async (asOfDate = null) => {
  const result = await LedgerEntry.verifyIntegrity(asOfDate);

  if (!result.isBalanced) {
    // Log as CRITICAL — this must be investigated immediately
    logger.error(
      `[LEDGER INTEGRITY] *** CRITICAL IMBALANCE DETECTED *** | ` +
      `DR: ${result.totalDebitsInPaise} paise | ` +
      `CR: ${result.totalCreditsInPaise} paise | ` +
      `Diff: ${result.differenceInPaise} paise | ` +
      `AsOf: ${asOfDate || "ALL TIME"}`,
    );
  } else {
    logger.info(
      `[LEDGER INTEGRITY] BALANCED ✓ | ` +
      `Total: ${result.totalDebitsInPaise} paise | ` +
      `AsOf: ${asOfDate || "ALL TIME"}`,
    );
  }

  return {
    ...result,
    checkedAt: new Date().toISOString(),
    asOfDate: asOfDate ? new Date(asOfDate).toISOString() : "ALL TIME",
    recommendation: result.isBalanced
      ? null
      : "HALT ALL FINANCIAL OPERATIONS. Run a full ledger audit immediately. Contact system administrator.",
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 5. POST MANUAL JOURNAL VOUCHER
//
// Manual adjustment entry. Must be:
//   - Balanced (DR total === CR total)
//   - Within an open business day
//   - Fully audited
//   - Wrapped in a MongoDB transaction
//
// Use cases: opening balance entry, correction of mispostings (via reversal),
// depreciation, accruals, bank interest, etc.
// ═════════════════════════════════════════════════════════════════════════════
const postManualJournalVoucher = async ({
  entries,
  narration,
  performedBy,
  ipAddress,
  requestId,
}) => {
  // ── Business Day Check ───────────────────────────────────────────────────
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Journal Voucher postings are financial transactions " +
      "and must be processed within an open business day.",
    );
  }

  const businessDate = await AppConfig.getCurrentBusinessDate();

  // ── Cross-validate DR = CR ───────────────────────────────────────────────
  const totalDebit = entries
    .filter((e) => e.type === "debit")
    .reduce((s, e) => s + e.amountInPaise, 0);
  const totalCredit = entries
    .filter((e) => e.type === "credit")
    .reduce((s, e) => s + e.amountInPaise, 0);

  if (totalDebit !== totalCredit) {
    throw new ApiError(
      422,
      `Journal Voucher is IMBALANCED. ` +
      `Total Debits: ₹${(totalDebit / 100).toFixed(2)}, ` +
      `Total Credits: ₹${(totalCredit / 100).toFixed(2)}, ` +
      `Difference: ₹${(Math.abs(totalDebit - totalCredit) / 100).toFixed(2)}. ` +
      `A Journal Voucher must balance before it can be posted.`,
    );
  }

  // ── Validate all ledger codes exist and are active ───────────────────────
  const uniqueCodes = [...new Set(entries.map((e) => e.ledgerCode.trim().toUpperCase()))];
  const accounts = await LedgerAccount.find({ code: { $in: uniqueCodes }, isActive: true }).lean();
  const accountMap = Object.fromEntries(accounts.map((a) => [a.code, a]));

  const missingCodes = uniqueCodes.filter((c) => !accountMap[c]);
  if (missingCodes.length > 0) {
    throw new ApiError(
      404,
      `Ledger account(s) not found or inactive: [${missingCodes.join(", ")}]. ` +
      `Verify the account codes in the Chart of Accounts.`,
    );
  }

  // ── Generate Voucher ID ──────────────────────────────────────────────────
  const txnRef = await generateTransactionId(businessDate);
  const voucherId = `JV-${txnRef}`;

  let postedEntries = [];

  // ── Atomic Transaction ───────────────────────────────────────────────────
  await withTransaction(async (session) => {
    postedEntries = await ledger.postJournalVoucher({
      entries: entries.map((e) => ({
        ...e,
        ledgerCode: e.ledgerCode.trim().toUpperCase(),
        description: e.description,
      })),
      narration,
      performedBy,
      requestId: requestId || null,
      journalVoucherId: voucherId,
      businessDate,
      session,
    });
  });

  // ── Audit Log ────────────────────────────────────────────────────────────
  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.JOURNAL_VOUCHER_POSTED,
    entity: "LedgerEntry",
    entityId: voucherId,
    newData: {
      voucherId,
      narration,
      totalAmountInPaise: totalDebit,
      entryCount: entries.length,
      accounts: uniqueCodes,
      businessDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[JV] AuditLog failed for ${voucherId}: ${e.message}`),
  );

  logger.info(
    `[JV] POSTED | ${voucherId} | ₹${(totalDebit / 100).toFixed(2)} | ` +
    `${entries.length} legs | Narration: ${narration.substring(0, 50)} | By: ${performedBy}`,
  );

  return {
    voucherId,
    narration,
    businessDate,
    totalAmountInPaise: totalDebit,
    entriesPosted: postedEntries.length,
    entries: postedEntries,
    message: `Journal Voucher ${voucherId} posted successfully — ${postedEntries.length} ledger entries created.`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 6. GET ACCOUNT BY CODE
// ═════════════════════════════════════════════════════════════════════════════
const getAccountByCode = async (code) => {
  const account = await LedgerAccount.findOne({ code: code.trim().toUpperCase(), isActive: true }).lean();
  if (!account) {
    throw new ApiError(404, `Ledger account with code [${code}] not found or inactive.`);
  }
  return {
    _id: account._id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
    runningBalanceInRupees: (account.runningBalanceInPaise / 100).toFixed(2)
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 7. GET TRANSACTION LEDGER TRAIL
//
// Returns the double-entry accounting trail (DR and CR entries) for a given
// transaction string ID (e.g. TXN-2026-000042).
// ═════════════════════════════════════════════════════════════════════════════
const getTransactionLedgerTrail = async (transactionId) => {
  const Transaction = require("../models/Transaction.model");
  
  const transaction = await Transaction.findOne({ transactionId }).lean();
  if (!transaction) {
    throw new ApiError(404, `Transaction [${transactionId}] not found.`);
  }

  const entries = await LedgerEntry.find({ transaction: transaction._id })
    .populate("ledgerAccount", "code name type normalBalance")
    .sort({ debitInPaise: -1 }) // Sort Debits first, then Credits
    .lean();

  return {
    transaction,
    entries,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  getGeneralLedger,
  getAccountStatement,
  getLedgerJournal,
  checkLedgerIntegrity,
  postManualJournalVoucher,
  getAccountByCode,
  getTransactionLedgerTrail,
};
