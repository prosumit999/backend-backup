// src/routes/account.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/account.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const resolveAnyAccount = require("../middleware/resolveAnyAccount");
const expectType = require("../middleware/expectType");
const idempotency = require("../middleware/idempotency");
const requireIdempotencyKey = require("../middleware/requireIdempotencyKey");
const { transactionLimiter } = require("../middleware/rateLimiter");
const {
  createAccountSchema,
  depositSchema,
  closeAccountSchema,
  freezeAccountSchema,
  unfreezeAccountSchema,
  listAccountsSchema,
  getStatementSchema,
  customerIdParamSchema,
  withdrawSchema,
  repayLoanSchema,
  savingToPigmyTransferSchema,
} = require("../validators/account.validator");

router.use(authenticate);

// ── CREATE + LIST ─────────────────────────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_SAVING_ACCOUNT"),
  validate(createAccountSchema),
  ctrl.createAccount,
);
router.get(
  "/",
  authorize("VIEW_SAVING_ACCOUNT"),
  validate(listAccountsSchema, "query"),
  ctrl.listAccounts,
);

// ── CUSTOMER-SPECIFIC ACCOUNTS ────────────────────────────────────────────────

router.get(
  "/customer/:customerId",
  authorize("VIEW_SAVING_ACCOUNT"),
  validate(customerIdParamSchema, "params"),
  ctrl.getAccountsByCustomer,
);

// ── SYSTEM CONFIG — must be BEFORE /:id routes ────────────────────────────────
// Returns the current SAVINGS_OPENING_CHARGE so the UI can show it in the
// confirmation dialog. Placed here to prevent Express matching it as an :id.
router.get(
  "/opening-charge",
  authorize("VIEW_SAVING_ACCOUNT"),
  ctrl.getOpeningCharge,
);

// ── SINGLE ACCOUNT — resolveAccount on all /:id routes ───────────────────────
router.get(
  "/:id",
  authorize("VIEW_SAVING_ACCOUNT"),
  resolveAnyAccount,
  expectType("savingAccount"),
  ctrl.getAccount,
);
router.get(
  "/:id/statement",
  authorize("VIEW_SAVING_ACCOUNT"),
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(getStatementSchema, "query"),
  ctrl.getStatement,
);

router.post(
  "/:id/deposit",
  authorize("DEPOSIT_TO_SAVING"),
  transactionLimiter,
  requireIdempotencyKey,
  idempotency,
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(depositSchema),
  ctrl.depositToSaving,
);

router.post(
  "/:id/withdraw",
  authorize("WITHDRAW_FROM_SAVING"),
  transactionLimiter,
  requireIdempotencyKey,
  idempotency,
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(withdrawSchema),
  ctrl.withdrawFromSaving,
);

router.post(
  "/:id/repay-loan",
  authorize("POST_LOAN_REPAYMENT"),
  transactionLimiter,
  requireIdempotencyKey,
  idempotency,
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(repayLoanSchema),
  ctrl.repayLoanFromSaving,
);
router.post(
  "/:id/transfer-to-pigmy",
  authorize("WITHDRAW_FROM_SAVING"),
  transactionLimiter,
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(savingToPigmyTransferSchema),
  ctrl.transferToPigmy,
);
router.patch(
  "/:id/close",
  authorize("CLOSE_SAVING_ACCOUNT"),
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(closeAccountSchema),
  ctrl.closeAccount,
);
router.patch(
  "/:id/freeze",
  authorize("FREEZE_SAVING_ACCOUNT"),
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(freezeAccountSchema),
  ctrl.freezeAccount,
);
router.patch(
  "/:id/unfreeze",
  authorize("UNFREEZE_SAVING_ACCOUNT"),
  resolveAnyAccount,
  expectType("savingAccount"),
  validate(unfreezeAccountSchema),
  ctrl.unfreezeAccount,
);

module.exports = router;
