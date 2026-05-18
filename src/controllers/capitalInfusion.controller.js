"use strict";
// src/controllers/capitalInfusion.controller.js
// ─────────────────────────────────────────────────────────────────────────────
// Record Capital Infusion:  DR Cash (1001)  |  CR Owner's Capital (5002)
//
// Effect:  Cash-in-Hand rises.  Owner's Equity rises by the same amount.
// This allows new loans to be disbursed without hitting the Cash Gate.
//
// Uses the system's canonical LedgerEntry.createDoublePair() so running
// balances, immutability enforcement, and double-entry validation are all
// handled by the single source of truth — same as every other service.
//
// Requires: admin or superadmin role, business day must be open.
// ─────────────────────────────────────────────────────────────────────────────

const asyncHandler    = require("../utils/asyncHandler");
const ApiResponse     = require("../utils/ApiResponse");
const ApiError        = require("../utils/ApiError");
const LedgerAccount   = require("../models/LedgerAccount.model");
const LedgerEntry     = require("../models/LedgerEntry.model");
const Transaction     = require("../models/Transaction.model");
const AppConfig       = require("../models/AppConfig.model");
const withTransaction = require("../utils/withTransaction");
const { logAudit, buildAuditContext } = require("../utils/auditLogger");
const { generateTransactionId }       = require("../utils/generateCode");
const { TRANSACTION_TYPES, AUDIT_ACTIONS, ROLES } = require("../config/constants");

// ── POST /api/v1/capital-infusion ─────────────────────────────────────────────
const recordCapitalInfusion = asyncHandler(async (req, res) => {
  const { role, _id: performedBy } = req.user;

  // Role guard — admin or superadmin only
  if (![ROLES.ADMIN, ROLES.SUPERADMIN].includes(role)) {
    throw ApiError.forbidden("Only admin or superadmin can record capital infusions.");
  }

  const { amountInRupees, paymentMode = "cash", note, reference } = req.body;

  const amtNum = Number(amountInRupees);
  if (!amtNum || isNaN(amtNum) || amtNum <= 0) {
    throw new ApiError(400, "amountInRupees must be a positive number.");
  }
  const amountInPaise = Math.round(amtNum * 100);

  // Business day must be open
  const config = await AppConfig.getConfig();
  if (!config.isDayOpen) {
    throw new ApiError(
      400,
      "Business day is closed. Open the business day before recording capital infusions."
    );
  }
  const businessDate = config.currentBusinessDate || new Date();

  // Fetch both GL accounts (lean — createDoublePair needs _id + normalBalance)
  const [cashAccount, capitalAccount] = await Promise.all([
    LedgerAccount.findOne({ code: "1001" }).lean(),
    LedgerAccount.findOne({ code: "5002" }).lean(),
  ]);

  if (!cashAccount) {
    throw new ApiError(500, "Cash account (GL 1001) not found. Run seedSystemAccounts().");
  }
  if (!capitalAccount) {
    throw new ApiError(500, "Capital account (GL 5002) not found. Run seedSystemAccounts().");
  }

  // Generate unique transaction ID (TXN-YYYY-NNNNNN) — outside session deliberately
  const transactionId = await generateTransactionId(businessDate);

  const narration = note || "Capital infusion";
  const ref       = reference || transactionId;

  let result = {};

  await withTransaction(async (session) => {
    // ── Single createDoublePair call ─────────────────────────────────────────
    //    DR Cash (1001) — debit-normal asset   → debit increases balance
    //    CR Owner's Capital (5002) — credit-normal equity → credit increases balance
    await LedgerEntry.createDoublePair({
      debitLedgerAccount:  cashAccount,
      creditLedgerAccount: capitalAccount,
      amountInPaise,
      description: `Capital Infusion | ₹${(amountInPaise / 100).toFixed(2)} | DR Cash | CR Owner's Capital`,
      narration,
      transactionRef: transactionId,
      performedBy,
      businessDate,
      session,
    });

    // ── Audit transaction stub ────────────────────────────────────────────────
    await Transaction.create(
      [{
        transactionId,
        type:             TRANSACTION_TYPES.CAPITAL_INFUSION,
        status:           "completed",
        amountInPaise,
        netAmountInPaise: amountInPaise,
        feeInPaise:       0,
        paymentMode,
        note:             narration,
        reference:        ref !== transactionId ? ref : null,
        businessDate,
        performedBy,
      }],
      { session }
    );

    result = {
      transactionId,
      amountInPaise,
      amountInRupees:   amtNum,
      cashGlCode:       "1001",
      capitalGlCode:    "5002",
      paymentMode,
      businessDate,
    };
  });

  // Audit log — fire-and-forget, never block the response
  logAudit({
    action:  AUDIT_ACTIONS.CAPITAL_INFUSION_RECORDED,
    ...buildAuditContext(req),
    details: `Capital infusion ₹${amtNum.toFixed(2)} | Ref: ${transactionId} | Mode: ${paymentMode}`,
    status:  "success",
  }).catch(() => {});

  return res.status(201).json(
    new ApiResponse(
      201,
      result,
      `Capital infusion of ₹${amtNum.toFixed(2)} recorded. ` +
      `DR Cash in Hand (1001) | CR Owner's Capital (5002) · ${transactionId}`
    )
  );
});

module.exports = { recordCapitalInfusion };
