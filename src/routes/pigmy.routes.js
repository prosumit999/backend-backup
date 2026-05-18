// src/routes/pigmy.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/pigmy.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const resolveAnyAccount = require("../middleware/resolveAnyAccount");
const expectType = require("../middleware/expectType");
const { transactionLimiter } = require("../middleware/rateLimiter");
const {
  createPigmyAccountSchema,
  updatePigmyAccountSchema,
  closeAccountSchema: closePigmyAccountSchema,
  freezeAccountSchema: freezePigmyAccountSchema,
  unfreezeAccountSchema: unfreezePigmyAccountSchema,
  listAccountsSchema: listPigmyAccountsSchema,
  getStatementSchema: getPigmyStatementSchema,
  customerIdParamSchema,
  pigmyToSavingTransferSchema,
} = require("../validators/account.validator");

router.use(authenticate);

// ── CREATE + LIST ─────────────────────────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_PIGMY_ACCOUNT"),
  validate(createPigmyAccountSchema),
  ctrl.createPigmyAccount,
);
router.get(
  "/",
  authorize("VIEW_PIGMY_ACCOUNT"),
  validate(listPigmyAccountsSchema, "query"),
  ctrl.listPigmyAccounts,
);

// Static — must be before /:id
router.get(
  "/customer/:customerId",
  authorize("VIEW_PIGMY_ACCOUNT"),
  validate(customerIdParamSchema, "params"),
  ctrl.getPigmyAccountsByCustomer,
);

// ── SINGLE ACCOUNT ────────────────────────────────────────────────────────────

router.get(
  "/:id",
  authorize("VIEW_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  ctrl.getPigmyAccount,
);
router.get(
  "/:id/statement",
  authorize("VIEW_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(getPigmyStatementSchema, "query"),
  ctrl.getStatement,
);
router.post(
  "/:id/transfer-to-saving",
  authorize("TRANSFER_PIGMY_TO_SAVING"),
  transactionLimiter,
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(pigmyToSavingTransferSchema),
  ctrl.transferToSaving,
);
router.patch(
  "/:id",
  authorize("UPDATE_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(updatePigmyAccountSchema),
  ctrl.updatePigmyAccount,
);
router.patch(
  "/:id/close",
  authorize("CLOSE_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(closePigmyAccountSchema),
  ctrl.closePigmyAccount,
);
router.patch(
  "/:id/freeze",
  authorize("FREEZE_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(freezePigmyAccountSchema),
  ctrl.freezePigmyAccount,
);
router.patch(
  "/:id/unfreeze",
  authorize("UNFREEZE_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  validate(unfreezePigmyAccountSchema),
  ctrl.unfreezePigmyAccount,
);

router.delete(
  "/:id",
  authorize("DELETE_PIGMY_ACCOUNT", "CLOSE_PIGMY_ACCOUNT"),
  resolveAnyAccount,
  expectType("pigmyAccount"),
  ctrl.deletePigmyAccount,
);
router.post(
  "/:id/restore",
  authorize("RESTORE_PIGMY_ACCOUNT", "CREATE_PIGMY_ACCOUNT"),
  ctrl.restorePigmyAccount,
);

module.exports = router;
