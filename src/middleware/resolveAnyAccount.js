// src/middleware/resolveAnyAccount.js
// ─────────────────────────────────────────────────────────────────────────────
// Single middleware that resolves :id → the correct account document.
// Auto-detects account type from the number prefix.
//
//   SAV-2026-00001  → req.savingAccount   (SavingAccount model)
//   PGM-2026-00001  → req.pigmyAccount    (PigmyAccount model)
//   LOAN-2026-00001 → req.loanAccount     (LoanAccount model)
//
// Also accepts MongoDB ObjectId as fallback (admin/internal use only).
// For ObjectId path: scans all 3 models in order — 3 DB calls max.
// ObjectId is slow by design to discourage frontend use. Always use
// account numbers from the frontend.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const SavingAccount = require("../models/SavingAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const ApiError = require("../utils/ApiError");

const ACCOUNT_TYPES = [
  {
    regex: /^SAV-\d{4}-\d{5}$/,
    Model: SavingAccount,
    reqKey: "savingAccount",
    label: "Saving",
  },
  {
    regex: /^PGM-\d{4}-\d{5}$/,
    Model: PigmyAccount,
    reqKey: "pigmyAccount",
    label: "Pigmy",
  },
  {
    regex: /^LOAN-\d{4}-\d{5}$/,
    Model: LoanAccount,
    reqKey: "loanAccount",
    label: "Loan",
  },
];

const OBJECTID_RE = /^[0-9a-fA-F]{24}$/;

// ─────────────────────────────────────────────────────────────────────────────
const resolveAnyAccount = async (req, res, next) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return next(ApiError.badRequest("Account ID is required."));

    const upperID = id.toUpperCase(); // normalize once

    // ── PATH 1: account number (SAV-... / PGM-... / LOAN-...) ───────────────
    // O(3) string regex tests — no DB call until pattern matches.
    for (const { regex, Model, reqKey, label } of ACCOUNT_TYPES) {
      if (regex.test(upperID)) {
        const account = await Model.findOne({
          accountNumber: upperID,
          isDeleted: false,
        });
        if (!account) {
          return next(
            ApiError.notFound(`${label} account '${upperID}' not found.`),
          );
        }
        req[reqKey] = account; // e.g. req.savingAccount = <document>
        return next();
      }
    }

    // ── PATH 2: MongoDB ObjectId (internal / admin use only) ────────────────
    // Scans all 3 models because from an ObjectId alone we can't tell the type.
    // Max 3 DB queries — acceptable because this path is admin-only, low volume.
    if (OBJECTID_RE.test(id)) {
      for (const { Model, reqKey } of ACCOUNT_TYPES) {
        const account = await Model.findOne({ _id: id, isDeleted: false });
        if (account) {
          req[reqKey] = account;
          return next();
        }
      }
      return next(ApiError.notFound("Account not found."));
    }

    // ── PATH 3: unrecognized format ──────────────────────────────────────────
    return next(
      ApiError.badRequest(
        `Invalid account identifier: '${id}'. ` +
          `Use account number (SAV-YYYY-NNNNN, PGM-YYYY-NNNNN, LOAN-YYYY-NNNNN) ` +
          `or a 24-character MongoDB ObjectId.`,
      ),
    );
  } catch (err) {
    next(err);
  }
};

module.exports = resolveAnyAccount;
