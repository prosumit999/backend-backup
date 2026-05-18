// src/utils/dateHelpers.js
// ─────────────────────────────────────────────────────────────────────────────
// IST-aware date utilities for the entire application.
//
// GOLDEN RULE: Every date comparison and boundary calculation in this system
// must go through these helpers. NEVER use raw JS date methods (getDate(),
// getMonth(), getFullYear()) directly in services — those use the server's
// local timezone (UTC on cloud servers) and will give wrong results for
// Indian calendar dates.
//
// WHY IST MATTERS FOR THIS SYSTEM:
//   This is an Indian NBFC. All business dates, loan maturity dates, collection
//   windows, day-open/close operations, and penalty calculations are in IST.
//   The server runs on UTC. A collection at 11:00 PM IST is 5:30 PM UTC on
//   the same calendar day — but raw UTC methods would give the wrong date.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const ApiError = require("./ApiError");

// ─────────────────────────────────────────────────────────────────────────────
// IST OFFSET
// India does NOT observe DST — offset is permanently +5:30 (19800000ms).
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Shift a date forward by IST offset (+5:30).
 * The returned Date's UTC fields now represent IST values.
 * Internal helper — do not export.
 */
const _toIST = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS);

/**
 * Shift a date backward by IST offset (−5:30).
 * Converts an IST-shifted Date back to true UTC for MongoDB storage.
 * Internal helper — do not export.
 */
const _fromIST = (istDate) => new Date(istDate.getTime() - IST_OFFSET_MS);

// ─────────────────────────────────────────────────────────────────────────────
// DAY BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns UTC timestamp = start of day (00:00:00.000 IST).
 * Use for ALL date-range queries on MongoDB date fields.
 *
 * Example: startOfDay("2026-03-23")
 *   → 2026-03-22T18:30:00.000Z  (= 2026-03-23 00:00:00.000 IST)
 *
 * @param {Date|string} d
 * @returns {Date}
 */
const startOfDay = (d) => {
  const ist = _toIST(d);
  ist.setUTCHours(0, 0, 0, 0);
  return _fromIST(ist);
};

/**
 * Returns UTC timestamp = end of day (23:59:59.999 IST).
 * Use for upper bound of date-range queries.
 *
 * Example: endOfDay("2026-03-23")
 *   → 2026-03-23T18:29:59.999Z  (= 2026-03-23 23:59:59.999 IST)
 *
 * @param {Date|string} d
 * @returns {Date}
 */
const endOfDay = (d) => {
  const ist = _toIST(d);
  ist.setUTCHours(23, 59, 59, 999);
  return _fromIST(ist);
};

// ─────────────────────────────────────────────────────────────────────────────
// MONTH BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns UTC timestamp = first day of month at 00:00:00.000 IST.
 *
 * @param {Date|string} [d=new Date()]
 * @returns {Date}
 */
const startOfMonth = (d = new Date()) => {
  const ist = _toIST(d);
  ist.setUTCDate(1);
  ist.setUTCHours(0, 0, 0, 0);
  return _fromIST(ist);
};

/**
 * Returns UTC timestamp = last day of month at 23:59:59.999 IST.
 *
 * @param {Date|string} [d=new Date()]
 * @returns {Date}
 */
const endOfMonth = (d = new Date()) => {
  const ist = _toIST(d);
  const nextMonth = new Date(ist);
  nextMonth.setUTCDate(1);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  return _fromIST(new Date(nextMonth.getTime() - 1));
};

/**
 * Returns UTC timestamp = first day of PREVIOUS month at 00:00:00.000 IST.
 *
 * @param {Date|string} [d=new Date()]
 * @returns {Date}
 */
const startOfPrevMonth = (d = new Date()) => {
  const ist = _toIST(d);
  ist.setUTCDate(1);
  ist.setUTCMonth(ist.getUTCMonth() - 1);
  ist.setUTCHours(0, 0, 0, 0);
  return _fromIST(ist);
};

/**
 * Returns UTC timestamp = last day of PREVIOUS month at 23:59:59.999 IST.
 * Derived as: startOfMonth(d) − 1ms (always correct, no edge cases).
 *
 * @param {Date|string} [d=new Date()]
 * @returns {Date}
 */
