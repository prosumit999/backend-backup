// src/utils/ledger.js
// ─────────────────────────────────────────────────────────────────────────────
// DOUBLE-ENTRY LEDGER ENGINE
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const LedgerAccount = require("../models/LedgerAccount.model");
const LedgerEntry = require("../models/LedgerEntry.model");
const ApiError = require("./ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM GL CODES — immutable, seeded on startup by LedgerAccount.seedSystemAccounts()
//
// Bank accounts (1003, 1004, 1005, ...) are NOT listed here.
// They are fully dynamic: admin creates them via the Ledger Accounts UI and
// selects the GL code at transaction time. The bankLedgerCode field carries
// the code through the service layer to each record* function below.
//
// DO NOT add hardcoded bank codes here — that defeats the entire purpose of
// the dynamic Chart of Accounts model.
// ─────────────────────────────────────────────────────────────────────────────
const CODES = Object.freeze({
  CASH: "1001",              // Cash in Hand          — Asset (DR normal)
  LOANS_RECEIVABLE: "1002",  // Loans Receivable      — Asset (DR normal)
  SAVING_DEPOSITS: "2001",   // Customer Saving Deposits — Liability (CR normal)
  PIGMY_DEPOSITS: "2002",    // Customer Pigmy Deposits  — Liability (CR normal)
  PROCESSING_FEE: "3001",    // Processing Fee Income — Income  (CR normal)
  PENALTY_INCOME: "3002",    // Penalty Income        — Income  (CR normal)
  OPENING_CHARGE: "3003",    // Account Opening Income— Income  (CR normal)
  INTEREST_INCOME: "3004",   // Interest Income       — Income  (CR normal)
  WRITE_OFF_EXPENSE: "4005", // Bad Debt Write-Off    — Expense (DR normal)
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const getAccount = async (code, session = null) => {
  const acc = await LedgerAccount.findByCode(code, session);
  if (!acc) {
    throw new ApiError(
      500,
      `Ledger account [${code}] not found. ` +
      `Run seedSystemAccounts() on startup to create system accounts.`,
    );
  }
  return acc;
};

const getAccounts = (session, ...codes) =>
  Promise.all(codes.map((c) => getAccount(c, session)));

// ─────────────────────────────────────────────────────────────────────────────
// FIX L-1: SESSION GUARD — applied to every public record* function.
// Without this, a caller outside withTransaction() would run LedgerEntry.create
// and LedgerAccount.updateRunningBalance as two SEPARATE non-atomic operations.
// A process crash between them permanently corrupts the running balance with
// NO error thrown and no way to detect the corruption.
// ─────────────────────────────────────────────────────────────────────────────
const assertSession = (session, fnName) => {
  if (!session) {
    throw new ApiError(
      500,
      `CRITICAL: ${fnName}() requires a MongoDB session. ` +
      `All ledger postings must be wrapped in withTransaction(). ` +
      `A ledger entry without a session has no atomicity guarantee — ` +
      `a crash between LedgerEntry.create and updateRunningBalance ` +
      `permanently corrupts the running balance.`,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. PIGMY DAILY COLLECTION (legacy — Cash 1001 as debit)
//    DR Cash in Hand            (+asset)
//    CR Customer Pigmy Deposits (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const recordPigmyCollection = async (params) => {
  assertSession(params.session, "recordPigmyCollection"); // ← FIX L-1
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.CASH,
    CODES.PIGMY_DEPOSITS,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Pigmy daily collection — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 2a. LOAN DISBURSEMENT — STEP 1a: Cash committed to loan book
//
//     BANKING STANDARD (RBI / NBFC-MFI):
//     When the institution disburses a loan, physical cash MUST be tracked
//     leaving the vault. This entry books the asset (Loan Receivable) and
//     shows cash leaving the Cash in Hand account in the general ledger.
//
//     DR Loans Receivable  (+asset)   ← We now have a claim on the principal
//     CR Cash in Hand      (−asset)   ← Cash leaves the institution vault
//
//     This makes the Cash in Hand account accurately reflect uncommitted cash,
//     preventing the over-lending scenario where cash gate checks pass against
//     cash that is already economically committed to prior loans.
//
//     MUST always be paired with recordPrincipalToSaving() in the same session.
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanCashDisbursement = async (params) => {
  assertSession(params.session, "recordLoanCashDisbursement");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.LOANS_RECEIVABLE,
    CODES.CASH,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Loan disbursed — ₹${(params.amountInPaise / 100).toFixed(2)} charged to Loans Receivable (cash committed)`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 2b. LOAN DISBURSEMENT — STEP 1b: Principal credited to Customer Saving
//
//     The loan proceeds now enter the customer's saving account as a deposit.
//     Cash from the loan book flows into the saving deposit pool.
//
//     DR Cash in Hand             (+asset)    ← Loan proceeds enter saving pool
//     CR Customer Saving Deposits (+liability) ← Full principal credited to saving
//
//     Net Cash in Hand (Step 1a + 1b): −Principal + Principal = ZERO
//     This is correct — cash changed hands internally (vault → saving pool).
//     Physical cash only leaves the institution when the customer WITHDRAWS
//     via a normal saving withdrawal (DR Saving | CR Cash).
//
//     MUST always be paired with recordLoanCashDisbursement() in the same session.
// ─────────────────────────────────────────────────────────────────────────────
const recordPrincipalToSaving = async (params) => {
  assertSession(params.session, "recordPrincipalToSaving");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.CASH,
    CODES.SAVING_DEPOSITS,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Loan principal credited to saving account — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOAN DISBURSEMENT — STEP 2: Processing Fee ← Saving
//    DR Customer Saving Deposits (−liability)
//    CR Processing Fee Income    (+income)
// ─────────────────────────────────────────────────────────────────────────────
const recordProcessingFee = async (params) => {
  assertSession(params.session, "recordProcessingFee"); // ← FIX L-1
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.SAVING_DEPOSITS,
    CODES.PROCESSING_FEE,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Processing fee deducted — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. LOAN DISBURSEMENT — STEP 3: Upfront Interest ← Saving
//    DR Customer Saving Deposits (−liability)
//    CR Interest Income          (+income)
// ─────────────────────────────────────────────────────────────────────────────
const recordInterestDeduction = async (params) => {
  assertSession(params.session, "recordInterestDeduction"); // ← FIX L-1
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.SAVING_DEPOSITS,
    CODES.INTEREST_INCOME,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Upfront interest deducted — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// NOTE: Step 4 (NET_CASH_DISBURSAL) was intentionally removed from the loan
// disbursement flow. Net disbursal amount remains in the customer's saving account.
// The 3-step flow is: LOAN_TO_SAVING → PROCESSING_FEE → INTEREST_DEDUCTION.
// recordNetCashDisbursal is no longer used and has been removed.


// ─────────────────────────────────────────────────────────────────────────────
// 6. PIGMY → LOAN REPAYMENT
//    DR Customer Pigmy Deposits (−liability)
//    CR Loans Receivable        (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanRepayment = async (params, sourceLedgerCode = CODES.PIGMY_DEPOSITS) => {
  assertSession(params.session, "recordLoanRepayment");
  const [debit, credit] = await getAccounts(
    params.session,
    sourceLedgerCode,
    CODES.LOANS_RECEIVABLE,
  );
  const desc = sourceLedgerCode === CODES.PIGMY_DEPOSITS
    ? `Loan repayment from pigmy — ₹${(params.amountInPaise / 100).toFixed(2)}`
    : `Loan repayment — ₹${(params.amountInPaise / 100).toFixed(2)}`;
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: desc,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. PENALTY CHARGE
//    DR Loans Receivable        (+asset)
//    CR Penalty Interest Income (+income)
// ─────────────────────────────────────────────────────────────────────────────
const recordPenaltyCharge = async (params) => {
  assertSession(params.session, "recordPenaltyCharge"); // ← FIX L-1
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.LOANS_RECEIVABLE,
    CODES.PENALTY_INCOME,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Overdue penalty — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 8a. OPENING CHARGE — Step 1: Cash received from customer
//     DR Cash in Hand              (+asset)     — cash collected at counter
//     CR Customer Saving Deposits  (+liability) — temporarily credited to account
// NOTE: Must always be followed by recordOpeningCharge (Step 2) in the same
//       session, reducing the liability and recognising income.
// ─────────────────────────────────────────────────────────────────────────────
const recordOpeningChargeDeposit = async (params) => {
  assertSession(params.session, "recordOpeningChargeDeposit");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.CASH,
    CODES.SAVING_DEPOSITS,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Opening charge cash received — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 8b. OPENING CHARGE — Step 2: Deducted from saving balance to income
//     DR Customer Saving Deposits  (-liability) — deducted from account balance
//     CR Account Opening Income    (+income)    — recognised as company income
// ─────────────────────────────────────────────────────────────────────────────
const recordOpeningCharge = async (params) => {
  assertSession(params.session, "recordOpeningCharge");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.SAVING_DEPOSITS,
    CODES.OPENING_CHARGE,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Saving account opening charge deducted — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 8c. SAVING ACCOUNT WITHDRAWAL
//    DR Customer Saving Deposits (-liability)
//    CR Cash in Hand             (-asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordSavingWithdrawal = async (params) => {
  assertSession(params.session, "recordSavingWithdrawal");
  if (!params.bankLedgerCode) {
    throw new ApiError(500, "bankLedgerCode is required for saving withdrawals.");
  }

  const [debit, credit] = await getAccounts(
    params.session,
    CODES.SAVING_DEPOSITS,
    params.bankLedgerCode,
  );

  if (credit.runningBalanceInPaise < params.amountInPaise) {
    throw new ApiError(
      400,
      `Insufficient company cash to process withdrawal. ` +
      `Available: ₹${(credit.runningBalanceInPaise / 100).toFixed(2)}, ` +
      `Required:  ₹${(params.amountInPaise / 100).toFixed(2)}.`,
    );
  }

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Saving account withdrawal (${params.paymentMode || 'cash'}) — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. JOURNAL VOUCHER — flexible multi-leg admin posting
// ─────────────────────────────────────────────────────────────────────────────
const postJournalVoucher = async ({
  entries,
  narration,
  performedBy,
  requestId,
  journalVoucherId,
  businessDate,
  session,
}) => {
  if (!session) {
    throw new ApiError(
      500,
      "CRITICAL: postJournalVoucher() requires a MongoDB session. " +
      "All JV postings must be wrapped in withTransaction(). " +
      "A JV without a session has no atomicity guarantee — " +
      "a partial post permanently imbalances the ledger.",
    );
  }

  if (!entries || entries.length < 2) {
    throw new ApiError(
      422,
      "Journal Voucher requires at least 2 entries (one debit, one credit).",
    );
  }

  const hasDebit = entries.some(
    (e) => e.type === "debit" && e.amountInPaise > 0,
  );
  const hasCredit = entries.some(
    (e) => e.type === "credit" && e.amountInPaise > 0,
  );

  if (!hasDebit || !hasCredit) {
    throw new ApiError(
      422,
      "Journal Voucher must have at least one non-zero debit AND one non-zero credit entry.",
    );
  }

  if (!businessDate) {
    throw new ApiError(
      422,
      "Journal Voucher requires a businessDate. " +
      "Use AppConfig.getCurrentBusinessDate() — never pass new Date().",
    );
  }

  const totalDebit = entries
    .filter((e) => e.type === "debit")
    .reduce((s, e) => s + e.amountInPaise, 0);
  const totalCredit = entries
    .filter((e) => e.type === "credit")
    .reduce((s, e) => s + e.amountInPaise, 0);

  if (totalDebit !== totalCredit) {
    throw new ApiError(
      422,
      `Journal Voucher imbalanced. ` +
      `DR: ₹${(totalDebit / 100).toFixed(2)} ≠ CR: ₹${(totalCredit / 100).toFixed(2)}. ` +
      `Difference: ₹${(Math.abs(totalDebit - totalCredit) / 100).toFixed(2)}. ` +
      `Fix the entry amounts before posting.`,
    );
  }

  // ── FIX L-2: Deduplicate account codes before fetching ────────────────────
  // Old code: Promise.all(accountCodes.map(c => getAccount(c, session)))
  // If two entries share the same ledgerCode (multi-leg JV), this fired
  // duplicate DB queries AND accountMap silently overwrote the first doc.
  // Fix: fetch each unique code once, then build map from that.
  const uniqueCodes = [...new Set(entries.map((e) => e.ledgerCode))];
  const uniqueDocs = await Promise.all(
    uniqueCodes.map((c) => getAccount(c, session)),
  );
  const accountMap = Object.fromEntries(uniqueDocs.map((a) => [a.code, a]));

  // Sequential — each updateRunningBalance must complete before the next
  // reads the updated balance within the same session.
  const postedEntries = [];

  for (const entry of entries) {
    const account = accountMap[entry.ledgerCode];

    const [created] = await LedgerEntry.create(
      [
        {
          ledgerAccount: account._id,
          debitInPaise: entry.type === "debit" ? entry.amountInPaise : 0,
          creditInPaise: entry.type === "credit" ? entry.amountInPaise : 0,
          description: `JV: ${narration}`,
          narration,
          transaction: null, // Vouchers use transactionRef
          transactionRef: journalVoucherId,
          performedBy,
          requestId,
          businessDate,
        },
      ],
      { session },
    );

    await LedgerAccount.updateRunningBalance(
      account._id,
      entry.type === "debit" ? entry.amountInPaise : 0,
      entry.type === "credit" ? entry.amountInPaise : 0,
      session,
      account.normalBalance,
    );

    postedEntries.push(created);
  }

  return postedEntries;
};

// recordSavingWithdrawal is defined at section 8b above (with advisory cash check).
// This duplicate (without cash check) has been removed.


// ─────────────────────────────────────────────────────────────────────────────
// 11a. LOAN WRITE-OFF
//     DR Bad Debt Expense (+expense)
//     CR Loans Receivable (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanWriteOff = async (params) => {
  assertSession(params.session, "recordLoanWriteOff");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.WRITE_OFF_EXPENSE,
    CODES.LOANS_RECEIVABLE,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Loan write-off (bad debt) — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// recordPigmyWithdrawal is defined below at section 11 (with advisory cash check).
// This duplicate (without cash check) has been removed.


// ─────────────────────────────────────────────────────────────────────────────
// 13. COLLECTION REVERSAL — undoes a pigmy collection
//     DR Customer Pigmy Deposits (−liability)
//     CR Cash in Hand            (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordCollectionReversal = async (params, agentLedgerCode = null) => {
  assertSession(params.session, "recordCollectionReversal");
  if (agentLedgerCode) {
    throw new ApiError(
      500,
      "Cannot use recordCollectionReversal for agent collections. Use recordAgentCollectionReversal instead."
    );
  }
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.PIGMY_DEPOSITS,
    CODES.CASH,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Pigmy collection reversal — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. LOAN REPAYMENT REVERSAL
//     DR Loans Receivable (+asset)
//     CR Pigmy Deposits / Cash (+asset/liability based on original)
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanRepaymentReversal = async (params) => {
  assertSession(params.session, "recordLoanRepaymentReversal");
  const creditCode = params.originalPaymentLedgerCode || CODES.PIGMY_DEPOSITS;
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.LOANS_RECEIVABLE,
    creditCode,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Loan repayment reversal — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. LOAN CLOSURE — CASH RECEIVED FROM CUSTOMER
//     DR Cash in Hand     (+asset)
//     CR Loans Receivable (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanClosure = async (params) => {
  assertSession(params.session, "recordLoanClosure");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.CASH,
    CODES.LOANS_RECEIVABLE,
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Loan closure — cash received ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 16b. LOAN WRITE-OFF REVERSAL — Customer returns after write-off
//
// Original write-off entry (13. recordLoanWriteOff):
//   DR Write-Off Expense (4005) +expense  [P&L hit]
//   CR Loans Receivable  (1002) -asset    [Asset removed]
//
// This reversal EXACTLY undoes that entry:
//   DR Loans Receivable  (1002) +asset    [Asset restored]
//   CR Write-Off Expense (4005) -expense  [P&L hit reversed]
//
// After both entries, the net ledger effect is zero — as if the
// write-off never happened. The loan is back on the company books.
// ─────────────────────────────────────────────────────────────────────────────
const recordLoanWriteOffReversal = async (params) => {
  assertSession(params.session, "recordLoanWriteOffReversal");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.LOANS_RECEIVABLE,   // DR: Restore the asset
    CODES.WRITE_OFF_EXPENSE,  // CR: Reduce/reverse the expense
  );
  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Write-off reversal (loan reactivated) — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 17. AGENT COLLECTION
//     DR Agent Cash (AGNT-xxx)      (+asset)
//     CR Customer Pigmy Deposits    (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const recordAgentCollection = async (params, agentLedgerCode) => {
  assertSession(params.session, "recordAgentCollection"); // ← FIX L-1
  if (!agentLedgerCode) {
    throw new ApiError(
      500,
      "CRITICAL: recordAgentCollection() requires agentLedgerCode. " +
      "Agent does not have a personal ledger account. " +
      "Ensure createAgent() completed successfully — " +
      "Step 5 (LedgerAccount.create) and Step 6 (User.ledgerAccount) " +
      "must both have committed before collections can be recorded.",
    );
  }

  const [debit, credit] = await getAccounts(
    params.session,
    agentLedgerCode,
    CODES.PIGMY_DEPOSITS,
  );

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Agent collection — ₹${(params.amountInPaise / 100).toFixed(2)} | Agent: ${agentLedgerCode}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 18. AGENT COLLECTION REVERSAL
//     DR Customer Pigmy Deposits    (−liability)
//     CR Agent Cash (AGNT-xxx)      (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordAgentCollectionReversal = async (params, agentLedgerCode) => {
  assertSession(params.session, "recordAgentCollectionReversal"); // ← FIX L-1
  if (!agentLedgerCode) {
    throw new ApiError(
      500,
      "CRITICAL: recordAgentCollectionReversal() requires agentLedgerCode. " +
      "Cannot determine which agent account to credit on reversal.",
    );
  }

  const [debit, credit] = await getAccounts(
    params.session,
    CODES.PIGMY_DEPOSITS,
    agentLedgerCode,
  );

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Agent collection reversal — ₹${(params.amountInPaise / 100).toFixed(2)} | Agent: ${agentLedgerCode}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 19. AGENT DEPOSIT
//     DR Cash in Hand (1001)        (+asset)
//     CR Agent Cash (AGNT-xxx)      (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordAgentDeposit = async (params, agentLedgerCode) => {
  assertSession(params.session, "recordAgentDeposit"); // ← FIX L-1
  if (!agentLedgerCode) {
    throw new ApiError(
      500,
      "CRITICAL: recordAgentDeposit() requires agentLedgerCode. " +
      "Cannot determine which agent account to credit on deposit.",
    );
  }

  const [debit, credit] = await getAccounts(
    params.session,
    CODES.CASH,
    agentLedgerCode,
  );

  // Advisory pre-flight — definitive atomic guard is inside updateRunningBalance.
  if (credit.runningBalanceInPaise < params.amountInPaise) {
    throw new ApiError(
      400,
      `Agent deposit amount ₹${(params.amountInPaise / 100).toFixed(2)} ` +
      `exceeds agent's current cash balance ` +
      `₹${(credit.runningBalanceInPaise / 100).toFixed(2)}. ` +
      `Agent can only deposit what they have collected. ` +
      `Check agent's collection records for today.`,
    );
  }

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Agent cash deposit to office — ₹${(params.amountInPaise / 100).toFixed(2)} | Agent: ${agentLedgerCode}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 20. AGENT DEPOSIT REVERSAL
//     DR Agent Cash (AGNT-xxx)      (+asset)
//     CR Cash in Hand (1001)        (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordAgentDepositReversal = async (params, agentLedgerCode) => {
  assertSession(params.session, "recordAgentDepositReversal"); // ← FIX L-1
  if (!agentLedgerCode) {
    throw new ApiError(
      500,
      "CRITICAL: recordAgentDepositReversal() requires agentLedgerCode. " +
      "Cannot determine which agent account to debit on deposit reversal.",
    );
  }

  const [debit, credit] = await getAccounts(
    params.session,
    agentLedgerCode,
    CODES.CASH,
  );

  // Advisory pre-flight — definitive atomic guard is inside updateRunningBalance.
  if (credit.runningBalanceInPaise < params.amountInPaise) {
    throw new ApiError(
      400,
      `Cannot reverse deposit. ` +
      `Company cash balance ₹${(credit.runningBalanceInPaise / 100).toFixed(2)} ` +
      `is less than reversal amount ₹${(params.amountInPaise / 100).toFixed(2)}. ` +
      `Ensure sufficient cash in hand before reversing.`,
    );
  }

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Agent deposit reversal — ₹${(params.amountInPaise / 100).toFixed(2)} | Agent: ${agentLedgerCode}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. CUSTOMER DEPOSIT TO SAVING
//     DR Target Legder Account (e.g. Cash / Bank)        (+asset)
//     CR Customer Saving Deposits                        (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const recordSavingsDeposit = async (params) => {
  assertSession(params.session, "recordSavingsDeposit");

  if (!params.bankLedgerCode) {
    throw new ApiError(500, "bankLedgerCode is required for saving deposits.");
  }

  const [debit, credit] = await getAccounts(
    params.session,
    params.bankLedgerCode,
    CODES.SAVING_DEPOSITS,
  );

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Manual saving deposit (${params.paymentMode}) — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. PIGMY WITHDRAWAL (CASH)
//     DR Customer Pigmy Deposits (−liability)
//     CR Cash in Hand            (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const recordPigmyWithdrawal = async (params) => {
  assertSession(params.session, "recordPigmyWithdrawal");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.PIGMY_DEPOSITS,
    CODES.CASH,
  );

  if (credit.runningBalanceInPaise < params.amountInPaise) {
    throw new ApiError(
      400,
      `Insufficient company cash to process withdrawal. ` +
      `Available: ₹${(credit.runningBalanceInPaise / 100).toFixed(2)}, ` +
      `Required:  ₹${(params.amountInPaise / 100).toFixed(2)}.`,
    );
  }

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Pigmy account cash withdrawal — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. TRANSFER: PIGMY → SAVING
//     DR Customer Pigmy Deposits (−liability)
//     CR Customer Saving Deposits (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const recordPigmyToSavingTransfer = async (params) => {
  assertSession(params.session, "recordPigmyToSavingTransfer");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.PIGMY_DEPOSITS,
    CODES.SAVING_DEPOSITS,
  );

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Internal transfer: Pigmy → Saving — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 13. TRANSFER: SAVING → PIGMY
//     DR Customer Saving Deposits (−liability)
//     CR Customer Pigmy Deposits (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const recordSavingToPigmyTransfer = async (params) => {
  assertSession(params.session, "recordSavingToPigmyTransfer");
  const [debit, credit] = await getAccounts(
    params.session,
    CODES.SAVING_DEPOSITS,
    CODES.PIGMY_DEPOSITS,
  );

  return LedgerEntry.createDoublePair({
    ...params,
    debitLedgerAccount: debit,
    creditLedgerAccount: credit,
    description: `Internal transfer: Saving → Pigmy — ₹${(params.amountInPaise / 100).toFixed(2)}`,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  recordPigmyCollection,
  recordCollectionReversal,
  recordAgentCollection,
  recordAgentCollectionReversal,
  recordAgentDeposit,
  recordAgentDepositReversal,
  // Loan Disbursement (2-step explicit cash flow — industry standard)
  recordLoanCashDisbursement,   // Step 1a: DR Loans Receivable | CR Cash in Hand
  recordPrincipalToSaving,      // Step 1b: DR Cash in Hand     | CR Saving Deposits
  recordProcessingFee,
  recordInterestDeduction,
  recordLoanRepayment,
  recordLoanRepaymentReversal,
  recordLoanClosure,
  recordLoanWriteOff,
  recordLoanWriteOffReversal,
  recordPenaltyCharge,
  recordOpeningChargeDeposit,
  recordOpeningCharge,
  recordSavingWithdrawal,
  recordSavingsDeposit,
  recordPigmyWithdrawal,
  recordPigmyToSavingTransfer,
  recordSavingToPigmyTransfer,
  postJournalVoucher,
};
