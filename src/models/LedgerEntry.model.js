// src/models/LedgerEntry.model.js
// ─────────────────────────────────────────────────────────────────────────────
// DOUBLE-ENTRY LEDGER RECORD
//
// One record per leg of every financial event (debit OR credit — never both).
// Every business event posts exactly two LedgerEntry documents — one debit,
// one credit — always via createDoublePair(). Direct create() is forbidden.
//
// IMMUTABILITY:
// Ledger entries are permanently immutable — no update, no delete, ever.
// Pre-hooks enforce this at the Mongoose middleware level.
// Corrections = post a reversal entry pair with a clear narration.
//
// INTEGRITY:
// verifyIntegrity() checks totalDebits === totalCredits across all entries.
// Called nightly by reconcile.job.js. Any imbalance = stop operations.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const LedgerEntrySchema = new mongoose.Schema(
  {
    ledgerAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LedgerAccount",
      required: true,
      index: true,
    },
    debitInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditInPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    narration: {
      type: String,
      default: "",
      trim: true,
    },
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      index: true,
    },

    transactionRef: {
      type: String,
      default: null,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    requestId: {
      type: String,
      default: null,
    },
    businessDate: {
      type: Date,
      required: true,
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
// IMMUTABILITY ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────
const IMMUTABILITY_ERROR =
  "LedgerEntries are immutable. Accounting records cannot be modified or deleted. " +
  "To correct a mistake: create a reversal entry pair with a clear narration. " +
  "Contact superadmin if you believe this restriction is in error.";

LedgerEntrySchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findByIdAndUpdate",
    "replaceOne",
  ],
  function () {
    throw new Error(IMMUTABILITY_ERROR);
  },
);

