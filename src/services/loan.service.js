// src/services/loan.service.js

// ─────────────────────────────────────────────────────────────────────────────
// DISBURSEMENT FLOW — 4 atomic steps inside ONE MongoDB session
//
// Step 1a  LOAN_CASH_DISBURSEMENT   Cash committed to loan book
//           DR Loans Receivable (+asset)    CR Cash in Hand (-asset)
//
// Step 1b  PRINCIPAL_TO_SAVING     Principal enters saving account
//           DR Cash in Hand (+asset)        CR Saving Deposits (+liability)
//
// Step 2   PROCESSING_FEE          Fee deducted from saving balance
//           DR Saving Deposits (-liability) CR Processing Fee Income (+income)
//
// Step 3   INTEREST_DEDUCTION      Upfront flat interest deducted from saving
//           DR Saving Deposits (-liability) CR Interest Income (+income)
//
// NET CASH MOVEMENT at disbursement:
//   Cash in Hand net change = -Principal (Step 1a) + Principal (Step 1b) = ZERO
//   This is correct — cash moved internally from vault to saving pool.
//   Physical cash only leaves the institution when the customer WITHDRAWS
//   their saving balance (DR Saving Deposits | CR Cash in Hand).
//
// AUDIT TRAIL:
//   Both cash legs (1a + 1b) are now visible in the Cash in Hand ledger
//   statement, making the full disbursement path auditable by examiners.
//
// INVARIANT:  principal = fee + interest + netDisbursal
// RESULT:     After step 3, savingAccount.balanceInPaise === preLoanBalance + netDisbursal
// NOTE:       Net disbursal amount stays in the customer's saving account.
//             Customer withdraws their net amount via normal saving withdrawal.
//
// ─────────────────────────────────────────────────────────────────────────────
// REPAYMENT FLOW — pigmy collections do NOT auto-reduce loan
//
// Collection day: Agent collects ₹X → PigmyAccount.balanceInPaise += X
//                 Cash in Hand +X | Pigmy Deposits (liability) +X
//
// Admin decision:  apply pigmy to loan → applyPigmyToLoan()
//
// On applyPigmyToLoan:
//          DR Pigmy Deposits (-liability) CR Loans Receivable (-asset)
//          (Cash stays in Cash in Hand — only the two claims are offset)
//
// If outstanding hits 0 → loan auto-closes inside the same transaction
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// HIGH-5 FIX: Import escapeRegex for safe $regex usage in search queries.
const escapeRegex = require("../utils/escapeRegex");

