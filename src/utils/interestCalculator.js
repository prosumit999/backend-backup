// src/utils/interestCalculator.js
// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL CALCULATION ENGINE
//
// Rules (never violate these):
// 1. ALL amounts in PAISE (integers) — zero floating point risk
// 2. ALL rates in BPS  (basis points, integers stored in DB/AppConfig)
//        1 bps = 0.01%  →  12% annual = 1200 bps  →  divide by 10000 in formula
// 3. Always Math.round() — never toFixed() mid-calculation
// 4. verifyBreakdown() MUST pass before any ledger posting
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const ApiError = require("./ApiError");

// ─────────────────────────────────────────────────────────
// 1. UPFRONT FLAT INTEREST
//    Applied ONCE at loan creation — deducted from saving account upfront.
//    Formula: P × R(bps) × T(months) / (12 × 10000)
//
//    Example: ₹10,000 × 1200 bps × 3 months / 120,000
//           = 1,000,000 paise × 1200 × 3 / 120,000
//           = 30,000 paise = ₹300
// ─────────────────────────────────────────────────────────
const calculateFlatInterest = ({
  principalInPaise,
  annualRateBps,
  tenureMonths,
}) => {
  if (!principalInPaise || principalInPaise <= 0)
    throw ApiError.badRequest("Principal must be a positive integer in paise");

  if (!annualRateBps || annualRateBps <= 0)
    throw ApiError.internal(
      "Interest rate is not configured correctly. Contact superadmin.",
    );

  if (!tenureMonths || tenureMonths <= 0)
    throw ApiError.badRequest(
      "Loan tenure must be a positive number of months",
    );

  return Math.round(
    (principalInPaise * annualRateBps * tenureMonths) / (12 * 10000),
  );
};

// ─────────────────────────────────────────────────────────
// 2. DAILY PENALTY INTEREST (after tenure expires)
//    Formula: Outstanding × (baseRate + penaltyExtra)(bps) / (365 × 10000)
//
//    Example: ₹3,000 outstanding, 12% + 3% = 15% total
//           = 300,000 × 1500 / 3,650,000
//           = 123.28 → 123 paise = ₹1.23/day
// ─────────────────────────────────────────────────────────
const calculateDailyPenaltyInterest = ({
  outstandingInPaise,
  baseRateBps,
  penaltyExtraRateBps,
}) => {
  if (!outstandingInPaise || outstandingInPaise <= 0) return 0;

  const totalRateBps = (baseRateBps || 0) + (penaltyExtraRateBps || 0);
  return Math.round((outstandingInPaise * totalRateBps) / (365 * 10000));
};

// ─────────────────────────────────────────────────────────
// 3. PENALTY FOR N OVERDUE DAYS (bulk — cron or manual trigger)
//    Same formula × overdueDays
// ─────────────────────────────────────────────────────────
const calculatePenaltyForDays = ({
  outstandingInPaise,
  baseRateBps,
  penaltyExtraRateBps,
  overdueDays,
}) => {
  if (!outstandingInPaise || outstandingInPaise <= 0) return 0;
  if (!overdueDays || overdueDays <= 0) return 0;

  const totalRateBps = (baseRateBps || 0) + (penaltyExtraRateBps || 0);
  return Math.round(
    (outstandingInPaise * totalRateBps * overdueDays) / (365 * 10000),
  );
};

// ─────────────────────────────────────────────────────────
// 4. PROCESSING FEE
//    Formula: Principal × feeBps / 10000
//
//    Example: ₹10,000 × 200 bps / 10,000 = 20,000 paise = ₹200
// ─────────────────────────────────────────────────────────
const calculateProcessingFee = ({ principalInPaise, feeBps }) => {
  if (!principalInPaise || principalInPaise <= 0)
    throw ApiError.badRequest("Principal must be a positive integer in paise");

  if (!feeBps || feeBps <= 0) return 0;

  return Math.round((principalInPaise * feeBps) / 10000);
};