const endOfPrevMonth = (d = new Date()) =>
  new Date(startOfMonth(d).getTime() - 1);

// ─────────────────────────────────────────────────────────────────────────────
// DAYS BETWEEN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns exact number of calendar days between two dates (IST calendar).
 * Both dates are normalized to IST midnight before subtraction.
 * Result can be negative if `from` is after `to`.
 *
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {number} integer — positive if to > from, negative if to < from
 */
const daysBetween = (from, to) => {
  const start = startOfDay(from).getTime();
  const end = startOfDay(to).getTime();
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
};

/**
 * Add months to a date, clamping to last valid day of the target month.
 *
 * Examples:
 *   addMonths("2026-01-31", 1) → "2026-02-28" (not March 3)
 *   addMonths("2026-01-31", 3) → "2026-04-30" (not May 1)
 *   addMonths("2026-03-15", 6) → "2026-09-15" (no clamping needed)
 *
 * Use this for ALL loan maturity date calculations.
 *
 * @param {Date|string} date
 * @param {number} months — must be a positive integer
 * @returns {Date}
 */
const addMonths = (date, months) => {
  // D-1 FIX: Apply IST shift before reading the day.
  // Example: 2026-04-01 00:00 IST is 2026-03-31 18:30 UTC.
  // Without the shift, getUTCDate() returns 31 instead of 1.
  const ist = _toIST(date);
  const originalDay = ist.getUTCDate();

  ist.setUTCDate(1);
  ist.setUTCMonth(ist.getUTCMonth() + months);

  // Last day of target month (UTC)
  const lastDay = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0),
  ).getUTCDate();

  ist.setUTCDate(Math.min(originalDay, lastDay));
  return _fromIST(ist);
};

/**
 * Format a date as DD/MM/YYYY in IST timezone.
 * Always use this for receipts, collection slips, and any customer-facing date.
 *
 * @param {Date|string} d
 * @returns {string} e.g. "23/03/2026"
 */
const toIndianDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

/**
 * Safely convert a string to a Mongoose ObjectId.
 * Throws ApiError(400) if the string is not a valid 24-character hex ObjectId.
 *
 * Use this in every service that accepts an ID from req.params or req.body
 * before passing it to any Mongoose query.
 *
 * @param {string} id
 * @param {string} [fieldName="id"] — used in the error message for clarity
 * @returns {mongoose.Types.ObjectId}
 * @throws {ApiError} 400 if id is not a valid ObjectId
 */
const toObjId = (id, fieldName = "id") => {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest(
      `Invalid ${fieldName}: "${id}" is not a valid ID format.`,
    );
  }
  return new mongoose.Types.ObjectId(id);
};

/**
 * Returns true if the given date falls on today's IST calendar date.
 * Use ONLY for display purposes — not for financial date comparisons.
 * Financial flows must use AppConfig.getCurrentBusinessDate().
 *
 * @param {Date|string} date
 * @returns {boolean}
 */
const isToday = (date) => {
  const d = _toIST(date);
  const now = _toIST(new Date());
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS DATE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if operationDate is strictly BEFORE the current business date.
 * Used to block backdated financial operations.
 *
 * @param {Date|string} operationDate
 * @param {Date|string} businessDate
 * @returns {boolean}
 */
const isBeforeBusinessDate = (operationDate, businessDate) =>
  startOfDay(operationDate).getTime() < startOfDay(businessDate).getTime();

/**
 * Returns true if operationDate is strictly AFTER the current business date.
 * Used to block future-dated financial operations.
 *
 * @param {Date|string} operationDate
 * @param {Date|string} businessDate
 * @returns {boolean}
 */
const isAfterBusinessDate = (operationDate, businessDate) =>
  startOfDay(operationDate).getTime() > startOfDay(businessDate).getTime();

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  startOfPrevMonth,
  endOfPrevMonth,
  daysBetween,
  addMonths,
  toIndianDate,
  toObjId,
  isToday,
  isBeforeBusinessDate,
  isAfterBusinessDate,
};
