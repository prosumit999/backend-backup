// src/models/LedgerAccount.model.js
// ─────────────────────────────────────────────────────────────────────────────
// CHART OF ACCOUNTS
//
// One document per ledger account. System accounts are seeded once on startup
// via seedSystemAccounts() and are permanently immutable (isSystem: true).
//
// normalBalance: 'debit' | 'credit'
// 'debit'  → Asset / Expense    (DR increases the balance)
// 'credit' → Liability / Income (CR increases the balance)
//
// runningBalanceInPaise is updated atomically on every createDoublePair() call.
//
// AGENT ACCOUNTS:
// Each agent gets one personal cash ledger account created atomically inside
// agent.service.createAgent() withTransaction block.
// code format : "AGNT-" + agentCode  e.g. AGNT-AGT-2024-001
// type        : asset  (normalBalance: debit)
// isSystem    : false  (admin can deactivate if agent is terminated)
// isAgentAccount: true (used by dayClose to find unsettled agents)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { LEDGER_ACCOUNT_TYPES } = require("../config/constants");
const ApiError = require("../utils/ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// normalBalance → type invariant map
// Extracted as a module-level constant so it can be reused by the static
// validator (called from superadmin.service updateLedgerAccount, same pattern
// as LoanPlan.validateAmountLimits).
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED_NORMAL_BALANCE = Object.freeze({
  asset: "debit",
  expense: "debit",
  liability: "credit",
  income: "credit",
  equity: "credit",
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const LedgerAccountSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      enum: Object.values(LEDGER_ACCOUNT_TYPES),
    },
    normalBalance: {
      type: String,
      required: true,
      enum: ["debit", "credit"],
    },
    runningBalanceInPaise: {
      type: Number,
      default: 0,
    },
    description: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // NEW default: false → opt-in to system protection.
    //   seedSystemAccounts() explicitly passes isSystem: true (unchanged).
    //   agent.service.createAgent() explicitly passes isSystem: false (unchanged).
    //   Superadmin API-created accounts default to non-system (correct).
    isSystem: {
      type: Boolean,
      default: false,
    },

    // ── Agent Cash Account Fields ─────────────────────────────────────────
    isAgentAccount: {
      type: Boolean,
      default: false,
      index: true,
    },
    agentRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// Sparse index on agentRef — only ~N agent accounts are in this index.
// Allows fast lookup: LedgerAccount.findOne({ agentRef: userId })
LedgerAccountSchema.index(
  { agentRef: 1 },
  { sparse: true, name: "idx_agentRef_sparse" },
);

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM ACCOUNT PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
LedgerAccountSchema.pre(["deleteOne", "findOneAndDelete"], async function () {
  const filter = this.getFilter?.() || {};
  const doc = await mongoose.model("LedgerAccount").findOne(filter).lean();
  if (doc?.isSystem) {
    throw new Error(
      `LedgerAccount [${doc.code}] "${doc.name}" is a system account and cannot be deleted. ` +
      `System accounts are permanent. Contact superadmin if a structural change is required.`,
    );
  }
});

LedgerAccountSchema.pre("deleteMany", async function () {
  const filter = this.getFilter?.() || {};
  const systemCount = await mongoose
    .model("LedgerAccount")
    .countDocuments({ ...filter, isSystem: true });
  if (systemCount > 0) {
    throw new Error(
      `deleteMany blocked: ${systemCount} system account(s) match the filter. ` +
      `System accounts cannot be deleted.`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: normalBalance ↔ type invariant check
// NOTE: Same limitation as LoanPlan — this hook does not run on findByIdAndUpdate.
// If superadmin.service updates type or normalBalance via findByIdAndUpdate,
// call LedgerAccount.validateNormalBalance(updates, existingDoc) beforehand,
// same pattern as LoanPlan.validateAmountLimits().
// ─────────────────────────────────────────────────────────────────────────────
LedgerAccountSchema.statics.validateNormalBalance = function (
  updates,
  existingDoc = {},
) {
  const type = updates.type ?? existingDoc.type;
  const normalBalance = updates.normalBalance ?? existingDoc.normalBalance;

  if (!type || !normalBalance) return; // incomplete doc — schema required: true will catch it

  const expected = EXPECTED_NORMAL_BALANCE[type];
  if (normalBalance !== expected) {
    throw new ApiError(
      400,
      `Invalid normalBalance '${normalBalance}' for type '${type}'. ` +
      `Expected '${expected}'.`,
    );
  }
};

LedgerAccountSchema.pre("save", function () {
  this.constructor.validateNormalBalance({
    type: this.type,
    normalBalance: this.normalBalance,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findByCode
// ─────────────────────────────────────────────────────────────────────────────
LedgerAccountSchema.statics.findByCode = function (code, session = null) {
  const query = this.findOne({ code, isActive: true });
  return session ? query.session(session) : query;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: updateRunningBalance
// ─────────────────────────────────────────────────────────────────────────────
LedgerAccountSchema.statics.updateRunningBalance = async function (
  accountId,
  debitAmountInPaise,
  creditAmountInPaise,
  session = null,
  normalBalance = null,
) {
  const opts = session ? { session } : {};

  let nb = normalBalance;
  if (!nb) {
    const query = this.findById(accountId);
    const account = session ? await query.session(session) : await query;

    if (!account) {
      throw new ApiError(
        500,
        `CRITICAL: LedgerAccount [${accountId}] not found. ` +
        `Cannot update running balance. Run seedSystemAccounts() to restore.`,
      );
    }
    nb = account.normalBalance;
  }

  const delta =
    nb === "debit"
      ? debitAmountInPaise - creditAmountInPaise
      : creditAmountInPaise - debitAmountInPaise;

  if (delta < 0) {
    const updated = await this.findOneAndUpdate(
      {
        _id: accountId,
        runningBalanceInPaise: { $gte: Math.abs(delta) },
      },
      { $inc: { runningBalanceInPaise: delta } },
      { returnDocument: "after", ...opts },
    );

    if (!updated) {
      // Read current balance for error message — inside session if available
      const currentQuery = this.findById(accountId).lean();
      const current = session
        ? await currentQuery.session(session)
        : await currentQuery;
      throw new ApiError(
        400,
        `Insufficient balance in ledger account ` +
        `[${current?.code || accountId}] "${current?.name || "unknown"}". ` +
        `Current balance: ₹${((current?.runningBalanceInPaise || 0) / 100).toFixed(2)}, ` +
        `Attempted decrease: ₹${(Math.abs(delta) / 100).toFixed(2)}. ` +
        `Ensure sufficient company cash before disbursing. Transaction aborted.`,
      );
    }

    return updated;
  }

  return this.findByIdAndUpdate(
    accountId,
    { $inc: { runningBalanceInPaise: delta } },
    { returnDocument: "after", ...opts },
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: seedSystemAccounts
// ─────────────────────────────────────────────────────────────────────────────
LedgerAccountSchema.statics.seedSystemAccounts = async function () {
  const systemAccounts = [
    {
      code: "1001",
      name: "Cash in Hand",
      type: "asset",
      normalBalance: "debit",
      description: "Physical cash held by company/agents",
    },
    {
      code: "1002",
      name: "Loans Receivable",
      type: "asset",
      normalBalance: "debit",
      description: "Outstanding loan amounts customers owe",
    },
    {
      code: "2001",
      name: "Customer Saving Deposits",
      type: "liability",
      normalBalance: "credit",
      description: "Customer saving account balances we owe",
    },
    {
      code: "2002",
      name: "Customer Pigmy Deposits",
      type: "liability",
      normalBalance: "credit",
      description: "Customer pigmy account balances we owe",
    },
    {
      code: "3001",
      name: "Processing Fee Income",
      type: "income",
      normalBalance: "credit",
      description: "2% processing fee on loan disbursement",
    },
    {
      code: "3002",
      name: "Penalty Interest Income",
      type: "income",
      normalBalance: "credit",
      description: "Daily penalty interest after loan tenure expires",
    },
    {
      code: "3003",
      name: "Account Opening Income",
      type: "income",
      normalBalance: "credit",
      description: "One-time saving account opening charge",
    },
    {
      code: "3004",
      name: "Interest Income",
      type: "income",
      normalBalance: "credit",
      description: "Upfront flat interest deducted at loan disbursement",
    },
    {
      code: "4001",
      name: "Agent Commission Expense",
      type: "expense",
      normalBalance: "debit",
      description: "Agent commission payments",
    },
    {
      code: "4002",
      name: "Staff Salary Expense",
      type: "expense",
      normalBalance: "debit",
      description: "Staff salary payments",
    },
    {
      code: "4003",
      name: "Office Rent Expense",
      type: "expense",
      normalBalance: "debit",
      description: "Monthly office rent",
    },
    {
      code: "4004",
      name: "Miscellaneous Expense",
      type: "expense",
      normalBalance: "debit",
      description: "Miscellaneous business expenses",
    },
    {
      code: "5001",
      name: "Opening Balance Equity",
      type: "equity",
      normalBalance: "credit",
      description: "Equity from opening balances",
    },
    {
      code: "5002",
      name: "Owner's Capital",
      type: "equity",
      normalBalance: "credit",
      description: "Capital invested by the owner",
    },
    {
      code: "4005",
      name: "Loan Write-off Expense",
      type: "expense",
      normalBalance: "debit",
      description: "Bad debt written off — admin decision only",
    },
  ];

  for (const acc of systemAccounts) {
    await this.findOneAndUpdate(
      { code: acc.code },
      { $setOnInsert: { ...acc, isSystem: true, isActive: true } },
      { upsert: true },
    );
  }

  // SELF-HEALING: If an account in DB is 'isSystem' but NOT in the list above,
  // it means it was removed from code and should be 'unlocked' in DB.
  const currentSystemCodes = systemAccounts.map((a) => a.code);
  await this.updateMany(
    {
      code: { $nin: currentSystemCodes },
      isSystem: true,
    },
    { $set: { isSystem: false } },
  );
};

module.exports = mongoose.model("LedgerAccount", LedgerAccountSchema);