const mongoose = require("mongoose");
const LoanAccount = require("../models/LoanAccount.model");
const LoanPlan = require("../models/LoanPlan.model");
const SavingAccount = require("../models/SavingAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const Transaction = require("../models/Transaction.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const smsService = require("../utils/sms.service");

const {
  calculateFlatInterest,
  calculateProcessingFee,
  verifyBreakdown,
  calculatePenaltyForDays,
} = require("../utils/interestCalculator");

const { assertKycVerified } = require("./customer.service");

const {
  LOAN_STATUS,
  ACCOUNT_STATUS,
  CONFIG_KEYS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  PAGINATION,
  ROLES,
} = require("../config/constants");

const {
  generateLoanAccountNumber,
  generateTransactionId,
} = require("../utils/generateCode");
const { startOfDay, addMonths, endOfDay } = require("../utils/dateHelpers");

// ═════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPER — Business date resolver
// ═════════════════════════════════════════════════════════════════════════════
const _getBusinessDate = async () => {
  const d = await AppConfig.getValue(CONFIG_KEYS.CURRENT_BUSINESS_DATE);

  if (!d) {
    throw new ApiError(
      500,
      "Business date is not configured in AppConfig. " +
      "Superadmin must run the day-open procedure before processing any transactions.",
    );
  }
  return startOfDay(new Date(d));
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET LOAN PREVIEW — Calculator only, zero DB writes
//    Admin calls this BEFORE creating a loan to show customer the breakdown.
//    Uses interestCalculator.calculateFlatInterest + calculateProcessingFee
//    + verifyBreakdown — single source of truth for all financial math.
// ═════════════════════════════════════════════════════════════════════════════
const getLoanPreview = async ({ principalAmountInPaise, loanPlanId }) => {
  const loanPlan = await LoanPlan.findById(loanPlanId).lean();
  if (!loanPlan || !loanPlan.isActive) {
    throw new ApiError(404, "Loan plan not found or inactive");
  }

  const processingFeeBps =
    (await AppConfig.getValue(CONFIG_KEYS.PROCESSING_FEE_BPS)) || 200;

  const interestInPaise = calculateFlatInterest({
    principalInPaise: principalAmountInPaise,
    annualRateBps: loanPlan.baseInterestRateBps,
    tenureMonths: loanPlan.durationMonths,
  });
  const processingFeeInPaise = calculateProcessingFee({
    principalInPaise: principalAmountInPaise,
    feeBps: processingFeeBps,
  });
  const netDisbursalInPaise =
    principalAmountInPaise - interestInPaise - processingFeeInPaise;

  // verifyBreakdown throws if sum of parts ≠ principal — catch config errors early
  verifyBreakdown({
    principalInPaise: principalAmountInPaise,
    interestInPaise,
    processingFeeInPaise,
    openingChargeInPaise: 0,
    netDisbursalInPaise,
  });

  const durationDays = loanPlan.durationMonths * 30;
  const dailyRequiredDepositInPaise = Math.ceil(principalAmountInPaise / durationDays);

  return {
    loanPlan: {
      _id: loanPlan._id,
      planName: loanPlan.planName,
      durationMonths: loanPlan.durationMonths,
      baseInterestRateBps: loanPlan.baseInterestRateBps,
      minLoanAmountInPaise: loanPlan.minLoanAmountInPaise,
      maxLoanAmountInPaise: loanPlan.maxLoanAmountInPaise,
    },
    breakdown: {
      principalAmountInPaise,
      principalInRupees: (principalAmountInPaise / 100).toFixed(2),
      interestInPaise,
      interestInRupees: (interestInPaise / 100).toFixed(2),
      processingFeeInPaise,
      processingFeeInRupees: (processingFeeInPaise / 100).toFixed(2),
      netDisbursalInPaise,
      netDisbursalInRupees: (netDisbursalInPaise / 100).toFixed(2),
      dailyRequiredDepositInPaise,
      dailyRequiredDepositInRupees: (dailyRequiredDepositInPaise / 100).toFixed(2),
      annualRatePct: (loanPlan.baseInterestRateBps / 100).toFixed(2),
      processingFeePct: (processingFeeBps / 100).toFixed(2),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. CREATE LOAN — Full 4-step atomic disbursement in one MongoDB session
//
//    8 pre-transaction validation gates before session opens.
//    All ID/date generation OUTSIDE session (keeps session body lean).
//    If ANY step inside withTransaction throws → full rollback.
// ═════════════════════════════════════════════════════════════════════════════

const createLoan = async ({
  customerId,
  loanPlanId,
  principalAmountInPaise,
  createdBy,
  ipAddress,
  requestId,
}) => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. " +
      "Complete the day-open procedure before disbursing loans.",
    );
  }

  // ── Gate 1: KYC must be verified ──────────────────────────────────────────
  await assertKycVerified(customerId);

  // ── Gate 2: Idempotency guard ─────────────────────────────────────────────
  if (!requestId) {
    throw new ApiError(
      400,
      "requestId is required for idempotency. " +
      "Generate a unique ID per disbursement request and retry.",
    );
  }

  const duplicate = await Transaction.findOne({
    requestId,
    type: TRANSACTION_TYPES.LOAN_TO_SAVING,
    isDeleted: false,
  }).lean();

  if (duplicate) {
    throw new ApiError(
      409,
      `Duplicate request [${requestId}]. Loan may already be disbursed. ` +
      `Check loan accounts before retrying.`,
    );
  }

  // ── Gate 3: No existing active OR overdue loan (soft pre-check) ───────────
  const existingLoan = await LoanAccount.findOne({
    customer: customerId,
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
    isDeleted: false,
  }).lean();

  if (existingLoan) {
    throw new ApiError(
      409,
      `Customer already has an active/overdue loan: ${existingLoan.loanAccountNumber}. ` +
      `Full repayment is required before a new loan can be disbursed.`,
    );
  }

  // ── Gate 4: Loan plan must exist and be active ────────────────────────────
  const loanPlan = await LoanPlan.findById(loanPlanId).lean();
  if (!loanPlan || !loanPlan.isActive) {
    throw new ApiError(404, "Loan plan not found or inactive");
  }

  // ── Gate 5: Amount must be within plan limits ─────────────────────────────
  if (principalAmountInPaise < loanPlan.minLoanAmountInPaise) {
    throw new ApiError(
      400,
      `Minimum loan amount for this plan is ₹${(loanPlan.minLoanAmountInPaise / 100).toFixed(0)}`,
    );
  }
  if (principalAmountInPaise > loanPlan.maxLoanAmountInPaise) {
    throw new ApiError(
      400,
      `Maximum loan amount for this plan is ₹${(loanPlan.maxLoanAmountInPaise / 100).toFixed(0)}`,
    );
  }

  // ── Gate 6: Customer must have an active saving account ───────────────────
  const savingAccount = await SavingAccount.findOne({
    customer: customerId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!savingAccount) {
    throw new ApiError(
      400,
      "Customer does not have an active saving account. " +
      "Please open a saving account before disbursing a loan.",
    );
  }

  // ── Gate 7: Customer must have an active pigmy account ────────────────────
  const pigmyAccount = await PigmyAccount.findOne({
    customer: customerId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  });

  if (!pigmyAccount) {
    throw new ApiError(
      400,
      "Customer does not have an active pigmy account. " +
      "Loan repayments are collected via daily pigmy — please open one first.",
    );
  }

  // ── Fetch AppConfig rates ─────────────────────────────────────────────────
  const processingFeeBps =
    (await AppConfig.getValue(CONFIG_KEYS.PROCESSING_FEE_BPS)) || 200;

  // ── Calculate breakdown (single source of truth) ─────────────────────────
  const interestInPaise = calculateFlatInterest({
    principalInPaise: principalAmountInPaise,
    annualRateBps: loanPlan.baseInterestRateBps,
    tenureMonths: loanPlan.durationMonths,
  });
  const processingFeeInPaise = calculateProcessingFee({
    principalInPaise: principalAmountInPaise,
    feeBps: processingFeeBps,
  });
  const netDisbursalInPaise =
    principalAmountInPaise - interestInPaise - processingFeeInPaise;

  // ── Gate 8: Net disbursement must be positive ─────────────────────────────
  if (netDisbursalInPaise <= 0) {
    throw new ApiError(
      400,
      `Fee + interest (₹${((processingFeeInPaise + interestInPaise) / 100).toFixed(2)}) ` +
      `exceeds principal (₹${(principalAmountInPaise / 100).toFixed(2)}). ` +
      `Cannot disburse. Increase loan amount or adjust plan rates.`,
    );
  }

  // ── Gate 9: Cash-in-Hand (GL 1001) sufficiency check ─────────────────────
  // The institution must physically hold enough cash to disburse this loan.
  // Checking runningBalance BEFORE session prevents issuing loans against
  // non-existent funds — the root cause of over-lending.
  const cashAccount = await LedgerAccount.findByCode("1001");
  if (!cashAccount) {
    throw new ApiError(
      500,
      "Cash-in-Hand ledger account (GL 1001) not found. " +
      "Run seedSystemAccounts() on startup or contact system administrator.",
    );
  }
  if (cashAccount.runningBalanceInPaise < principalAmountInPaise) {
    throw new ApiError(
      400,
      `Insufficient Cash-in-Hand to disburse this loan. ` +
      `Available: ₹${(cashAccount.runningBalanceInPaise / 100).toFixed(2)}, ` +
      `Required: ₹${(principalAmountInPaise / 100).toFixed(2)}. ` +
      `Record a capital infusion or wait for agent deposit settlements before disbursing.`,
    );
  }

  verifyBreakdown({
    principalInPaise: principalAmountInPaise,
    interestInPaise,
    processingFeeInPaise,
    openingChargeInPaise: 0,
    netDisbursalInPaise,
  });

  const systemDate = await _getBusinessDate();

  const effectiveDate = systemDate;

  // ── Generate all IDs OUTSIDE session (keeps session body lean) ───────────
  const loanAccountId = new mongoose.Types.ObjectId();
  const loanAccountNumber = await generateLoanAccountNumber(effectiveDate);
  const txnRef1a = await generateTransactionId(effectiveDate); // Step 1a: Cash committed to loan book
  const txnRef1b = await generateTransactionId(effectiveDate); // Step 1b: Principal credited to saving
  const txnRef2  = await generateTransactionId(effectiveDate); // Step 2:  Processing fee deduction
  const txnRef3  = await generateTransactionId(effectiveDate); // Step 3:  Interest deduction

  // FIX #13: Use addMonths to prevent month-end overflow
  const maturityDate = addMonths(effectiveDate, loanPlan.durationMonths);

  // NOTE: preLoanSavingBalance is intentionally NOT captured here.
  // It is read inside the session (Step 0) to prevent false integrity failures
  // caused by a concurrent deposit between outer read and session lock.
  let createdLoan;

  // ── OPEN TRANSACTION ──────────────────────────────────────────────────────
  await withTransaction(async (session) => {
    const concurrentLoan = await LoanAccount.findOne({
      customer: customerId,
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
    }).session(session);

    if (concurrentLoan) {
      throw new ApiError(
        409,
        `Customer already has an active/overdue loan: ${concurrentLoan.loanAccountNumber}. ` +
        `A concurrent request may have just created it. Refresh and retry.`,
      );
    }

    // ── Session-locked Cash-in-Hand re-check (race condition guard) ──────────
    // Two concurrent disbursals may both pass the outer Gate 9 check.
    // Re-checking inside the session ensures only one can proceed.
    const freshCash = await LedgerAccount.findByCode("1001", session);
    if (!freshCash || freshCash.runningBalanceInPaise < principalAmountInPaise) {
      throw new ApiError(
        400,
        `Insufficient Cash-in-Hand (concurrent check). ` +
        `Available: ₹${((freshCash?.runningBalanceInPaise || 0) / 100).toFixed(2)}, ` +
        `Required: ₹${(principalAmountInPaise / 100).toFixed(2)}. ` +
        `Another loan may have been processed simultaneously. Retry.`,
      );
    }

    // ── Step 0: Session-locked saving balance ─────────────────────────────
    const freshSaving = await SavingAccount.findById(savingAccount._id)
      .select("balanceInPaise")
      .session(session)
      .lean();

    if (!freshSaving) {
      throw new ApiError(
        404,
        "Saving account not found during loan disbursement. Retry.",
      );
    }

    const preLoanSavingBalance = freshSaving.balanceInPaise;

    // ─── STEP 1a: LOAN_CASH_DISBURSEMENT ─────────────────────────────────────
    // DR Loans Receivable (+asset) | CR Cash in Hand (-asset)
    // Books the loan receivable asset AND records that cash has left the vault
    // into the loan book. Now the Cash in Hand account accurately reflects that
    // this principal amount is no longer freely available.
    const [txn1a] = await Transaction.create(
      [
        {
          transactionId: txnRef1a,
          requestId: requestId,
          type: TRANSACTION_TYPES.LOAN_TO_SAVING,
          toLoanAccount: loanAccountId,
          customer: savingAccount.customer._id,
          performedBy: createdBy,
          amountInPaise: principalAmountInPaise,
          feeInPaise: 0,
          netAmountInPaise: principalAmountInPaise,
          balanceAfterInPaise: principalAmountInPaise,
          reference: loanAccountNumber,
          note: "[Step 1a/4] Loan Principal Disbursed",
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordLoanCashDisbursement({
      transaction: txn1a._id,
      transactionRef: txnRef1a,
      amountInPaise: principalAmountInPaise,
      customer: savingAccount.customer._id,
      performedBy: createdBy,
      businessDate: effectiveDate,
      session,
    });

    // ─── STEP 1b: PRINCIPAL_TO_SAVING ────────────────────────────────────────
    // DR Cash in Hand (+asset) | CR Saving Deposits (+liability)
    // The loan proceeds now enter the customer's saving account.
    // Net Cash in Hand after Steps 1a + 1b = ZERO (internal: vault → saving pool).
    await SavingAccount.findByIdAndUpdate(
      savingAccount._id,
      { $inc: { balanceInPaise: principalAmountInPaise } },
      { session },
    );

    const [txn1b] = await Transaction.create(
      [
        {
          transactionId: txnRef1b,
          requestId: `${requestId}-principal-to-saving`,
          type: TRANSACTION_TYPES.LOAN_TO_SAVING,
          toSavingAccount: savingAccount._id,
          customer: savingAccount.customer._id,
          performedBy: createdBy,
          amountInPaise: principalAmountInPaise,
          feeInPaise: 0,
          netAmountInPaise: principalAmountInPaise,
          balanceAfterInPaise: preLoanSavingBalance + principalAmountInPaise,
          reference: loanAccountNumber,
          note: "[Step 1b/4] Principal credited to saving account (DR Cash in Hand | CR Saving Deposits)",
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordPrincipalToSaving({
      transaction: txn1b._id,
      transactionRef: txnRef1b,
      amountInPaise: principalAmountInPaise,
      customer: savingAccount.customer._id,
      performedBy: createdBy,
      businessDate: effectiveDate,
      session,
    });

    // ─── STEP 2: PROCESSING_FEE ───────────────────────────────────────────
    // DR Saving Deposits (-liability) | CR Processing Fee Income (+income)
    await SavingAccount.findByIdAndUpdate(
      savingAccount._id,
      { $inc: { balanceInPaise: -processingFeeInPaise } },
      { session },
    );

    const [txn2] = await Transaction.create(
      [
        {
          transactionId: txnRef2,
          requestId: `${requestId}-fee`,           // ← FIXED: idempotency key on fee step
          type: TRANSACTION_TYPES.PROCESSING_FEE,
          fromSavingAccount: savingAccount._id,
          customer: savingAccount.customer._id,
          performedBy: createdBy,
          amountInPaise: processingFeeInPaise,
          feeInPaise: processingFeeInPaise,
          netAmountInPaise: processingFeeInPaise,
          balanceAfterInPaise:
            preLoanSavingBalance +
            principalAmountInPaise -
            processingFeeInPaise,
          reference: loanAccountNumber,
          note: "[Step 2/4] Processing fee deducted from saving account",
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordProcessingFee({
      transaction: txn2._id,
      transactionRef: txnRef2,
      amountInPaise: processingFeeInPaise,
      customer: savingAccount.customer._id,
      performedBy: createdBy,
      businessDate: effectiveDate,
      session,
    });

    // ─── STEP 3: INTEREST_DEDUCTION ───────────────────────────────────────
    // DR Saving Deposits (-liability) | CR Interest Income (+income)
    await SavingAccount.findByIdAndUpdate(
      savingAccount._id,
      { $inc: { balanceInPaise: -interestInPaise } },
      { session },
    );

    const [txn3] = await Transaction.create(
      [
        {
          transactionId: txnRef3,
          requestId: `${requestId}-interest`,      // ← FIXED: idempotency key on interest step
          type: TRANSACTION_TYPES.INTEREST_DEDUCTION,
          fromSavingAccount: savingAccount._id,
          customer: savingAccount.customer._id,
          performedBy: createdBy,
          amountInPaise: interestInPaise,
          feeInPaise: 0,
          netAmountInPaise: interestInPaise,
          balanceAfterInPaise:
            preLoanSavingBalance +
            principalAmountInPaise -
            processingFeeInPaise -
            interestInPaise,
          reference: loanAccountNumber,
          note: "[Step 3/4] Upfront flat interest deducted from saving account",
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordInterestDeduction({
      transaction: txn3._id,
      transactionRef: txnRef3,
      amountInPaise: interestInPaise,
      customer: savingAccount.customer._id,
      performedBy: createdBy,
      businessDate: effectiveDate,
      session,
    });


    // ─── STEP 5: Create LoanAccount record ───────────────────────────────
    [createdLoan] = await LoanAccount.create(
      [
        {
          _id: loanAccountId,
          loanAccountNumber,
          customer: savingAccount.customer._id,
          savingAccount: savingAccount._id,
          pigmyAccount: pigmyAccount._id,
          loanPlan: loanPlan._id,
          createdBy,
          interestRateBps: loanPlan.baseInterestRateBps,
          processingFeeBps,
          durationMonths: loanPlan.durationMonths,
          principalAmountInPaise,
          interestInPaise,
          processingFeeInPaise,
          netDisbursalInPaise,
          outstandingBalanceInPaise: principalAmountInPaise,
          totalPaidInPaise: 0,
          penaltyAmountInPaise: 0,
          currentMonthMissedDays: 0,
          currentMonthYear: null,
          totalMissedDaysAllTime: 0,
          status: LOAN_STATUS.ACTIVE,
          disbursedAt: effectiveDate,
          maturityDate,
          businessDate: effectiveDate,
          isDeleted: false,
        },
      ],
      { session },
    );

    // ─── STEP 6: Link pigmy account → this loan ───────────────────────────
    await PigmyAccount.findByIdAndUpdate(
      pigmyAccount._id,
      { $set: { activeLoan: createdLoan._id } },
      { session },
    );

    // ─── STEP 7: Balance integrity assertion ──────────────────────────────
    // INVARIANT: principal = fee + interest + netDisbursal
    // After 3 steps: balance = preLoan + netDisbursal ✓
    const verifyFinalSaving = await SavingAccount.findById(savingAccount._id)
      .select("balanceInPaise")
      .session(session)
      .lean();

    const expectedBalance = preLoanSavingBalance + netDisbursalInPaise;
    if (verifyFinalSaving.balanceInPaise !== expectedBalance) {
      throw new Error(
        `[INTEGRITY FAILURE] Saving balance mismatch after disbursement. ` +
        `Expected: ${expectedBalance}, Got: ${verifyFinalSaving.balanceInPaise}. ` +
        `Loan: ${loanAccountNumber}. All steps rolled back.`,
      );
    }
  });

  // ── Post-transaction: SMS ─────────────────────────────────────────────────
  await smsService
    .sendLoanDisbursed(
      savingAccount.customer.phone,
      savingAccount.customer.name,
      (netDisbursalInPaise / 100).toFixed(0),
      loanAccountNumber,
    )
    .catch((e) =>
      logger.error(
        `[Loan] Disbursement SMS failed: ${e.message} | Loan: ${loanAccountNumber}`,
      ),
    );

  // ── Post-transaction: AuditLog ────────────────────────────────────────────
  await AuditLog.log({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.LOAN_CREATED,
    entity: "LoanAccount",
    entityId: createdLoan._id,
    newData: {
      loanAccountNumber,
      principalAmountInPaise,
      interestInPaise,
      processingFeeInPaise,
      netDisbursalInPaise,
      maturityDate,
      durationMonths: loanPlan.durationMonths,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Loan] Create AuditLog failed: ${e.message}`));

  logger.info(
    `[Loan] CREATED | ${loanAccountNumber} | ` +
    `Principal: ₹${(principalAmountInPaise / 100).toFixed(2)} | ` +
    `Net disbursed: ₹${(netDisbursalInPaise / 100).toFixed(2)} | ` +
    `Maturity: ${maturityDate.toISOString().slice(0, 10)}`,
  );

  return createdLoan;
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET LOAN — Single loan with full summary + computed fields
//    Accepts MongoDB ObjectId OR loanAccountNumber string
// ═════════════════════════════════════════════════════════════════════════════
const getLoan = async (identifier) => {
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(String(identifier));
  const query = isObjectId
    ? { _id: identifier, isDeleted: false }
    : { loanAccountNumber: String(identifier).toUpperCase(), isDeleted: false };

  const loan = await LoanAccount.findOne(query)
    .populate("customer", "name phone customerCode address")
    .populate("savingAccount", "accountNumber balanceInPaise status")
    .populate(
      "pigmyAccount",
      "accountNumber balanceInPaise dailyDepositAmountInPaise status assignedAgent",
    )
    .populate("loanPlan", "planName durationMonths baseInterestRateBps")
    .populate("createdBy", "name role")
    .populate("closedBy", "name role")
    .populate("writtenOffBy", "name role");

  if (!loan) throw new ApiError(404, "Loan account not found");

  const LIVE_STATUSES = [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE];
  const businessDate = await _getBusinessDate();
  const today = startOfDay(businessDate);

  // LOW-1 FIX: Inject business date for Mongoose virtual "isOverdue" computation.
  // Without this, the virtual falls back to Date.now() and logs a warning.
  loan._businessDate = businessDate;

  const daysOverdue = loan.isOverdue
    ? Math.max(0, Math.ceil((today - new Date(loan.maturityDate)) / 86400000))
    : 0;

  const daysToMaturity =
    LIVE_STATUSES.includes(loan.status) && today < new Date(loan.maturityDate)
      ? Math.ceil((new Date(loan.maturityDate) - today) / 86400000)
      : 0;

  const repaymentProgressPct =
    loan.principalAmountInPaise > 0
      ? Math.round((loan.totalPaidInPaise / loan.principalAmountInPaise) * 100)
      : 0;

  const availablePigmy = loan.pigmyAccount?.balanceInPaise || 0;

  return {
    ...loan.toObject({ virtuals: true }),
    summary: {
      outstandingInRupees: (loan.outstandingBalanceInPaise / 100).toFixed(2),
      totalPaidInRupees: (loan.totalPaidInPaise / 100).toFixed(2),
      principalInRupees: (loan.principalAmountInPaise / 100).toFixed(2),
      netDisbursalInRupees: (loan.netDisbursalInPaise / 100).toFixed(2),
      interestInRupees: (loan.interestInPaise / 100).toFixed(2),
      processingFeeInRupees: (loan.processingFeeInPaise / 100).toFixed(2),
      penaltyInRupees: (loan.penaltyAmountInPaise / 100).toFixed(2),
      repaymentProgressPct,
      daysOverdue,
      daysToMaturity,
      pigmyAvailableInPaise: availablePigmy,
      pigmyAvailableInRupees: (availablePigmy / 100).toFixed(2),
      canFullySettleFromPigmy: availablePigmy >= loan.outstandingBalanceInPaise,
      suggestedApplyAmountInPaise: Math.min(
        availablePigmy,
        loan.outstandingBalanceInPaise,
      ),
      suggestedApplyInRupees: (
        Math.min(availablePigmy, loan.outstandingBalanceInPaise) / 100
      ).toFixed(2),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. LIST LOANS — Paginated, filtered, role-scoped
//    Agent → only loans linked to their assigned pigmy accounts
//    Admin → all loans with optional status/customer filter
// ═════════════════════════════════════════════════════════════════════════════
const listLoans = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  status,
  customerId,
  search,
  requestingUserRole,
  requestingUserId,
}) => {
  const filter = { isDeleted: false };

  if (requestingUserRole === ROLES.AGENT) {
    const agentPigmyAccounts = await PigmyAccount.find({
      assignedAgent: requestingUserId,
      isDeleted: false,
    })
      .select("_id")
      .lean();
    filter.pigmyAccount = { $in: agentPigmyAccounts.map((p) => p._id) };
  }

  if (status) filter.status = status;
  if (customerId) filter.customer = customerId;
  if (search) {
    // HIGH-5 FIX: Escape user input before passing to $regex to prevent ReDoS attacks.
    // Raw input like ".*" or "(.*){100}" can cause catastrophic backtracking in MongoDB.
    filter.loanAccountNumber = { $regex: escapeRegex(search.trim()), $options: "i" };
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;


  // .lean() skips Mongoose virtuals — isOverdue must be computed manually.
  const businessDate = await _getBusinessDate();
  const today = startOfDay(businessDate);

  const [loans, total] = await Promise.all([
    LoanAccount.find(filter)
      .select(
        "loanAccountNumber customer pigmyAccount status " +
        "principalAmountInPaise outstandingBalanceInPaise totalPaidInPaise " +
        "maturityDate disbursedAt penaltyAmountInPaise currentMonthMissedDays " +
        "durationMonths interestRateBps",
      )
      .populate("customer", "name phone customerCode")
      .populate("pigmyAccount", "accountNumber balanceInPaise")
      .skip(skip)
      .limit(safeLimit)
      .sort({ createdAt: -1 })
      .lean(),
    LoanAccount.countDocuments(filter),
  ]);

  // Inject isOverdue manually — mirrors the LoanAccount virtual logic exactly.
  const LIVE_STATUSES = [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE];
  const loansWithOverdue = loans.map((loan) => ({
    ...loan,
    isOverdue:
      LIVE_STATUSES.includes(loan.status) &&
      loan.outstandingBalanceInPaise > 0 &&
      today > new Date(loan.maturityDate),
  }));

  return {
    loans: loansWithOverdue,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 5. GET LOANS BY CUSTOMER — Paginated loan history for one customer
//
//    Pagination uses PAGINATION constants from constants.js as the single
//    source of truth — DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT.
//    Response shape matches all other list endpoints: { loans, pagination }.
// ═════════════════════════════════════════════════════════════════════════════
const getLoansByCustomer = async (
  customerId,
  {
    page  = PAGINATION.DEFAULT_PAGE,
    limit = PAGINATION.DEFAULT_LIMIT,
  } = {},
) => {
  const businessDate = await _getBusinessDate();
  const today        = startOfDay(businessDate);
  const LIVE_STATUSES = [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE];

  // Clamp limit to MAX_LIMIT — never trust raw caller input
  const safeLimit = Math.min(Number(limit)  || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
  const safePage  = Math.max(Number(page)   || PAGINATION.DEFAULT_PAGE,  1);
  const skip      = (safePage - 1) * safeLimit;

  const filter = { customer: customerId, isDeleted: false };

  const [loans, total] = await Promise.all([
    LoanAccount.find(filter)
      .select(
        "loanAccountNumber status principalAmountInPaise outstandingBalanceInPaise " +
        "totalPaidInPaise interestInPaise processingFeeInPaise netDisbursalInPaise " +
        "penaltyAmountInPaise maturityDate disbursedAt closedAt durationMonths " +
        "interestRateBps currentMonthMissedDays",
      )
      .populate("loanPlan", "planName durationMonths baseInterestRateBps")
      .populate("pigmyAccount", "accountNumber balanceInPaise")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    LoanAccount.countDocuments(filter),
  ]);

  const enrichedLoans = loans.map((loan) => ({
    ...loan,
    isOverdue:
      LIVE_STATUSES.includes(loan.status) &&
      loan.outstandingBalanceInPaise > 0 &&
      today > new Date(loan.maturityDate),
  }));

  return {
    loans: enrichedLoans,
    pagination: {
      total,
      page:       safePage,
      limit:      safeLimit,
      totalPages: Math.ceil(total / safeLimit),
      // Expose the governing constants so callers know the system limits
      maxLimit:   PAGINATION.MAX_LIMIT,
    },
  };
};


// ═════════════════════════════════════════════════════════════════════════════
// 6. CLOSE LOAN — Admin-initiated foreclosure OR write-off
// ═════════════════════════════════════════════════════════════════════════════

const closeLoan = async ({
  loanId,
  closureReason,
  writeOff = false,
  closedBy,
  ipAddress,
  requestId,
}) => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Day close operations are blocked.",
    );
  }

  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!loan) throw new ApiError(404, "Loan account not found");

  if (![LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(loan.status)) {
    throw new ApiError(
      400,
      `Loan is already ${loan.status}. ` +
      `Only active/overdue loans can be closed or written off.`,
    );
  }

  const systemDate = await _getBusinessDate();
  const effectiveDate = systemDate;

  // ─────────────────────────────────────────────────────────────────────────
  // CRITICAL VALIDATION — Industry standard: A loan can only be naturally
  // closed (without write-off) if the outstanding balance is exactly ₹0.
  // If there is any remaining balance and writeOff=false, this is a rejection.
  //
  // The ONLY way to forcefully close a loan with a remaining balance is to
  // explicitly mark it as a Write-Off (bad debt). This is a separate, audited
  // financial event that hits the P&L and requires SUPERADMIN/ADMIN permission.
  // ─────────────────────────────────────────────────────────────────────────
  if (!writeOff && loan.outstandingBalanceInPaise > 0) {
    throw new ApiError(
      400,
      `CLOSURE BLOCKED: Loan ${loan.loanAccountNumber} has an outstanding balance ` +
      `of ₹${(loan.outstandingBalanceInPaise / 100).toFixed(2)}. ` +
      `A loan can only be closed naturally when the outstanding balance is ₹0.00. ` +
      `Option 1: Collect the remaining ₹${(loan.outstandingBalanceInPaise / 100).toFixed(2)} ` +
      `from the customer and apply it via "Apply Pigmy to Loan". ` +
      `Option 2: If the debt is irrecoverable, use the Write-Off option — ` +
      `this will post a Bad Debt Expense entry to the P&L and permanently close the loan.`,
    );
  }
  if (!writeOff && loan.outstandingBalanceInPaise === 0) {
    await withTransaction(async (session) => {
      const closedLoan = await LoanAccount.findOneAndUpdate(
        {
          _id: loanId,
          status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
          isDeleted: false,
        },
        {
          $set: {
            status: LOAN_STATUS.CLOSED,
            closedAt: effectiveDate,
            closedBy,
            closeNote:
              closureReason ||
              "Closed — loan was already fully repaid via pigmy",
          },
        },
        { returnDocument: "after", session },
      );

      if (!closedLoan) {
        throw new ApiError(
          409,
          "Loan was already closed by another session. Refresh and retry.",
        );
      }

      await PigmyAccount.findOneAndUpdate(
        { activeLoan: loanId },
        { $unset: { activeLoan: "" } },
        { session },
      );
    });

    await AuditLog.log({
      performedBy: closedBy,
      action: AUDIT_ACTIONS.LOAN_CLOSED,
      entity: "LoanAccount",
      entityId: loanId,
      oldData: { status: loan.status, outstandingBalanceInPaise: 0 },
      newData: {
        status: LOAN_STATUS.CLOSED,
        closureReason,
        writeOff: false,
        note: "Zero-outstanding close — no ledger entry required",
      },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.SUCCESS,
    }).catch((e) =>
      logger.error(`[Loan] Zero-close AuditLog failed: ${e.message}`),
    );

    logger.info(
      `[Loan] CLOSED (zero-outstanding — no ledger entry) | ${loan.loanAccountNumber} | By: ${closedBy}`,
    );

    return {
      loanAccountNumber: loan.loanAccountNumber,
      status: LOAN_STATUS.CLOSED,
      message: `Loan ${loan.loanAccountNumber} closed (outstanding was already ₹0).`,
    };
  }

  // ── Path B: Non-zero close or write-off (ledger entry required) ───────────
  const txnRef = await generateTransactionId(effectiveDate);
  const newStatus = writeOff ? LOAN_STATUS.WRITTEN_OFF : LOAN_STATUS.CLOSED;
  const txnType = writeOff
    ? TRANSACTION_TYPES.LOAN_WRITE_OFF
    : TRANSACTION_TYPES.LOAN_CLOSURE;

  let definitiveOutstanding;

  await withTransaction(async (session) => {
    // Re-read outstanding WITH session lock — this is the authoritative value
    const freshLoan = await LoanAccount.findById(loanId)
      .select("outstandingBalanceInPaise status")
      .session(session)
      .lean();

    if (!freshLoan) {
      throw new ApiError(404, "Loan not found during close. Retry.");
    }

    definitiveOutstanding = freshLoan.outstandingBalanceInPaise;

    const closedLoan = await LoanAccount.findOneAndUpdate(
      {
        _id: loanId,
        status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
        isDeleted: false,
      },
      {
        $set: {
          status: newStatus,
          outstandingBalanceInPaise: 0,
          closedAt: writeOff ? null : effectiveDate,
          closedBy: writeOff ? null : closedBy,
          closeNote: writeOff
            ? null
            : closureReason || "Admin-initiated closure",
          writtenOffAt: writeOff ? effectiveDate : null,
          writtenOffBy: writeOff ? closedBy : null,
          writeOffReason: writeOff ? closureReason : null,
        },
      },
      { returnDocument: "after", session },
    );

    if (!closedLoan) {
      throw new ApiError(
        409,
        "Loan was already closed by another session. Refresh and retry.",
      );
    }

    const [txn] = await Transaction.create(
      [
        {
          transactionId: txnRef,
          requestId: requestId || null,
          type: txnType,
          fromLoanAccount: loanId,
          customer: loan.customer._id,
          performedBy: closedBy,
          amountInPaise: definitiveOutstanding, // ← session-locked
          feeInPaise: 0,
          netAmountInPaise: definitiveOutstanding, // ← session-locked
          balanceAfterInPaise: 0,
          reference: loan.loanAccountNumber,
          note:
            closureReason || (writeOff ? "Loan written off" : "Loan closed"),
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    if (writeOff) {
      await ledger.recordLoanWriteOff({
        transaction: txn._id,
        transactionRef: txnRef,
        amountInPaise: definitiveOutstanding,
        customer: loan.customer._id,
        performedBy: closedBy,
        businessDate: effectiveDate,
        session,
      });
    } else {
      await ledger.recordLoanClosure({
        transaction: txn._id,
        transactionRef: txnRef,
        amountInPaise: definitiveOutstanding,
        customer: loan.customer._id,
        performedBy: closedBy,
        businessDate: effectiveDate,
        session,
      });
    }

    await PigmyAccount.findOneAndUpdate(
      { activeLoan: loanId },
      { $unset: { activeLoan: "" } },
      { session },
    );
  });

  if (writeOff) {
    await smsService
      .sendLoanWrittenOff(
        loan.customer.phone,
        loan.customer.name,
        loan.loanAccountNumber,
      )
      .catch((e) =>
        logger.error(
          `[Loan] Write-off SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
        ),
      );
  } else {
    await smsService
      .sendLoanClosed(
        loan.customer.phone,
        loan.customer.name,
        loan.loanAccountNumber,
      )
      .catch((e) =>
        logger.error(
          `[Loan] Closure SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
        ),
      );
  }

  await AuditLog.log({
    performedBy: closedBy,
    action: writeOff
      ? AUDIT_ACTIONS.LOAN_WRITTEN_OFF
      : AUDIT_ACTIONS.LOAN_CLOSED,
    entity: "LoanAccount",
    entityId: loanId,
    oldData: {
      status: loan.status,
      outstandingBalanceInPaise: definitiveOutstanding,
    },
    newData: {
      status: newStatus,
      closureReason,
      writeOff,
      transactionRef: txnRef,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Loan] Closure AuditLog failed: ${e.message}`));

  logger.info(
    `[Loan] ${writeOff ? "WRITTEN OFF" : "CLOSED"} | ${loan.loanAccountNumber} | ` +
    `Outstanding was: ₹${(definitiveOutstanding / 100).toFixed(2)} | ` +
    `By: ${closedBy}`,
  );

  return {
    loanAccountNumber: loan.loanAccountNumber,
    status: newStatus,
    transactionRef: txnRef,
    message: writeOff
      ? `Loan ${loan.loanAccountNumber} written off successfully.`
      : `Loan ${loan.loanAccountNumber} closed successfully.`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 7. APPLY PIGMY TO LOAN — Admin manually transfers pigmy balance → loan
// ═════════════════════════════════════════════════════════════════════════════

const applyPigmyToLoan = async ({
  loanId,
  amountInPaise,
  note,
  appliedBy,
  ipAddress,
  requestId,
}) => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Cannot process repayments.",
    );
  }

  if (!requestId) {
    throw new ApiError(
      400,
      "requestId is required for idempotency. " +
      "Generate a unique ID per repayment request and retry.",
    );
  }

  const duplicate = await Transaction.findOne({
    requestId,
    type: TRANSACTION_TYPES.LOAN_REPAYMENT,
    isDeleted: false,
  }).lean();

  if (duplicate) {
    throw new ApiError(
      409,
      `Duplicate request [${requestId}]. This repayment may already be applied. ` +
      `Verify loan outstanding before retrying.`,
    );
  }

  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!loan) throw new ApiError(404, "Loan account not found");

  if (![LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(loan.status)) {
    throw new ApiError(
      400,
      `Cannot apply repayment to a ${loan.status} loan. ` +
      `Only active or overdue loans accept repayments.`,
    );
  }

  const pigmyAccount = await PigmyAccount.findOne({
    _id: loan.pigmyAccount,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  });

  if (!pigmyAccount) {
    throw new ApiError(
      400,
      `No active pigmy account found linked to loan ${loan.loanAccountNumber}. ` +
      `Cannot process repayment.`,
    );
  }

  // Soft pre-check using stale read — full atomic guard runs inside session
  if (amountInPaise > loan.outstandingBalanceInPaise) {
    throw new ApiError(
      400,
      `Amount ₹${(amountInPaise / 100).toFixed(2)} exceeds outstanding ` +
      `₹${(loan.outstandingBalanceInPaise / 100).toFixed(2)}. ` +
      `Reduce the amount. Overpayment is not allowed.`,
    );
  }

  const systemDate = await _getBusinessDate();

  const effectiveDate = systemDate;

  const txnRef = await generateTransactionId(effectiveDate);
  let finalLoan;
  let newPigmyBal;

  await withTransaction(async (session) => {
    // ── Deduct pigmy balance — atomic $gte guard prevents overdraft
    const updatedPigmy = await PigmyAccount.findOneAndUpdate(
      {
        _id: pigmyAccount._id,
        balanceInPaise: { $gte: amountInPaise },
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      },
      { $inc: { balanceInPaise: -amountInPaise } },
      { returnDocument: "after", session },
    );

    if (!updatedPigmy) {
      const current = await PigmyAccount.findById(pigmyAccount._id)
        .session(session)
        .lean();
      throw new ApiError(
        400,
        `Insufficient pigmy balance. ` +
        `Available: ₹${((current?.balanceInPaise || 0) / 100).toFixed(2)}, ` +
        `Requested: ₹${(amountInPaise / 100).toFixed(2)}. ` +
        `Collect more before applying.`,
      );
    }

    newPigmyBal = updatedPigmy.balanceInPaise;


    finalLoan = await LoanAccount.findOneAndUpdate(
      {
        _id: loanId,
        outstandingBalanceInPaise: { $gte: amountInPaise },
        status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
        isDeleted: false,
      },
      {
        $inc: {
          outstandingBalanceInPaise: -amountInPaise,
          totalPaidInPaise: +amountInPaise,
        },
      },
      { returnDocument: "after", session },
    );

    if (!finalLoan) {
      // Concurrent repayment raced us — pigmy deduction must roll back too
      throw new ApiError(
        400,
        `Insufficient loan outstanding or concurrent modification detected. ` +
        `Outstanding balance may have changed. Please retry.`,
      );
    }

    const isFullyRepaidNow = finalLoan.outstandingBalanceInPaise === 0;

    if (isFullyRepaidNow) {
      await LoanAccount.findByIdAndUpdate(
        loanId,
        {
          $set: {
            status: LOAN_STATUS.CLOSED,
            closedAt: effectiveDate,
            closedBy: appliedBy,
            closeNote: "Fully repaid via admin pigmy transfer",
          },
        },
        { session },
      );
    }

    const actualNewOutstanding = finalLoan.outstandingBalanceInPaise;

    const [txn] = await Transaction.create(
      [
        {
          transactionId: txnRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.LOAN_REPAYMENT,
          fromPigmyAccount: pigmyAccount._id,
          toLoanAccount: loanId,
          customer: loan.customer._id,
          performedBy: appliedBy,
          amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: amountInPaise,
          balanceAfterInPaise: actualNewOutstanding,
          reference: loan.loanAccountNumber,
          note:
            note || `Pigmy balance applied to loan ${loan.loanAccountNumber}`,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordLoanRepayment({
      transaction: txn._id,
      transactionRef: txnRef,
      amountInPaise,
      customer: loan.customer._id,
      performedBy: appliedBy,
      businessDate: effectiveDate,
      session,
    });

    if (isFullyRepaidNow) {
      await PigmyAccount.findByIdAndUpdate(
        pigmyAccount._id,
        { $unset: { activeLoan: "" } },
        { session },
      );
    }
  });

  // Post-session: derive authoritative values from session-locked finalLoan
  const isFullyRepaid = finalLoan.outstandingBalanceInPaise === 0;
  const actualNewOutstanding = finalLoan.outstandingBalanceInPaise;

  await smsService
    .sendLoanRepayment(
      loan.customer.phone,
      loan.customer.name,
      String(amountInPaise),
      loan.loanAccountNumber,
      String(actualNewOutstanding),
    )
    .catch((e) =>
      logger.error(
        `[Loan] Repayment SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
      ),
    );

  if (isFullyRepaid) {
    await smsService
      .sendLoanClosed(
        loan.customer.phone,
        loan.customer.name,
        loan.loanAccountNumber,
      )
      .catch((e) =>
        logger.error(`[Loan] Full repayment closure SMS failed: ${e.message}`),
      );
  }

  await AuditLog.log({
    performedBy: appliedBy,
    action: AUDIT_ACTIONS.APPLY_PIGMY_TO_LOAN,
    entity: "LoanAccount",
    entityId: loanId,
    oldData: {
      outstandingBalanceInPaise: loan.outstandingBalanceInPaise,
      totalPaidInPaise: loan.totalPaidInPaise,
      pigmyBalanceInPaise: pigmyAccount.balanceInPaise,
    },
    newData: {
      appliedAmountInPaise: amountInPaise,
      newOutstandingInPaise: actualNewOutstanding,
      newPigmyBalanceInPaise: newPigmyBal,
      loanFullyRepaid: isFullyRepaid,
      transactionRef: txnRef,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) =>
    logger.error(`[Loan] ApplyPigmy AuditLog failed: ${e.message}`),
  );

  logger.info(
    `[Loan] PIGMY APPLIED | ${loan.loanAccountNumber} | ` +
    `Applied: ₹${(amountInPaise / 100).toFixed(2)} | ` +
    `Remaining: ₹${(actualNewOutstanding / 100).toFixed(2)} | ` +
    `${isFullyRepaid ? "FULLY REPAID — LOAN CLOSED" : "Partial repayment"}`,
  );

  return {
    loanAccountNumber: loan.loanAccountNumber,
    transactionRef: txnRef,
    appliedAmountInPaise: amountInPaise,
    appliedAmountInRupees: (amountInPaise / 100).toFixed(2),
    newOutstandingInPaise: actualNewOutstanding,
    newOutstandingInRupees: (actualNewOutstanding / 100).toFixed(2),
    newPigmyBalanceInPaise: newPigmyBal,
    newPigmyBalanceInRupees: (newPigmyBal / 100).toFixed(2),
    loanFullyRepaid: isFullyRepaid,
    message: isFullyRepaid
      ? `Loan ${loan.loanAccountNumber} fully repaid and closed.`
      : `₹${(amountInPaise / 100).toFixed(2)} applied to loan ${loan.loanAccountNumber}. ` +
      `Remaining: ₹${(actualNewOutstanding / 100).toFixed(2)}.`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 8. GET LOAN REPAYMENT DASHBOARD — Admin decision-support tool
// URGENCY BANDS:
// overdue  → maturity already passed (penalty accumulating NOW)
// critical → maturity within 7 days
// warning  → maturity within 30 days
// normal   → maturity 31+ days away
// ═════════════════════════════════════════════════════════════════════════════
const getLoanRepaymentDashboard = async ({ daysThreshold = 30 } = {}) => {
  daysThreshold = Math.max(1, Math.min(Number(daysThreshold) || 30, 365));
  const rawBusinessDate = await _getBusinessDate();
  const today = startOfDay(rawBusinessDate);

  const thresholdDate = new Date(today.getTime() + daysThreshold * 24 * 60 * 60 * 1000);

  const loans = await LoanAccount.find({
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
    isDeleted: false,
    $or: [
      { status: LOAN_STATUS.OVERDUE },
      { maturityDate: { $lte: thresholdDate } },
    ],
  })
    .populate("customer", "name phone customerCode")
    .populate(
      "pigmyAccount",
      "accountNumber balanceInPaise dailyDepositAmountInPaise",
    )
    .lean();

  const URGENCY_ORDER = { overdue: 0, critical: 1, warning: 2, normal: 3 };

  const enriched = loans.map((loan) => {
    const daysToMaturity = Math.ceil(
      (new Date(loan.maturityDate) - today) / 86400000,
    );
    const availablePigmy = loan.pigmyAccount?.balanceInPaise || 0;
    const canFullySettle = availablePigmy >= loan.outstandingBalanceInPaise;
    const suggestedAmount = Math.min(
      availablePigmy,
      loan.outstandingBalanceInPaise,
    );

    let urgency;
    if (daysToMaturity <= 0) urgency = "overdue";
    else if (daysToMaturity <= 7) urgency = "critical";
    else if (daysToMaturity <= 30) urgency = "warning";
    else urgency = "normal";

    return {
      loanId: loan._id,
      loanAccountNumber: loan.loanAccountNumber,
      status: loan.status,
      urgency,
      customer: {
        _id: loan.customer?._id,
        name: loan.customer?.name,
        phone: loan.customer?.phone,
        customerCode: loan.customer?.customerCode,
      },
      pigmyAccount: {
        _id: loan.pigmyAccount?._id,
        accountNumber: loan.pigmyAccount?.accountNumber,
        availableBalanceInPaise: availablePigmy,
        availableBalanceInRupees: (availablePigmy / 100).toFixed(2),
        dailyDepositInPaise: loan.pigmyAccount?.dailyDepositAmountInPaise || 0,
      },
      loan: {
        principalInPaise: loan.principalAmountInPaise,
        principalInRupees: (loan.principalAmountInPaise / 100).toFixed(2),
        outstandingInPaise: loan.outstandingBalanceInPaise,
        outstandingInRupees: (loan.outstandingBalanceInPaise / 100).toFixed(2),
        totalPaidInPaise: loan.totalPaidInPaise,
        totalPaidInRupees: (loan.totalPaidInPaise / 100).toFixed(2),
        penaltyInPaise: loan.penaltyAmountInPaise,
        penaltyInRupees: (loan.penaltyAmountInPaise / 100).toFixed(2),
        repaymentProgressPct:
          loan.principalAmountInPaise > 0
            ? Math.round(
              (loan.totalPaidInPaise / loan.principalAmountInPaise) * 100,
            )
            : 0,
      },
      maturityDate: loan.maturityDate,
      daysToMaturity,
      canFullySettle,
      suggestedApplyInPaise: suggestedAmount,
      suggestedApplyInRupees: (suggestedAmount / 100).toFixed(2),
    };
  });

  enriched.sort((a, b) => {
    const byUrgency = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    return byUrgency !== 0 ? byUrgency : a.daysToMaturity - b.daysToMaturity;
  });

  const summary = enriched.reduce(
    (acc, loan) => {
      acc[loan.urgency] = (acc[loan.urgency] || 0) + 1;
      acc.totalOutstandingInPaise += loan.loan.outstandingInPaise;
      acc.totalPigmyAvailableInPaise +=
        loan.pigmyAccount.availableBalanceInPaise;
      return acc;
    },
    {
      overdue: 0,
      critical: 0,
      warning: 0,
      normal: 0,
      totalLoans: enriched.length,
      totalOutstandingInPaise: 0,
      totalPigmyAvailableInPaise: 0,
    },
  );

  summary.totalOutstandingInRupees = (
    summary.totalOutstandingInPaise / 100
  ).toFixed(2);
  summary.totalPigmyAvailableInRupees = (
    summary.totalPigmyAvailableInPaise / 100
  ).toFixed(2);

  return { summary, loans: enriched };
};



// ═════════════════════════════════════════════════════════════════════════════
// 10. APPLY PENALTY — Admin charges penalty to a specific loan
//
// LEDGER:
// DR Loans Receivable (+asset) | CR Penalty Income (+income)
// ═════════════════════════════════════════════════════════════════════════════
const applyPenalty = async ({
  loanId,
  penaltyAmountInPaise,
  reason,
  appliedBy,
  ipAddress,
  requestId,
}) => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Cannot apply penalties.",
    );
  }

  // BANKING STANDARD: requestId is MANDATORY on penalty charges.
  // Manual penalties without idempotency can double-charge a customer on API retry
  // or double-click. Enforce at service layer, not just controller.
  if (!requestId) {
    throw new ApiError(
      400,
      "requestId is required for idempotency on penalty charges. " +
      "Generate a unique ID per penalty request to prevent accidental double-charges.",
    );
  }

  const duplicate = await Transaction.findOne({
    requestId,
    type: TRANSACTION_TYPES.PENALTY_CHARGE,
  }).lean();
  if (duplicate) {
    throw new ApiError(
      409,
      `Duplicate request [${requestId}]. Penalty may already be applied to loan. ` +
      `Check loan records before retrying.`,
    );
  }

  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!loan) throw new ApiError(404, "Loan account not found");

  if (![LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(loan.status)) {
    throw new ApiError(
      400,
      `Cannot apply penalty to a ${loan.status} loan. ` +
      `Only active or overdue loans can receive penalties.`,
    );
  }

  if (penaltyAmountInPaise <= 0) {
    throw new ApiError(400, "Penalty amount must be greater than zero.");
  }

  const systemDate = await _getBusinessDate();

  const effectiveDate = systemDate;

  const txnRef = await generateTransactionId(effectiveDate);

  let definitiveOutstanding;
  let definitiveNewTotalPenalty;

  await withTransaction(async (session) => {
    // ── Re-read loan INSIDE session — session-locked authoritative values ──
    const freshLoan = await LoanAccount.findById(loanId)
      .select(
        "outstandingBalanceInPaise penaltyAmountInPaise status maturityDate",
      )
      .session(session)
      .lean();

    if (!freshLoan) {
      throw new ApiError(
        404,
        "Loan not found during penalty application. Retry.",
      );
    }

    // Compute from session-locked values — not stale outer read
    definitiveOutstanding =
      freshLoan.outstandingBalanceInPaise + penaltyAmountInPaise;
    definitiveNewTotalPenalty =
      freshLoan.penaltyAmountInPaise + penaltyAmountInPaise;

    // Only mark OVERDUE if the session-locked status is still ACTIVE
    // (a concurrent process may have already marked it OVERDUE)
    const statusUpdate =
      freshLoan.status === LOAN_STATUS.ACTIVE &&
        effectiveDate > new Date(freshLoan.maturityDate)
        ? { status: LOAN_STATUS.OVERDUE }
        : {};

    await LoanAccount.findByIdAndUpdate(
      loanId,
      {
        $inc: {
          outstandingBalanceInPaise: +penaltyAmountInPaise,
          penaltyAmountInPaise: +penaltyAmountInPaise,
        },
        $set: {
          lastPenaltyAppliedDate: effectiveDate,
          ...statusUpdate,
        },
      },
      { session },
    );

    const [txn] = await Transaction.create(
      [
        {
          transactionId: txnRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.PENALTY_CHARGE,
          toLoanAccount: loanId,
          customer: loan.customer._id,
          performedBy: appliedBy,
          amountInPaise: penaltyAmountInPaise,
          feeInPaise: 0,
          netAmountInPaise: penaltyAmountInPaise,
          balanceAfterInPaise: definitiveOutstanding, // ← session-locked
          reference: loan.loanAccountNumber,
          note: reason || "Penalty for excess missed collections",
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    await ledger.recordPenaltyCharge({
      transaction: txn._id,
      transactionRef: txnRef,
      amountInPaise: penaltyAmountInPaise,
      customer: loan.customer._id,
      performedBy: appliedBy,
      businessDate: effectiveDate,
      session,
    });
  });

  await smsService
    .sendPenaltyApplied(
      loan.customer.phone,
      loan.customer.name,
      String(penaltyAmountInPaise),
      loan.loanAccountNumber,
    )
    .catch((e) =>
      logger.error(
        `[Loan] Penalty SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
      ),
    );

  await AuditLog.log({
    performedBy: appliedBy,
    action: AUDIT_ACTIONS.PENALTY_APPLIED,
    entity: "LoanAccount",
    entityId: loanId,
    oldData: {
      outstandingBalanceInPaise: loan.outstandingBalanceInPaise, // stale read = correct for "before" snapshot
      penaltyAmountInPaise: loan.penaltyAmountInPaise,
    },
    newData: {
      penaltyAppliedInPaise: penaltyAmountInPaise,
      newOutstandingInPaise: definitiveOutstanding, // ← session-locked
      newTotalPenaltyInPaise: definitiveNewTotalPenalty, // ← session-locked
      reason,
      transactionRef: txnRef,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Loan] Penalty AuditLog failed: ${e.message}`));

  logger.info(
    `[Loan] PENALTY APPLIED | ${loan.loanAccountNumber} | ` +
    `Penalty: ₹${(penaltyAmountInPaise / 100).toFixed(2)} | ` +
    `New outstanding: ₹${(definitiveOutstanding / 100).toFixed(2)} | ` +
    `By: ${appliedBy}`,
  );

  return {
    loanAccountNumber: loan.loanAccountNumber,
    transactionRef: txnRef,
    penaltyAppliedInPaise: penaltyAmountInPaise,
    penaltyAppliedInRupees: (penaltyAmountInPaise / 100).toFixed(2),
    newOutstandingInPaise: definitiveOutstanding, // ← session-locked
    newOutstandingInRupees: (definitiveOutstanding / 100).toFixed(2),
    totalPenaltyToDateInPaise: definitiveNewTotalPenalty, // ← session-locked
    totalPenaltyInRupees: (definitiveNewTotalPenalty / 100).toFixed(2),
    message: `Penalty of ₹${(penaltyAmountInPaise / 100).toFixed(2)} applied to loan ${loan.loanAccountNumber}.`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 11. SEND LOAN REMINDER — Admin manually triggers SMS reminder
//     No financial operation — purely informational.
// ═════════════════════════════════════════════════════════════════════════════
const sendLoanReminder = async ({ loanId, sentBy, ipAddress }) => {
  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!loan) throw new ApiError(404, "Loan account not found");

  if (![LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(loan.status)) {
    throw new ApiError(
      400,
      `Reminders can only be sent for active or overdue loans. ` +
      `This loan is ${loan.status}.`,
    );
  }

  const smsResult = await smsService
    .sendLoanPaymentReminder(
      loan.customer.phone,
      loan.customer.name,
      String(loan.outstandingBalanceInPaise),
      loan.loanAccountNumber,
      loan.currentMonthMissedDays,
    )
    .catch((e) => {
      logger.error(
        `[Loan] Reminder SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
      );
      return { success: false, reason: e.message };
    });

  await AuditLog.log({
    performedBy: sentBy,
    action: AUDIT_ACTIONS.LOAN_REMINDER_SENT,
    entity: "LoanAccount",
    entityId: loanId,
    newData: {
      outstandingBalanceInPaise: loan.outstandingBalanceInPaise,
      currentMonthMissedDays: loan.currentMonthMissedDays,
      smsSent: smsResult?.success || false,
      smsReason: smsResult?.reason || null,
    },
    ipAddress,
    status: smsResult?.success ? AUDIT_STATUS.SUCCESS : AUDIT_STATUS.FAILURE,
  }).catch((e) =>
    logger.error(`[Loan] Reminder AuditLog failed: ${e.message}`),
  );

  logger.info(
    `[Loan] REMINDER SENT | ${loan.loanAccountNumber} | ` +
    `SMS: ${smsResult?.success ? "delivered" : "failed"} | ` +
    `Outstanding: ₹${(loan.outstandingBalanceInPaise / 100).toFixed(2)}`,
  );

  return {
    loanAccountNumber: loan.loanAccountNumber,
    customerName: loan.customer.name,
    customerPhone: loan.customer.phone,
    outstandingInRupees: (loan.outstandingBalanceInPaise / 100).toFixed(2),
    currentMonthMissedDays: loan.currentMonthMissedDays,
    smsSent: smsResult?.success || false,
    message: smsResult?.success
      ? `Reminder sent successfully to ${loan.customer.name}.`
      : `Reminder logged but SMS delivery failed. Customer: ${loan.customer.name}.`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// 10. REOPEN LOAN — Customer returns after write-off or premature closure
//
// Flow:
//   1. Validate loan is CLOSED or WRITTEN_OFF (not deletd)
//   2. Verify no currently ACTIVE/OVERDUE loan exists for this customer
//      (MongoDB partial-unique index would also catch this, but we fail-fast
//       with a human-readable message first)
//   3. Determine restored status:
//        today > maturityDate → OVERDUE  (customer pays penalty rate)
//        today ≤ maturityDate → ACTIVE   (normal interest, within tenure)
//   4. If was WRITTEN_OFF → reverse the write-off ledger:
//        DR Loans Receivable (1002)   +asset (restores the loan on books)
//        CR Bad Debt Expense  (4005)  -expense (reverses the P&L hit)
//   5. Clear all closure/write-off metadata.
//   6. Re-link pigmy account if it was un-linked and is currently free.
//   7. Create LOAN_WRITE_OFF_REVERSAL transaction record for audit trail.
//   8. Post full LOAN_REACTIVATED AuditLog.
//   9. Send SMS notification to customer.
// ═════════════════════════════════════════════════════════════════════════════

const reopenLoan = async ({
  loanId,
  reactivationReason,
  reopenedBy,
  ipAddress,
  requestId,
}) => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Loan reactivation is a financial transaction — " +
      "it must be processed within an open business day.",
    );
  }

  // ── Step 1: Fetch and validate the loan ──────────────────────────────────
  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
  }).populate("customer", "name phone customerCode");

  if (!loan) throw new ApiError(404, "Loan account not found.");

  const reopenableStatuses = [LOAN_STATUS.CLOSED, LOAN_STATUS.WRITTEN_OFF];
  if (!reopenableStatuses.includes(loan.status)) {
    throw new ApiError(
      400,
      `Loan is currently ${loan.status}. ` +
      `Only CLOSED or WRITTEN_OFF loans can be reactivated. ` +
      `Active/Overdue loans do not require reactivation.`,
    );
  }

  // ── Step 2: Check no active loan already exists for this customer ─────────
  // The partial-unique index covers this at DB level, but we give a clear message
  const existingActiveLoan = await LoanAccount.findActiveByCustomer(loan.customer._id);
  if (existingActiveLoan) {
    throw new ApiError(
      409,
      `Customer ${loan.customer.name} already has an active loan ` +
      `(${existingActiveLoan.loanAccountNumber}, status: ${existingActiveLoan.status}). ` +
      `A customer can only have ONE active loan at a time. ` +
      `Close or fully settle the existing loan before reactivating this one.`,
    );
  }

  const wasWrittenOff = loan.status === LOAN_STATUS.WRITTEN_OFF;
  const systemDate = await _getBusinessDate();

  // ── Step 3: Determine restored status based on maturity date ──────────────
  // If today is past the original maturity date → loan resumes as OVERDUE
  // (penalty interest rate applies per the existing penalty cron engine)
  // If today is within the original tenure → loan resumes as ACTIVE
  const restoredStatus = systemDate > new Date(loan.maturityDate)
    ? LOAN_STATUS.OVERDUE
    : LOAN_STATUS.ACTIVE;

  let txnRef = null;

  // ── Steps 4-6: Atomic database transaction ────────────────────────────────
  await withTransaction(async (session) => {

    // ── Step 4 (write-off only): Reverse the bad-debt ledger entry ───────────
    // When a loan was written off:
    //   Original entry: DR Write-Off Expense (4005), CR Loans Receivable (1002)
    // Reversal entry:   DR Loans Receivable (1002),  CR Write-Off Expense (4005)
    // Net effect: The Bad Debt Expense is zeroed out from P&L, and the
    // Loans Receivable asset is restored. The loan is back on company books.
    if (wasWrittenOff) {
      txnRef = await generateTransactionId(systemDate);

      // Guard against zero or negative restore amounts.
      // This can happen if the loan was fully/over-paid before being written off.
      // A zero-amount write-off reversal creates an invalid/imbalanced ledger entry.
      const amountToRestore = loan.principalAmountInPaise + loan.penaltyAmountInPaise - loan.totalPaidInPaise;
      if (amountToRestore <= 0) {
        throw new ApiError(
          400,
          `Cannot reopen write-off loan ${loan.loanAccountNumber}: ` +
          `computed outstanding balance is ₹${(amountToRestore / 100).toFixed(2)}. ` +
          `The loan appears to have been fully repaid before write-off. ` +
          `Use the zero-outstanding close path instead, or post a Journal Voucher to correct the ledger.`
        );
      }

      const [txn] = await Transaction.create(
        [
          {
            transactionId: txnRef,
            requestId: requestId || null,
            type: TRANSACTION_TYPES.LOAN_WRITE_OFF_REVERSAL,
            fromLoanAccount: loanId,
            customer: loan.customer._id,
            performedBy: reopenedBy,
            amountInPaise: amountToRestore,
            feeInPaise: 0,
            netAmountInPaise: amountToRestore,
            balanceAfterInPaise: amountToRestore,
            reference: loan.loanAccountNumber,
            note: `Write-off reversal on reactivation: ${reactivationReason}`,
            status: TRANSACTION_STATUS.COMPLETED,
            businessDate: systemDate,
          },
        ],
        { session },
      );

      // Post the reversal ledger entry (DR Loans Receivable, CR Bad Debt Expense)
      await ledger.recordLoanWriteOffReversal({
        transaction: txn._id,
        transactionRef: txnRef,
        amountInPaise: amountToRestore,
        customer: loan.customer._id,
        performedBy: reopenedBy,
        businessDate: systemDate,
        session,
      });
    }

    // MED-6 FIX: Re-read loan state inside session for authoritative values.
    // The outer `loan` is a stale pre-session snapshot. Although closed/written-off
    // loans are unlikely to receive concurrent modifications, defense-in-depth
    // demands session-locked reads for any value used in a financial update.
    const freshLoanForReopen = await LoanAccount.findById(loanId)
      .select("principalAmountInPaise penaltyAmountInPaise totalPaidInPaise")
      .session(session)
      .lean();

    if (!freshLoanForReopen) {
      throw new ApiError(404, "Loan not found during reopen. Retry.");
    }

    // Guard against negative balance on any non-write-off reopen.
    const restoredBalance = Math.max(
      0,
      freshLoanForReopen.principalAmountInPaise +
      freshLoanForReopen.penaltyAmountInPaise -
      freshLoanForReopen.totalPaidInPaise,
    );

    // ── Step 5: Restore loan status and clear closure metadata ───────────────
    await LoanAccount.findOneAndUpdate(
      {
        _id: loanId,
        // Optimistic lock: only update if still in a closeable state
        // (prevents race condition if two admins reopen simultaneously)
        status: { $in: reopenableStatuses },
        isDeleted: false,
      },
      {
        $set: {
          status: restoredStatus,
          outstandingBalanceInPaise: restoredBalance,
          // Clear all closure metadata
          closedAt: null,
          closedBy: null,
          closeNote: null,
          writtenOffAt: null,
          writtenOffBy: null,
          writeOffReason: null,
        },
      },
      { returnDocument: "after", session },
    ).then((updated) => {
      if (!updated) {
        throw new ApiError(
          409,
          "Loan status changed by another session during reactivation. Retry.",
        );
      }
    });

    // ── Step 6: Re-attach pigmy account to the loan if it is free ────────────
    // After closure, PigmyAccount.activeLoan was unset.
    // We safely re-link it only if it is currently NOT linked to another loan.
    await PigmyAccount.findOneAndUpdate(
      {
        _id: loan.pigmyAccount,
        // Only re-link if no other loan is currently claiming this account
        $or: [
          { activeLoan: { $exists: false } },
          { activeLoan: null },
        ],
        status: ACCOUNT_STATUS.ACTIVE,
      },
      { $set: { activeLoan: loanId } },
      { session },
    );
    // Note: if the pigmy account is already linked to another loan or is closed,
    // we silently skip re-linking (the loan still works, admin manually manages it).
  });

  // ── Steps 7-9: Post-transaction (non-atomic, fire-and-forget safe) ─────────

  // SMS notification to customer
  await smsService
    .sendLoanReactivated(
      loan.customer.phone,
      loan.customer.name,
      loan.loanAccountNumber,
      restoredStatus,
    )
    .catch((e) =>
      logger.error(
        `[Loan] Reactivation SMS failed: ${e.message} | Loan: ${loan.loanAccountNumber}`,
      ),
    );

  await AuditLog.log({
    performedBy: reopenedBy,
    action: AUDIT_ACTIONS.LOAN_REACTIVATED,
    entity: "LoanAccount",
    entityId: loanId,
    oldData: {
      status: loan.status,
      wasWrittenOff,
      previousCloseNote: loan.closeNote,
      previousWriteOffReason: loan.writeOffReason,
    },
    newData: {
      status: restoredStatus,
      reactivationReason,
      writeOffReversalTxnRef: txnRef,
      pigmyAccountId: loan.pigmyAccount,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Loan] Reactivation AuditLog failed: ${e.message}`));

  logger.info(
    `[Loan] REACTIVATED | ${loan.loanAccountNumber} | ` +
    `Was: ${loan.status} → Now: ${restoredStatus} | ` +
    `WriteOffReversal: ${wasWrittenOff ? txnRef : 'N/A'} | ` +
    `By: ${reopenedBy}`,
  );

  return {
    loanAccountNumber: loan.loanAccountNumber,
    previousStatus: loan.status,
    restoredStatus,
    wasWrittenOff,
    writeOffReversalTxnRef: txnRef,
    rateApplied: restoredStatus === LOAN_STATUS.OVERDUE ? 'PENALTY_RATE' : 'NORMAL_RATE',
    message:
      restoredStatus === LOAN_STATUS.OVERDUE
        ? `Loan ${loan.loanAccountNumber} reactivated as OVERDUE (past maturity — penalty interest rate applies).`
        : `Loan ${loan.loanAccountNumber} reactivated as ACTIVE (within tenure — normal interest rate applies).`,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 13. GET LOAN STATEMENT — Paginated repayment transaction history
//     Queries all Transaction records where fromLoanAccount OR toLoanAccount
//     matches this loan ID. Sorted newest-first. Supports date range filter.
//     Response shape: { transactions, pagination } — same as Saving/Pigmy
// ═════════════════════════════════════════════════════════════════════════════
const getLoanStatement = async ({ loanId, page = 1, limit = 15, fromDate, toDate }) => {
  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(100, parseInt(limit) || 15);
  const skip = (safePage - 1) * safeLimit;

  // ── Date range filter ───────────────────────────────────────────────────────────────
  const dateFilter = {};
  if (fromDate) {
    dateFilter.$gte = new Date(fromDate);
  }
  if (toDate) {
    dateFilter.$lte = endOfDay(new Date(toDate));
  }

  // ── Match any transaction IN or OUT of this loan account ────────────────
  const matchQuery = {
    isDeleted: { $ne: true },
    $or: [
      { fromLoanAccount: loanId },
      { toLoanAccount: loanId },
    ],
    ...(Object.keys(dateFilter).length > 0 ? { businessDate: dateFilter } : {}),
  };

  const [transactions, total] = await Promise.all([
    Transaction.find(matchQuery)
      .sort({ businessDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate('performedBy', 'name role')
      .lean(),
    Transaction.countDocuments(matchQuery),
  ]);

  return {
    transactions,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// GET DEFICIT DASHBOARD
// Returns all active/overdue loans where customer is behind on cumulative
// pigmy collection (consecutiveDeficitDays > 0 OR isPenaltyEligible = true).
// Enriched with live deficit calculation so the UI shows current values.
// Penalty amount comes from AppConfig (set by superadmin) — not hardcoded.
// ═════════════════════════════════════════════════════════════════════════════
const getDeficitDashboard = async ({ filter = "all" } = {}) => {
  // Fetch ALL active/overdue loans that have a pigmy account linked.
  // Deficit is computed LIVE here — we do NOT pre-filter on consecutiveDeficitDays
  // because the cron job may not have run yet and the field can be 0 even when
  // the customer is genuinely behind on their payments.
  const [allLoans, penaltyAmtPaise, maxWarnings] = await Promise.all([
    LoanAccount.find({
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
      pigmyAccount: { $exists: true, $ne: null },
    })
      .select(
        "_id loanAccountNumber customer pigmyAccount " +
        "totalPaidInPaise businessDaysElapsed consecutiveDeficitDays " +
        "lifelinesRemaining totalWarningsSentCount isPenaltyEligible " +
        "lastDeficitWarningDate status",
      )
      .populate("customer", "name phone customerCode")
      .populate("pigmyAccount", "accountNumber dailyDepositAmountInPaise balanceInPaise activeLoan")
      .sort({ isPenaltyEligible: -1, consecutiveDeficitDays: -1 })
      .lean(),
    AppConfig.getValue(CONFIG_KEYS.PENALTY_AMOUNT_PER_MISSED_DAY),
    AppConfig.getValue(CONFIG_KEYS.WARNING_SMS_BEFORE_PENALTY),
  ]);

  const penaltyPaise = Number(penaltyAmtPaise) || 10000;
  const maxWarn = Number(maxWarnings) || 3;

  // Compute live deficit for every loan then filter to those in deficit
  const enriched = allLoans
    .map((loan) => {
      const pigmy = loan.pigmyAccount;
      const dailyDepositPaise = pigmy?.dailyDepositAmountInPaise || 0;
      const pigmyBalance = pigmy?.balanceInPaise || 0;

      const expectedPaise = (loan.businessDaysElapsed || 0) * dailyDepositPaise;
      const actualPaise = (loan.totalPaidInPaise || 0) + pigmyBalance;
      const deficitPaise = Math.max(0, expectedPaise - actualPaise);
      // Same threshold as the cron: deficit >= 1 daily installment
      const isDeficient = dailyDepositPaise > 0 && deficitPaise >= dailyDepositPaise;

      const percentCollected = expectedPaise > 0
        ? Math.min(100, Math.round((actualPaise / expectedPaise) * 100))
        : 100;

      return {
        loanId: loan._id,
        loanAccountNumber: loan.loanAccountNumber,
        status: loan.status,
        customer: loan.customer,
        pigmyAccountNumber: pigmy?.accountNumber,
        dailyDepositAmountInPaise: dailyDepositPaise,
        dailyDepositInRupees: (dailyDepositPaise / 100).toFixed(0),
        businessDaysElapsed: loan.businessDaysElapsed || 0,
        expectedInPaise: expectedPaise,
        expectedInRupees: (expectedPaise / 100).toFixed(2),
        actualInPaise: actualPaise,
        actualInRupees: (actualPaise / 100).toFixed(2),
        deficitInPaise: deficitPaise,
        deficitInRupees: (deficitPaise / 100).toFixed(2),
        percentCollected,
        isDeficient,
        consecutiveDeficitDays: loan.consecutiveDeficitDays || 0,
        lifelinesRemaining: loan.lifelinesRemaining,
        lifelinesUsed: loan.lifelinesRemaining !== null
          ? maxWarn - loan.lifelinesRemaining
          : 0,
        maxWarnings: maxWarn,
        totalWarningsSentCount: loan.totalWarningsSentCount || 0,
        isPenaltyEligible: loan.isPenaltyEligible || false,
        suggestedPenaltyInPaise: penaltyPaise,
        suggestedPenaltyInRupees: (penaltyPaise / 100).toFixed(0),
        lastDeficitWarningDate: loan.lastDeficitWarningDate,
      };
    })
    // Show loans that are currently in deficit OR have active warning/penalty flags
    .filter((l) => l.isDeficient || l.consecutiveDeficitDays > 0 || l.isPenaltyEligible);

  // Apply optional filter from query param (narrows results further)
  let filtered = enriched;
  if (filter === "penalty_eligible") {
    filtered = enriched.filter((l) => l.isPenaltyEligible);
  } else if (filter === "warning_1") {
    filtered = enriched.filter((l) => l.consecutiveDeficitDays === 1);
  } else if (filter === "warning_2") {
    filtered = enriched.filter((l) => l.consecutiveDeficitDays === 2);
  }

  return {
    data: filtered,
    summary: {
      total: filtered.length,
      penaltyEligibleCount: filtered.filter((l) => l.isPenaltyEligible).length,
      activeWarningsCount: filtered.filter((l) => !l.isPenaltyEligible && l.consecutiveDeficitDays > 0).length,
      liveDeficitCount: filtered.filter((l) => l.isDeficient).length,
      maxWarnings: maxWarn,
      configuredPenaltyInRupees: (penaltyPaise / 100).toFixed(0),
    },
  };
};


// ═════════════════════════════════════════════════════════════════════════════
// RESET LIFELINES
// Admin tool to manually adjust a customer's lifeline count.
// resetType:
//   'full'      → restore to max (AppConfig.WARNING_SMS_BEFORE_PENALTY)
//   'increment' → +1, capped at max
//   'decrement' → -1, floored at 0
//   'set'       → exact value (0..max), admin specifies via body.value
// After reset: if lifelinesRemaining > 0, clears isPenaltyEligible.
// ═════════════════════════════════════════════════════════════════════════════
const resetLifelines = async ({
  loanId,
  resetType,
  value,
  reason,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const loan = await LoanAccount.findOne({
    _id: loanId,
    isDeleted: false,
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
  }).populate("customer", "name phone");

  if (!loan) throw ApiError.notFound("Active/overdue loan not found.");

  const maxWarnings = Number(
    await AppConfig.getValue(CONFIG_KEYS.WARNING_SMS_BEFORE_PENALTY),
  ) || 3;

  const currentLifelines = loan.lifelinesRemaining ?? maxWarnings;

  let newLifelines;
  switch (resetType) {
    case "full":
      newLifelines = maxWarnings;
      break;
    case "increment":
      newLifelines = Math.min(currentLifelines + 1, maxWarnings);
      break;
    case "decrement":
      newLifelines = Math.max(currentLifelines - 1, 0);
      break;
    case "set":
      if (value === undefined || value < 0 || value > maxWarnings)
        throw ApiError.badRequest(`value must be between 0 and ${maxWarnings}.`);
      newLifelines = value;
      break;
    default:
      throw ApiError.badRequest(`Unknown resetType: ${resetType}`);
  }

  const updateFields = {
    lifelinesRemaining: newLifelines,
  };

  // Clear penalty eligibility if lifelines are restored above 0
  if (newLifelines > 0) {
    updateFields.isPenaltyEligible = false;
  }

  // MED-7 FIX: Use findOneAndUpdate with status guard to prevent stale overwrites
  // if two admins simultaneously reset lifelines on the same loan.
  const updatedLoan = await LoanAccount.findOneAndUpdate(
    {
      _id: loanId,
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
    },
    { $set: updateFields },
    { returnDocument: "after" },
  );

  if (!updatedLoan) {
    throw ApiError.badRequest(
      "Lifeline reset failed — loan status may have changed concurrently. Refresh and retry.",
    );
  }

  // AuditLog
  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.LIFELINES_RESET,
    entity: "LoanAccount",
    entityId: loanId,
    oldData: { lifelinesRemaining: currentLifelines, isPenaltyEligible: loan.isPenaltyEligible },
    newData: { lifelinesRemaining: newLifelines, isPenaltyEligible: newLifelines === 0, resetType, reason },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Loan] AuditLog failed: ${e.message}`));

  // SMS — non-blocking
  if (loan.customer?.phone) {
    smsService
      .sendLifelineAdminAdjusted(
        loan.customer.phone,
        loan.customer.name,
        loan.loanAccountNumber,
        String(newLifelines),
      )
      .catch((e) => logger.warn(`[Loan] SMS failed: ${e.message}`));
  }

  logger.info(
    `[Loan] Lifelines reset | ${loan.loanAccountNumber} | ` +
    `${resetType} | ${currentLifelines} → ${newLifelines} | By: ${performedBy}`,
  );

  return {
    message: `Lifelines updated to ${newLifelines} via "${resetType}" reset.`,
    loanAccountNumber: loan.loanAccountNumber,
    previousLifelines: currentLifelines,
    newLifelines,
    isPenaltyEligible: newLifelines === 0,
    maxWarnings,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS — all 13 functions
// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  getLoanPreview,
  createLoan,
  applyPigmyToLoan,
  applyPenalty,
  closeLoan,
  reopenLoan,
  listLoans,
  getLoan,
  getLoansByCustomer,
  getLoanRepaymentDashboard,
  sendLoanReminder,
  getLoanStatement,
  getDeficitDashboard,
  resetLifelines,
};
