// src/middleware/resolveCustomer.js
"use strict";

const Customer = require("../models/Customer.model");
const ApiError = require("../utils/ApiError");

/**
 * resolveCustomer — resolves /:id param to a full Customer document.
 *
 * Accepts BOTH formats from frontend:
 *   - customerCode  → CUST-2026-0001   (used by all frontend UIs)
 *   - MongoDB _id   → 507f1f77bc...    (used by internal service-to-service calls)
 *
 * Sets req.customer — all downstream controllers use this directly.
 */
const resolveCustomer = async (req, res, next) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return next(ApiError.badRequest("Customer ID is required"));

    let customer;

    if (/^CUST-\d{4}-\d{4,}$/i.test(id)) {
      customer = await Customer.findByCode(id.toUpperCase());
    } else if (/^[0-9a-fA-F]{24}$/.test(id)) {
      customer = await Customer.findOne({ _id: id, isDeleted: false });
    } else {
      return next(ApiError.badRequest(`Invalid customer identifier: '${id}'`));
    }

    if (!customer) return next(ApiError.notFound("Customer not found"));

    req.customer = customer;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = resolveCustomer;