LedgerEntrySchema.pre(
  ["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove"],
  function () {
    throw new Error(IMMUTABILITY_ERROR);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY-LEVEL VALIDATION (pre-save)
// Exactly one of debit or credit must be > 0.
// ─────────────────────────────────────────────────────────────────────────────
LedgerEntrySchema.pre("save", function () {
  const hasDebit = this.debitInPaise > 0;
  const hasCredit = this.creditInPaise > 0;

  if (hasDebit && hasCredit) {
    throw new Error(
      `LedgerEntry cannot have both debit and credit > 0. ` +
      `Debit: ${this.debitInPaise}, Credit: ${this.creditInPaise}. ` +
      `Each entry must be one leg of the double-entry pair.`,
    );
  }
  if (!hasDebit && !hasCredit) {
    throw new Error(
      "LedgerEntry must have either debit OR credit > 0. " +
      "Zero-value entries have no accounting meaning.",
    );
  }
  if (!this.businessDate) {
    throw new Error("businessDate is required on every LedgerEntry");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
LedgerEntrySchema.index({ ledgerAccount: 1, businessDate: -1 });
LedgerEntrySchema.index({ businessDate: 1 });
LedgerEntrySchema.index({ performedBy: 1, businessDate: -1 });

LedgerEntrySchema.index(
  { transactionRef: 1 },
  { sparse: true, name: "idx_transactionRef_sparse" },
);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: createDoublePair
//
// THE ONLY WAY to post ledger entries in this system.
// Posts one debit + one credit entry atomically inside a MongoDB session.
// SESSION IS MANDATORY — throws if called without one.
// ─────────────────────────────────────────────────────────────────────────────
LedgerEntrySchema.statics.createDoublePair = async function ({
  debitLedgerAccount,
  creditLedgerAccount,
  amountInPaise,
  description,
  narration = "",
  transaction = null,
  transactionRef = null,
  performedBy = null,
  requestId = null,
  businessDate,
  session,
}) {
  // ── MANDATORY SESSION GUARD ───────────────────────────────────────────────
  if (!session) {
    throw new Error(
      "CRITICAL: createDoublePair() requires a MongoDB session. " +
      "All ledger postings must be wrapped in withTransaction(). " +
      "Never call createDoublePair() outside a transaction — " +
      "a partial post leaves the ledger permanently imbalanced.",
    );
  }

  // ── Amount validation ─────────────────────────────────────────────────────
  if (!amountInPaise || amountInPaise <= 0) {
    throw new Error(
      `Invalid ledger amount: ${amountInPaise} paise. ` +
      `Must be a positive integer. Check calling code.`,
    );
  }

  // ── Account validation ────────────────────────────────────────────────────
  if (!debitLedgerAccount?._id) {
    throw new Error(
      "debitLedgerAccount with _id is required for createDoublePair",
    );
  }
  if (!creditLedgerAccount?._id) {
    throw new Error(
      "creditLedgerAccount with _id is required for createDoublePair",
    );
  }
  if (
    debitLedgerAccount._id.toString() === creditLedgerAccount._id.toString()
  ) {
    throw new Error(
      `Debit and Credit cannot be the same ledger account: [${debitLedgerAccount.code}]. ` +
      `This would be a circular entry with no net effect.`,
    );
  }

  // ── Business date validation ──────────────────────────────────────────────
  if (!businessDate) {
    throw new Error(
      "businessDate is required for every ledger posting. " +
      "Pass AppConfig.getCurrentBusinessDate() — never new Date().",
    );
  }

  const commonFields = {
    description,
    narration,
    transaction,
    transactionRef,
    performedBy,
    requestId,
    businessDate,
  };

  // ── Create both entries atomically inside session ─────────────────────────
  const [debitEntry, creditEntry] = await this.create(
    [
      {
        ...commonFields,
        ledgerAccount: debitLedgerAccount._id,
        debitInPaise: amountInPaise,
        creditInPaise: 0,
      },
      {
        ...commonFields,
        ledgerAccount: creditLedgerAccount._id,
        debitInPaise: 0,
        creditInPaise: amountInPaise,
      },
    ],
    { session, ordered: true },
  );

  // ── Update running balances atomically inside session ─────────────────────
  const LedgerAccount = require("./LedgerAccount.model");

  await Promise.all([
    LedgerAccount.updateRunningBalance(
      debitLedgerAccount._id,
      amountInPaise,
      0,
      session,
      debitLedgerAccount.normalBalance,
    ),
    LedgerAccount.updateRunningBalance(
      creditLedgerAccount._id,
      0,
      amountInPaise,
      session,
      creditLedgerAccount.normalBalance,
    ),
  ]);

  return { debitEntry, creditEntry };
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: verifyIntegrity
// Total DR must === Total CR across all entries.
// Called nightly by reconcile.job.js.
// ─────────────────────────────────────────────────────────────────────────────
LedgerEntrySchema.statics.verifyIntegrity = async function (asOfDate = null) {
  const matchCondition = asOfDate
    ? { businessDate: { $lte: endOfDay(asOfDate) } }
    : {};

  const result = await this.aggregate([
    { $match: matchCondition },
    {
      $group: {
        _id: null,
        totalDebits: { $sum: "$debitInPaise" },
        totalCredits: { $sum: "$creditInPaise" },
      },
    },
  ]);

  const totals = result[0] || { totalDebits: 0, totalCredits: 0 };
  const isBalanced = totals.totalDebits === totals.totalCredits;

  return {
    isBalanced,
    totalDebitsInPaise: totals.totalDebits,
    totalCreditsInPaise: totals.totalCredits,
    differenceInPaise: Math.abs(totals.totalDebits - totals.totalCredits),
    integrityStatus: isBalanced
      ? "BALANCED — All entries verified"
      : "IMBALANCED — INVESTIGATE IMMEDIATELY. Halt all financial operations.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getAccountStatement
// ─────────────────────────────────────────────────────────────────────────────
LedgerEntrySchema.statics.getAccountStatement = async function ({
  ledgerAccountId,
  fromDate,
  toDate,
  page = 1,
  limit = 100,
}) {
  const skip = (page - 1) * limit;

  const dateFilter = {
    $gte: startOfDay(fromDate),
    $lte: endOfDay(toDate),
  };

  const [entries, total] = await Promise.all([
    this.find({ ledgerAccount: ledgerAccountId, businessDate: dateFilter })
      .populate("performedBy", "name role")
      .populate("transaction", "transactionId type")
      .sort({ businessDate: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    this.countDocuments({
      ledgerAccount: ledgerAccountId,
      businessDate: dateFilter,
    }),
  ]);

  return {
    entries,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

module.exports = mongoose.model("LedgerEntry", LedgerEntrySchema);