// ─────────────────────────────────────────────────────────
// 5. FULL LOAN DISBURSEMENT BREAKDOWN
//    Returns every number shown on the loan preview screen.
//    Called BEFORE posting — always call verifyBreakdown() on the result.
// ─────────────────────────────────────────────────────────
const getLoanBreakdown = ({
  principalInPaise,
  annualRateBps,
  tenureMonths,
  processingFeeBps,
  openingChargeInPaise = 0,
}) => {
  const interestInPaise = calculateFlatInterest({
    principalInPaise,
    annualRateBps,
    tenureMonths,
  });
  const processingFeeInPaise = calculateProcessingFee({
    principalInPaise,
    feeBps: processingFeeBps,
  });
  const totalDeductionsInPaise =
    processingFeeInPaise + interestInPaise + openingChargeInPaise;
  const netDisbursalInPaise = principalInPaise - totalDeductionsInPaise;

  if (netDisbursalInPaise <= 0) {
    throw ApiError.badRequest(
      `Total deductions (₹${(totalDeductionsInPaise / 100).toFixed(2)}) ` +
        `exceed principal (₹${(principalInPaise / 100).toFixed(2)}). ` +
        `Increase loan amount or reduce rates.`,
    );
  }

  const breakdown = {
    principalInPaise,
    interestInPaise,
    processingFeeInPaise,
    openingChargeInPaise,
    totalDeductionsInPaise,
    netDisbursalInPaise,
    outstandingBalanceInPaise: principalInPaise,
    annualRateBps,
    tenureMonths,
    preview: {
      principal: `₹${(principalInPaise / 100).toFixed(2)}`,
      interest: `₹${(interestInPaise / 100).toFixed(2)}`,
      processingFee: `₹${(processingFeeInPaise / 100).toFixed(2)}`,
      openingCharge: `₹${(openingChargeInPaise / 100).toFixed(2)}`,
      totalDeductions: `₹${(totalDeductionsInPaise / 100).toFixed(2)}`,
      netToCustomer: `₹${(netDisbursalInPaise / 100).toFixed(2)}`,
      rateDisplay: `${(annualRateBps / 100).toFixed(1)}% p.a. flat`,
      tenure: `${tenureMonths} months`,
    },
  };

  verifyBreakdown(breakdown);
  return breakdown;
};

// ─────────────────────────────────────────────────────────
// 6. BREAKDOWN INTEGRITY CHECK
//    processingFee + interest + openingCharge + netDisbursal === principal
//    MUST be true before any ledger posting.
//    Catches floating-point rounding edge cases on very large principal amounts.
// ─────────────────────────────────────────────────────────
const verifyBreakdown = (breakdown) => {
  const sum =
    breakdown.processingFeeInPaise +
    breakdown.interestInPaise +
    breakdown.openingChargeInPaise +
    breakdown.netDisbursalInPaise;

  if (sum !== breakdown.principalInPaise) {
    throw ApiError.internal(
      `CRITICAL: Loan breakdown integrity check failed! ` +
        `Sum of parts (${sum} paise) ≠ Principal (${breakdown.principalInPaise} paise). ` +
        `Difference: ${sum - breakdown.principalInPaise} paise. ` +
        `DO NOT DISBURSE. Investigate rate configuration immediately.`,
    );
  }
  return true;
};

// ─────────────────────────────────────────────────────────
// 7. SAVING / PIGMY INTEREST (if company offers interest on balances)
//    Formula: Balance × Rate(bps) × Days / (365 × 10000)
// ─────────────────────────────────────────────────────────
const calculateSavingInterest = ({
  balanceInPaise,
  annualRateBps,
  days = 1,
}) => {
  if (!balanceInPaise || balanceInPaise <= 0) return 0;
  if (!annualRateBps || annualRateBps <= 0) return 0;

  return Math.round((balanceInPaise * annualRateBps * days) / (365 * 10000));
};

// ─────────────────────────────────────────────────────────
// 8. ESCALATED PENALTY RATE (90+ days overdue)
//    Returns the correct total penalty rate in BPS based on how many
//    days the loan is overdue.
// ─────────────────────────────────────────────────────────
const getPenaltyRateBps = ({
  daysOverdue,
  baseRateBps,
  penaltyExtraRateBps = 0,
  latePenaltyExtraBps = 0,
}) => {
  if (!baseRateBps || baseRateBps <= 0) {
    throw ApiError.internal(
      "Base interest rate is not configured in AppConfig. " +
        "Cannot calculate penalty. Contact superadmin.",
    );
  }

  const extraBps =
    daysOverdue >= 90 ? latePenaltyExtraBps : penaltyExtraRateBps;
  return baseRateBps + extraBps;
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  calculateFlatInterest,
  calculateDailyPenaltyInterest,
  calculatePenaltyForDays,
  calculateProcessingFee,
  getLoanBreakdown,
  verifyBreakdown,
  calculateSavingInterest,
  getPenaltyRateBps,
};
