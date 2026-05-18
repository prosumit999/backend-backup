// src/middleware/expectType.js
// Micro-validator used AFTER resolveAnyAccount on every /:id route.
// Guards against cross-type requests (e.g., pigmy number sent to saving route).
//
// Usage in routes:
//   router.get("/:id",
//     resolveAnyAccount,
//     expectType("savingAccount"),   ← allows only SAV-... or ObjectId resolving to SavingAccount
//     ctrl.getAccount
//   );
//
// Without this: a PGM-... number sent to a saving route would resolve
// req.pigmyAccount but leave req.savingAccount undefined → controller crash.
"use strict";

const ApiError = require("../utils/ApiError");

const TYPE_LABELS = {
  savingAccount: "saving account (SAV-YYYY-NNNNN)",
  pigmyAccount: "pigmy account (PGM-YYYY-NNNNN)",
  loanAccount: "loan account (LOAN-YYYY-NNNNN)",
};

const expectType = (reqKey) => (req, res, next) => {
  if (req[reqKey]) return next(); // correct type resolved — all good
  return next(
    ApiError.badRequest(
      `This endpoint requires a ${TYPE_LABELS[reqKey] ?? reqKey}. ` +
        `The account number you provided does not match the expected format.`,
    ),
  );
};

module.exports = expectType;
