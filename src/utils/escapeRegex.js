// src/utils/escapeRegex.js
"use strict";

/**
 * Escapes special regex characters in a user-provided string.
 * Prevents ReDoS (Regular Expression Denial of Service) attacks
 * where crafted inputs cause catastrophic backtracking in MongoDB $regex.
 *
 * Usage:
 *   const safe = escapeRegex(req.query.search);
 *   filter.name = { $regex: safe, $options: 'i' };
 */
const escapeRegex = (str) => {
  if (typeof str !== "string") return "";

  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports = escapeRegex;
