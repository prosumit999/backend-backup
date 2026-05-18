// src/utils/dayGuard.js
// ─────────────────────────────────────────────────────────────────────────────
//
// BEFORE: Four services each had their own getBusinessDate() with slightly
// different behaviors (some missed isDayOpen, some used setHours instead of
// startOfDay, some ran sequential DB calls instead of parallel).
//
// AFTER: Single source of truth. All services import { getBusinessDate }
// from this module. Guarantees consistent behavior:
//    isDayOpen check          — blocks writes when day is closed
//    startOfDay normalization — IST-aware, no UTC midnight bugs
//    Promise.all              — parallel DB reads for minimal latency
//
// USAGE:
//   const { getBusinessDate } = require("../utils/dayGuard");
//   const effectiveDate = await getBusinessDate();
//
// For read-only operations that need the date but don't require isOpen guard:
//   const { getBusinessDateUnsafe } = require("../utils/dayGuard");
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const AppConfig = require("../models/AppConfig.model");
const ApiError = require("./ApiError");
const { startOfDay } = require("./dateHelpers");

/**
 * Full guard for financial write operations.
 * 1. Checks that the business day is open (throws 503 if closed).
 * 2. Returns the current business date normalized to IST start-of-day.
 * 3. Uses Promise.all for parallel DB reads (isDayOpen + businessDate).
 *
 * @returns {Promise<Date>} IST start-of-day business date
 * @throws {ApiError} 503 if day is closed or business date is not configured
 */
const getBusinessDate = async () => {
  const [isDayOpen, rawDate] = await Promise.all([
    AppConfig.isDayOpen(),
    AppConfig.getCurrentBusinessDate(),
  ]);

  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. " +
      "Complete the day-open procedure before processing financial transactions.",
    );
  }

  if (!rawDate) {
    throw new ApiError(
      503,
      "Current business date is not configured in AppConfig. " +
      "Superadmin must run the day-open procedure first.",
    );
  }

  return startOfDay(new Date(rawDate));
};

/**
 * Lightweight read for non-financial operations that need the business date
 * but don't require the day to be open (e.g., reporting, dashboard queries).
 *
 * @returns {Promise<Date>} IST start-of-day business date
 * @throws {ApiError} 500 if business date is not configured
 */
const getBusinessDateUnsafe = async () => {
  const rawDate = await AppConfig.getCurrentBusinessDate();

  if (!rawDate) {
    throw new ApiError(
      500,
      "Business date is not configured in AppConfig. " +
      "Superadmin must run the day-open procedure.",
    );
  }

  return startOfDay(new Date(rawDate));
};

/**
 * Legacy alias — kept for backward compatibility with existing callers.
 * Functionally identical to getBusinessDate().
 *
 * @deprecated Use getBusinessDate() directly.
 */
const assertDayOpen = async () => {
  return getBusinessDate();
};

module.exports = { getBusinessDate, getBusinessDateUnsafe, assertDayOpen };
