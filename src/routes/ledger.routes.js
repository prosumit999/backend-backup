// src/routes/ledger.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// LEDGER API ROUTES
//
// READ endpoints  — VIEW_LEDGER (Admin + Superadmin)
// WRITE endpoint  — POST_JOURNAL_VOUCHER (Admin only)
// INTEGRITY check — MANAGE_SETTINGS (Superadmin only — health check with admin alert)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/ledger.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const systemLock = require("../middleware/systemLock");
const validate = require("../middleware/validate");

const {
  accountStatementSchema,
  ledgerJournalQuerySchema,
  journalVoucherSchema,
  integrityCheckSchema,
} = require("../validators/ledger.validator");

// All ledger routes require authentication
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY ROUTES (no systemLock — reports should always be accessible)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/ledger/general
// Full General Ledger — all accounts grouped by type, with balance sheet totals
router.get(
  "/general",
  authorize("VIEW_LEDGER"),
  ctrl.getGeneralLedger,
);

// GET /api/v1/ledger/accounts/code/:code
// Dynamic GL Code Lookup
router.get(
  "/accounts/code/:code",
  authorize("VIEW_LEDGER"),
  ctrl.getAccountByCode,
);

// GET /api/v1/ledger/accounts/:id/statement
// Account Statement — date-ranged, paginated, with opening/closing balance
router.get(
  "/accounts/:id/statement",
  authorize("VIEW_LEDGER"),
  validate(accountStatementSchema, "query"),
  ctrl.getAccountStatement,
);

// GET /api/v1/ledger/journal
// Full Ledger Journal — all entries in date range, filterable
router.get(
  "/journal",
  authorize("VIEW_LEDGER"),
  validate(ledgerJournalQuerySchema, "query"),
  ctrl.getLedgerJournal,
);

// GET /api/v1/ledger/integrity
// Ledger Integrity Check — DR === CR; superadmin only
router.get(
  "/integrity",
  authorize("MANAGE_SETTINGS"),
  validate(integrityCheckSchema, "query"),
  ctrl.checkLedgerIntegrity,
);

// GET /api/v1/ledger/transaction/:transactionId/trail
// Transaction Ledger Trail — full double-entry details for a specific transaction
router.get(
  "/transaction/:transactionId/trail",
  authorize("VIEW_LEDGER"),
  ctrl.getTransactionTrail,
);

// ─────────────────────────────────────────────────────────────────────────────
// WRITE ROUTE — systemLock applied (JV is a financial write operation)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/v1/ledger/journal-voucher
// Manual Journal Voucher — permanent, fully audited, admin + superadmin
router.post(
  "/journal-voucher",
  authorize("POST_JOURNAL_VOUCHER"),
  systemLock,
  validate(journalVoucherSchema),
  ctrl.postJournalVoucher,
);

module.exports = router;
