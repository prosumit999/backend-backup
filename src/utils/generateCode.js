// src/utils/generateCode.js
// ─────────────────────────────────────────────────────────────────────────────
// Atomic sequence generator for ALL account numbers, codes, and IDs.
//
// DESIGN DECISIONS — read before modifying:
//
// 1. WHY COUNTERS RUN OUTSIDE withTransaction SESSION:
//    Counter.getNextSequence() uses findOneAndUpdate with $inc — this is
//    atomic at the MongoDB document level (no race condition possible).
//    However, counters are intentionally NOT wrapped in the outer transaction.
//
//    CONSEQUENCE: If a transaction rolls back (e.g., concurrent loan conflict,
//    ledger integrity failure), the counter has already incremented.
//    Example: LOAN-2026-00005 is reserved → transaction aborts → LOAN-2026-00006
//    is issued next. LOAN-2026-00005 never exists — a permanent gap.
//
//    WHY THIS IS ACCEPTABLE:
//    - Gaps in financial account numbers are auditor-acceptable when documented.
//    - RBI NBFC guidelines do NOT mandate strictly gapless sequences —
//      they require uniqueness and immutability (no reuse), both guaranteed.
//    - The alternative (counter inside session) causes deadlocks under
//      concurrent load because all transactions would contend on the same
//      Counter document as a shared lock.
//    - Document this in your internal audit notes: "Account number gaps
//      occur due to rolled-back transactions and are expected behavior."
//
// 2. WHY IDs ARE GENERATED BEFORE OPENING THE SESSION:
//    Generating IDs outside the session keeps the session body lean.
//    Fewer operations inside the session = shorter lock duration = less
//    write-conflict risk under concurrent load.
//
// 3. IST YEAR:
//    All codes use IST year, not UTC year. On Jan 1 at 12:00 AM IST
//    (= Dec 31 at 18:30 UTC), a UTC server's getFullYear() returns the
//    PREVIOUS year — accounts opened at midnight IST on New Year's Day
//    would get the wrong year prefix. istYear() corrects this for BOTH
//    the wall-clock path AND the businessDate path.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Counter = require("../models/Counter.model");

// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 19800000ms

/**
 * Returns the IST calendar year for a given date.
 *
 * @param {Date|string|null} businessDate
 * @returns {number} IST calendar year e.g. 2026
 */
const istYear = (businessDate = null) => {
  if (businessDate) {
    // Shift to IST before extracting year — same as wall-clock path
    const istDate = new Date(new Date(businessDate).getTime() + IST_OFFSET_MS);
    return istDate.getUTCFullYear();
  }
  // Wall-clock path — shift to IST then extract UTC year (correct since v1)
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return nowIST.getUTCFullYear();
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Zero-pad number to `size` digits. Default 5 → "00001"
const pad = (num, size = 5) => String(num).padStart(size, "0");

// Counter key scoped by year so sequences reset each year.
// Example: "savingAccountNumber_2026", "savingAccountNumber_2027"
// This means SAV-2026-00001 and SAV-2027-00001 can both exist — correct.
const yearKey = (base, businessDate) => `${base}_${istYear(businessDate)}`;

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER & USER CODES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CUST-2026-0001
 * Called from Customer.model.js presave hook (no businessDate available there).
 * Uses IST wall-clock year to prevent wrong prefix at IST midnight on Jan 1.
 */
const generateCustomerCode = async (businessDate = null) =>
  `CUST-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("customerCode", businessDate)),
    4,
  )}`;

/**
 * AGT-2026-0001
 * Called from agent.service.js createAgent — pass businessDate always.
 */
const generateAgentCode = async (businessDate = null) =>
  `AGT-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("agentCode", businessDate)),
    4,
  )}`;

/**
 * ADM-2026-0001
 * Called from superadmin.service.js createAdmin — pass businessDate always.
 */
const generateAdminCode = async (businessDate = null) =>
  `ADM-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("adminCode", businessDate)),
    4,
  )}`;

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT NUMBERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SAV-2026-00001
 * Pass businessDate from AppConfig — always from saving.service.js.
 */
const generateSavingAccountNumber = async (businessDate = null) =>
  `SAV-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("savingAccountNumber", businessDate)),
  )}`;

/**
 * PGM-2026-00001
 * Pass businessDate from AppConfig — always from pigmy.service.js.
 */
const generatePigmyAccountNumber = async (businessDate = null) =>
  `PGM-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("pigmyAccountNumber", businessDate)),
  )}`;

/**
 * LOAN-2026-00001
 * Pass businessDate from AppConfig — always from loan.service.js.
 * NOTE: Counter gap behavior documented at top of file — gaps are expected
 * on transaction rollback and are auditor-acceptable.
 */
const generateLoanAccountNumber = async (businessDate = null) =>
  `LOAN-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("loanAccountNumber", businessDate)),
  )}`;

// ─────────────────────────────────────────────────────────────────────────────
// RECEIPTS & TRANSACTION IDs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RCP-2026-000001
 * 6-digit pad — high volume, one per collection per day.
 */
const generateReceiptNumber = async (businessDate = null) =>
  `RCP-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("receiptNumber", businessDate)),
    6,
  )}`;

/**
 * TXN-2026-000001
 * 6-digit pad — one per financial event step.
 * Loan disbursement alone creates 4 transaction records.
 */
const generateTransactionId = async (businessDate = null) =>
  `TXN-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("transactionId", businessDate)),
    6,
  )}`;

// ─────────────────────────────────────────────────────────────────────────────
// LOAN PLAN CODE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LP-2026-001
 * Loan plans are rare — 3-digit pad is sufficient.
 */
const generateLoanPlanCode = async (businessDate = null) =>
  `LP-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("loanPlanCode", businessDate)),
    3,
  )}`;

// ─────────────────────────────────────────────────────────────────────────────
// AGENT DEPOSIT IDs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DEP-2026-00001
 * Internal deposit record ID.
 */
const generateDepositId = async (businessDate = null) =>
  `DEP-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(yearKey("depositId", businessDate)),
  )}`;

/**
 * DRCP-2026-00001
 * Printed receipt handed to agent after cash handover.
 */
const generateDepositReceiptNumber = async (businessDate = null) =>
  `DRCP-${istYear(businessDate)}-${pad(
    await Counter.getNextSequence(
      yearKey("depositReceiptNumber", businessDate),
    ),
  )}`;

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateCustomerCode,
  generateAgentCode,
  generateAdminCode,
  generateSavingAccountNumber,
  generatePigmyAccountNumber,
  generateLoanAccountNumber,
  generateReceiptNumber,
  generateTransactionId,
  generateLoanPlanCode,
  generateDepositId,
  generateDepositReceiptNumber,
};
