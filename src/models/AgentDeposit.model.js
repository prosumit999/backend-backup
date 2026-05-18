// src/models/AgentDeposit.model.js
// ─────────────────────────────────────────────────────────────────────────────
// AGENT CASH DEPOSIT RECORD
//
// Records the physical handover of cash from an agent to the admin/office.
// This is the second leg of the daily cash flow:
//
//   Leg 1 — Collection:    Customer → Agent pocket
//                          DR Agent Cash (AGNT-xxx) | CR Pigmy Deposits (2002)
//
//   Leg 2 — Agent Deposit: Agent pocket → Company vault
//                          DR Cash in Hand (1001) | CR Agent Cash (AGNT-xxx)
//
// After Leg 2, the agent's personal ledger balance returns to zero.
// Day close is blocked until ALL agent balances = 0.
//
// IMMUTABILITY:
// Financial records — hard delete is blocked by pre-hooks.
// Use isDeleted:true only. Corrections = reversal record.
//
// REVERSAL:
// Admin can reverse a deposit (e.g. cash counted incorrectly).
// Reversal creates a new AgentDeposit with status:"reversed" and
// posts the opposite ledger entry — DR Agent Cash | CR Cash in Hand.
// The original deposit is marked isReversed:true.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");

// Same values as TRANSACTION_STATUS — defined locally to avoid circular dependency.
const DEPOSIT_STATUS = Object.freeze({
  COMPLETED: "completed",
  REVERSED: "reversed",
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const AgentDepositSchema = new mongoose.Schema(
  {
    // Generated outside session in agentDeposit.service.js
    // Format: DEP-YYYY-XXXXX  e.g. DEP-2026-00001
    depositId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // Human-readable receipt number — printed and handed to agent
    // Format: DRCP-YYYY-XXXXX  e.g. DRCP-2026-00001
    receiptNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // ── Parties ───────────────────────────────────────────
    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Admin staff who physically received the cash at the counter.
    // Different from performedBy — receivedBy is the teller/cashier.
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Amount ────────────────────────────────────────────
    amountInPaise: {
      type: Number,
      required: true,
      min: [1, "Deposit amount must be at least ₹0.01"],
    },

    // ── Ledger Reference ──────────────────────────────────
    // Agent's personal ledger account code at time of deposit.
    // Stored here so reversal can find the correct account even if
    // the agent's ledger code ever changes (edge case safety).
    // e.g. "AGNT-AGT-2026-001"
    agentLedgerCode: {
      type: String,
      required: true,
      trim: true,
    },

    // ── Transaction link ──────────────────────────────────
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(DEPOSIT_STATUS),
      default: DEPOSIT_STATUS.COMPLETED,
      index: true,
    },

    // ── Reversal ──────────────────────────────────────────
    isReversed: {
      type: Boolean,
      default: false,
      index: true,
    },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversedAt: { type: Date, default: null },
    reversalNote: { type: String, default: null, trim: true },

    // Points to the original AgentDeposit this record reverses.
    // Null on original deposits. Populated only on reversal records.
    reversalOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AgentDeposit",
      default: null,
    },

    // ── Dates ─────────────────────────────────────────────
    businessDate: {
      type: Date,
      required: true,
      index: true,
    },

    // ── Idempotency ───────────────────────────────────────
    requestId: {
      type: String,
      default: null,
      // sparse unique index defined below
    },

    // ── Notes ─────────────────────────────────────────────
    note: {
      type: String,
      default: "",
      trim: true,
    },

    // ── Soft Delete ───────────────────────────────────────
    isDeleted: {
      type: Boolean,
      default: false,
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
AgentDepositSchema.index({ agent: 1, businessDate: -1 });
AgentDepositSchema.index({ agent: 1, status: 1, isReversed: 1 });
AgentDepositSchema.index({ businessDate: 1, status: 1 });

// Sparse unique on requestId — nulls not indexed, non-nulls must be unique
AgentDepositSchema.index(
  { requestId: 1 },
  { unique: true, sparse: true, name: "unique_agentDeposit_requestId" },
);

// ─────────────────────────────────────────────────────────────────────────────
// IMMUTABILITY — Hard delete blocked on financial records
// ─────────────────────────────────────────────────────────────────────────────
const IMMUTABILITY_ERROR =
  "AgentDeposit records are immutable financial records. " +
  "Hard deletion is not permitted. " +
  "Use isDeleted:true for soft deletion. " +
  "Corrections require a reversal record via reverseAgentDeposit().";

AgentDepositSchema.pre(
  ["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove"],
  function () {
    throw new Error(IMMUTABILITY_ERROR);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: findByAgent
// Paginated deposit history for a single agent.
// ─────────────────────────────────────────────────────────────────────────────
AgentDepositSchema.statics.findByAgent = function (agentId, filters = {}) {
  return this.find({
    agent: agentId,
    isDeleted: false,
    ...filters,
  }).sort({ createdAt: -1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getTodayDepositTotal
// Returns total cash deposited by an agent on a given business date.
// Used by dayClose.service.js for per-agent deposit summary.
// ─────────────────────────────────────────────────────────────────────────────
AgentDepositSchema.statics.getTodayDepositTotal = async function (
  agentId,
  businessDate,
) {
  const result = await this.aggregate([
    {
      $match: {
        agent: new mongoose.Types.ObjectId(agentId),
        businessDate: {
          $gte: startOfDay(businessDate),
          $lte: endOfDay(businessDate),
        },
        status: DEPOSIT_STATUS.COMPLETED,
        isReversed: false,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalDepositedInPaise: { $sum: "$amountInPaise" },
        depositCount: { $sum: 1 },
      },
    },
  ]);

  return {
    totalDepositedInPaise: result[0]?.totalDepositedInPaise ?? 0,
    depositCount: result[0]?.depositCount ?? 0,
  };
};

const AgentDeposit = mongoose.model("AgentDeposit", AgentDepositSchema);

module.exports = AgentDeposit;
module.exports.DEPOSIT_STATUS = DEPOSIT_STATUS;
