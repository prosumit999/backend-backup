// src/utils/money.js
// All monetary values stored and computed in PAISE (integer)
// ₹100.50 = 10050 paise — no decimals in business logic ever
'use strict';

// ─── Conversion ───────────────────────────────────────────
const toPaise = (rupees) => Math.round(parseFloat(rupees) * 100);
const toRupees = (paise) => (paise / 100).toFixed(2);

// ─── Safe Integer Arithmetic ─────────────────────────────
const addMoney = (a, b) => a + b; // both paise
const subtractMoney = (a, b) => a - b;
// both paise

// ─── Percentage Fee (when rate stored as %) ───────────────
// Use only for display. For BPS calculations use interestCalculator.js
const calculateFeeInPaise = (amountInPaise, percentage) => Math.round(amountInPaise * percentage / 100);

// ─── BPS Fee (primary — matches AppConfig storage) ────────
// 2% stored as 200 bps → 10000 × 200 / 10000 = 200 paise per ₹1 = 2%
const calculateFeeFromBps = (amountInPaise, rateBps) => Math.round((amountInPaise * rateBps) / 10000);

// ─── Paise validation ─────────────────────────────────────
const isValidPaise = (value) => Number.isInteger(value) && value >= 0;

// ─── Format for display ───────────────────────────────────
const formatRupees = (paise) => new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2
}).format(paise / 100);

module.exports = {
    toPaise,
    toRupees,
    addMoney,
    subtractMoney,
    calculateFeeInPaise,
    calculateFeeFromBps,
    isValidPaise,
    formatRupees
};
