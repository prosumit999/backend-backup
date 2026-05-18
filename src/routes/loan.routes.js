// src/routes/loan.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/loan.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const idempotency = require("../middleware/idempotency");
const requireIdempotencyKey = require("../middleware/requireIdempotencyKey");
const validate = require("../middleware/validate");
const resolveAnyAccount = require("../middleware/resolveAnyAccount");
const expectType = require("../middleware/expectType");
const {
  loanPreviewSchema,
  createLoanSchema,
  closeLoanSchema,
  reopenLoanSchema,
  listLoansSchema,
  applyPenaltySchema,
  applyPigmyToLoanSchema,
  customerIdParamSchema,
  reverseRepaymentSchema,
  resetLifelinesSchema,
  deficitDashboardQuerySchema,
} = require("../validators/loan.validator");

router.use(authenticate);

// ── STATIC ROUTES — all BEFORE /:id ──────────────────────────────────────────
router.get(
  "/preview",
  authorize("CREATE_LOAN"),
  validate(loanPreviewSchema, "query"),
  ctrl.getLoanPreview,
);
router.get(
  "/customer/:customerId",
  authorize("VIEW_LOAN"),
  validate(customerIdParamSchema, "params"),
  ctrl.getLoansByCustomer,
);

router.get(
  "/repayment-dashboard",
  authorize("VIEW_LOAN"),
  ctrl.getLoanRepaymentDashboard,
);

// GET /loans/deficit-dashboard
// Returns all active/overdue loans behind on pigmy collection.
// Penalty amount shown is from AppConfig (superadmin-configured).
router.get(
  "/deficit-dashboard",
  authorize("VIEW_DEFICIT_DASHBOARD"),
  validate(deficitDashboardQuerySchema, "query"),
  ctrl.getDeficitDashboard,
);

// ── CREATE + LIST ─────────────────────────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_LOAN"),
  requireIdempotencyKey,
  idempotency,
  validate(createLoanSchema),
  ctrl.createLoan,
);
router.get(
  "/",
  authorize("VIEW_LOAN"),
  validate(listLoansSchema, "query"),
  ctrl.listLoans,
);

// ── REVERSE REPAYMENT ────────────────────────────────────────────────────────
// Must be above /:id to prevent parameter swallowing.
// Use dedicated REVERSE_LOAN_REPAYMENT permission (SUPERADMIN + ADMIN only).
// Loan repayment reversal is a credit-risk operation and must be separated from
// the REVERSE_COLLECTION permission used for daily pigmy field collections.
router.post(
  "/repayment/reverse",
  authorize("REVERSE_LOAN_REPAYMENT"),
  requireIdempotencyKey,
  idempotency,
  validate(reverseRepaymentSchema),
  ctrl.reverseRepayment
);

// ── SINGLE LOAN — all /:id routes ────────────────────────────────────────────

router.get(
  "/:id",
  authorize("VIEW_LOAN"),
  resolveAnyAccount,
  expectType("loanAccount"),
  ctrl.getLoan,
);

// GET /loans/:id/statement — paginated repayment transaction history
router.get(
  "/:id/statement",
  authorize("VIEW_LOAN"),
  resolveAnyAccount,
  expectType("loanAccount"),
  ctrl.getLoanStatement,
);
router.patch(
  "/:id/close",
  authorize("CLOSE_LOAN"),
  resolveAnyAccount,
  expectType("loanAccount"),
  validate(closeLoanSchema),
  ctrl.closeLoan,
);

// POST /loans/:id/reopen — reactivate a closed or written-off loan
// Requires REACTIVATE_LOAN permission (SUPERADMIN + ADMIN)
router.post(
  "/:id/reopen",
  authorize("REACTIVATE_LOAN"),
  resolveAnyAccount,
  expectType("loanAccount"),
  validate(reopenLoanSchema),
  ctrl.reopenLoan,
);
router.post(
  "/:id/apply-penalty",
  authorize("APPLY_PENALTY"),
  resolveAnyAccount,
  expectType("loanAccount"),
  validate(applyPenaltySchema),
  ctrl.applyPenalty,
);
router.post(
  "/:id/send-reminder",
  authorize("SEND_LOAN_REMINDER"),
  resolveAnyAccount,
  expectType("loanAccount"),
  ctrl.sendLoanReminder,
);
router.post(
  "/:id/apply-pigmy",
  authorize("APPLY_PIGMY_TO_LOAN"),
  requireIdempotencyKey,
  idempotency,
  resolveAnyAccount,
  expectType("loanAccount"),
  validate(applyPigmyToLoanSchema),
  ctrl.applyPigmyToLoan,
);

// PATCH /loans/:id/lifelines
// Admin adjusts lifeline count for a specific loan.
// resetType: 'full' | 'increment' | 'decrement' | 'set'
router.patch(
  "/:id/lifelines",
  authorize("RESET_LIFELINES"),
  resolveAnyAccount,
  expectType("loanAccount"),
  validate(resetLifelinesSchema),
  ctrl.resetLifelines,
);

module.exports = router;
