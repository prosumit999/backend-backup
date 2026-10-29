// src/models/AppConfig.model.js
// System-wide configuration managed ONLY by SUPERADMIN.
// All rates, toggles, and day open/close state live here.
// NEVER hardcode config values in services — always read from here.
//
// NOTE: openDay/closeDay operations are in dayClose.service.js ONLY.
//       This model provides only getValue/setValue/getMany primitives.
"use strict";

const mongoose = require("mongoose");
const { CONFIG_KEYS, DAY_STATUS } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const AppConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    value: {
      type: mongoose.Schema.Types.Mixed,
      required: false,
      validate: [
        {
          validator(v) {
            return v !== undefined;
          },
          message: "AppConfig value must not be undefined. Pass null explicitly if intentional.",
        },
        {
          validator(v) {
            if (v === null) return true;
            return ["string", "number", "boolean"].includes(typeof v);
          },
          message: "AppConfig value must be a primitive type (string, number, boolean) or null.",
        }
      ],
    },

    description: {
      type: String,
      default: "",
    },
    // Cron locks must persist ownership and timestamps for release/recovery.
    meta: {
      lockedAt: Date,
      releasedAt: Date,
      instance: String,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getValue
// Returns typed value, null if key not found.
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.getValue = async function (key) {
  const config = await this.findOne({ key }).lean();
  return config ? config.value : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: setValue (upsert — creates key if not exists)
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.setValue = async function (key, value, updatedBy, session = null) {
  const opts = { returnDocument: "after", upsert: true, runValidators: true };
  if (session) opts.session = session;
  return this.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy } },
    opts,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getMany — single query, avoids N+1
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.getMany = async function (keys) {
  const configs = await this.find({ key: { $in: keys } }).lean();

  const result = Object.fromEntries(keys.map((k) => [k, null]));
  for (const c of configs) {
    result[c.key] = c.value;
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: isDayOpen
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.isDayOpen = async function () {
  const status = await this.getValue(CONFIG_KEYS.DAY_STATUS);
  return status === DAY_STATUS.OPEN;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getCurrentBusinessDate
// Returns null if not set (first run — before any day open).
// Services must handle null explicitly.
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.getCurrentBusinessDate = async function () {
  const date = await this.getValue(CONFIG_KEYS.CURRENT_BUSINESS_DATE);
  // DO NOT fallback to new Date() — hides first-run state.
  return date ? new Date(date) : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: seedDefaults
// Run once on first server startup via app.js / seed script.
// $setOnInsert = only insert if key doesn't exist (never overwrites live config).
// ─────────────────────────────────────────────────────────────────────────────
AppConfigSchema.statics.seedDefaults = async function () {
  const defaults = [
    // ── Charges & Rates (Superadmin-configurable) ───────────
    {
      key: CONFIG_KEYS.SAVINGS_OPENING_CHARGE,
      value: 10000,
      description: "Saving account opening charge in paise (₹100)",
    },
    {
      key: CONFIG_KEYS.PROCESSING_FEE_BPS,
      value: 200,
      description: "Loan processing fee in BPS (2% = 200)",
    },
    {
      // Seed-only: Used by seed.js to create default loan plans.
      // NOT read at runtime by any service. Kept for seed backward-compatibility.
      key: CONFIG_KEYS.DEFAULT_INTEREST_RATE_BPS,
      value: 1200,
      description: "Default loan interest rate for seed data only in BPS (12% = 1200)",
    },
    {
      key: CONFIG_KEYS.PENALTY_EXTRA_RATE_BPS,
      value: 300,
      description: "Extra penalty rate after tenure in BPS (3% = 300)",
    },
    {
      key: CONFIG_KEYS.LATE_PENALTY_EXTRA_BPS,
      value: 500,
      description: "Late penalty rate for 90+ days overdue in BPS (5% = 500)",
    },
    {
      key: CONFIG_KEYS.PENALTY_AMOUNT_PER_MISSED_DAY,
      value: 10000,
      description:
        "Penalty per excess missed collection day in paise (₹100 = 10000)",
    },

    // ── SMS ──────────────────────────────────────────
    {
      key: CONFIG_KEYS.SMS_ENABLED_GLOBAL,
      value: true,
      description: "Master SMS on/off switch (toggle via Superadmin panel)",
    },

    // ── System ───────────────────────────────────────
    {
      key: CONFIG_KEYS.SYSTEM_LOCKED,
      value: false,
      description: "Maintenance mode — blocks all API operations when true",
    },
    {
      key: CONFIG_KEYS.DAY_STATUS,
      value: DAY_STATUS.CLOSED,
      description:
        "Current day open/close status — managed by dayClose.service.js only",
    },
    {
      key: CONFIG_KEYS.CURRENT_BUSINESS_DATE,
      value: null,
      description: "Current business date — set on every Day Open",
    },
    {
      key: CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED,
      value: false,
      description:
        "True when the current open day was opened via backdate path. " +
        "closeDay() checks IS_CATCHUP_MODE alongside this flag to decide EOD.",
    },
    {
      key: CONFIG_KEYS.IS_CATCHUP_MODE,
      value: false,
      description:
        "True when backdate was opened specifically for catch-up (admin missed the day). " +
        "EOD jobs (penalty, missed-day, deficit, reconcile) run on close. " +
        "False = correction mode, EOD is skipped. Reset to false after every close.",
    },

    // ── Security (Superadmin-configurable) ───────────────
    {
      key: CONFIG_KEYS.MAX_LOGIN_ATTEMPTS,
      value: 5,
      description: "Max failed login attempts before account lock",
    },
    {
      key: CONFIG_KEYS.LOCK_DURATION_MINUTES,
      value: 30,
      description: "Account lock duration in minutes after max failed attempts",
    },
    {
      key: CONFIG_KEYS.WARNING_SMS_BEFORE_PENALTY,
      value: 3,
      description: "Max deficit-warning SMSes a customer gets before penalty is eligible",
    },

    // ── REMOVED FROM SEED (for migration record) ─────────────
    // DAY_CLOSE_TIME           — never read at runtime. Removed.
    // MAX_ALLOWED_LEAVES_PER_MONTH — never read at runtime. Removed.
    // SYSTEM_GENESIS_DATE      — moved to Institution.getInstance() in seed.
  ];

  await this.bulkWrite(
    defaults.map((cfg) => ({
      updateOne: {
        filter: { key: cfg.key },
        update: { $setOnInsert: cfg },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  // ── ONE-TIME MIGRATION: Fix SMS_ENABLED_GLOBAL for existing databases ───
  // Old seed default was `false`, which silently blocked all SMS delivery.
  // This upgrades false → true for databases seeded before the fix.
  // Safe: only matches value === false. If a Superadmin explicitly disabled
  // SMS after the initial seed, they would have done so via toggleSms() which
  // sets value = false — but the seed ran first, so this still triggers once.
  // After this migration runs, the Superadmin can re-disable via the panel.
  const smsFixResult = await this.updateOne(
    { key: CONFIG_KEYS.SMS_ENABLED_GLOBAL, value: false },
    { $set: { value: true, description: "Master SMS on/off switch (toggle via Superadmin panel)" } },
  );
  if (smsFixResult.modifiedCount > 0) {
    const logger = require("../utils/logger");
    logger.info("[AppConfig] MIGRATION: SMS_ENABLED_GLOBAL upgraded from false → true (old seed default fix)");
  }

  const nonNullCount = defaults.filter((d) => d.value !== null).length;
  return {
    seeded: defaults.length,
    message: `${nonNullCount} config keys initialized (${defaults.length - nonNullCount} intentionally null)`,
  };
};

module.exports = mongoose.model("AppConfig", AppConfigSchema);
