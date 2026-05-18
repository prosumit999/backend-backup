// src/models/Institution.model.js
// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTION MASTER — Single Source of Truth
// ─────────────────────────────────────────────────────────────────────────────
// Industry Standard Reference: Finacle BranchParameter, T24 COMPANY table.
//
// DESIGN DECISIONS:
//   1. Singleton document — one institution per deployment, enforced via a
//      unique index on the `singleton` field (value always "MASTER").
//      getInstance() always upserts on first call, never throws "not found".
//
//   2. systemGenesisDate is the canonical source of truth for the software's
//      installation date. dayClose.service.js reads from here — NOT AppConfig.
//      AppConfig.SYSTEM_GENESIS_DATE is deprecated and no longer written.
//
//   3. Logo is stored as { url, publicId } Cloudinary sub-document.
//      The `logoUrl` virtual provides backward-compatible string access for
//      public branding API and PDF reports.
//
//   4. smsFooter is the brand name appended to every DLT-registered SMS
//      template. TRAI compliance requires it to be a static registered entity
//      name. Defaults to the institution name.
//
//   5. Large text fields (privacyPolicy, microfinanceRules, termsAndConditions)
//      are stored as plain text/markdown. Service layer validates max 100KB.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────
const AddressSchema = new mongoose.Schema(
  {
    line1:    { type: String, trim: true, default: "" },
    line2:    { type: String, trim: true, default: "" },
    city:     { type: String, trim: true, default: "" },
    district: { type: String, trim: true, default: "" },
    state:    { type: String, trim: true, default: "" },
    pincode: {
      type: String,
      trim: true,
      match: [/^$|^\d{6}$/, "Pincode must be 6 digits"],
      default: "",
    },
  },
  { _id: false },
);

// Cloudinary asset sub-document — mirrors Customer.model.js pattern.
// Stored as { url, publicId } so old assets can be deleted on replace.
const CloudinaryAssetSchema = new mongoose.Schema(
  {
    url:      { type: String, default: null },
    publicId: { type: String, default: null },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const InstitutionSchema = new mongoose.Schema(
  {
    // ── Singleton enforcer ───────────────────────────────────────────────────
    singleton: {
      type: String,
      default: "MASTER",
      immutable: true,
      enum: {
        values: ["MASTER"],
        message: "Institution is a singleton — singleton field must be MASTER",
      },
    },

    // ── Identification ───────────────────────────────────────────────────────
    name: {
      type: String,
      trim: true,
      maxlength: [150, "Institution name cannot exceed 150 characters"],
      default: "ABHISHEK FINANCE",
    },
    shortName: {
      type: String,
      trim: true,
      maxlength: [60, "Short name cannot exceed 60 characters"],
      default: "ABHISHEK FINANCE",
    },
    // Registration number: RBI NBFC licence, MCA CIN, or state registration no.
    registrationNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [50, "Registration number cannot exceed 50 characters"],
      default: "",
    },
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      match: [
        /^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        "Enter a valid 15-character GST number",
      ],
      default: "",
    },

    // ── Branding ─────────────────────────────────────────────────────────────
    // Logo stored as Cloudinary sub-document { url, publicId }.
    // Use the `logoUrl` virtual for read access (backward-compatible string).
    logo: {
      type: CloudinaryAssetSchema,
      default: () => ({ url: null, publicId: null }),
    },
    // primaryColor: hex color string for UI theming
    primaryColor: {
      type: String,
      trim: true,
      match: [/^$|^#([0-9a-fA-F]{6})$/, "Primary color must be a valid hex code (e.g. #1a56db)"],
      default: "#1e3a5f",
    },
    tagline: {
      type: String,
      trim: true,
      maxlength: [200, "Tagline cannot exceed 200 characters"],
      default: "",
    },
    receiptTagline: {
      type: String,
      trim: true,
      maxlength: [200, "Receipt tagline cannot exceed 200 characters"],
      default: "Thank you for banking with us.",
    },

    // ── SMS DLT Footer ───────────────────────────────────────────────────────
    // TRAI/DLT compliance: every SMS template must carry the registered
    // entity/brand name as STATIC TEXT. This field stores that name.
    // Defaults to the institution shortName. Used by sms.service.js only.
    smsFooter: {
      type: String,
      trim: true,
      maxlength: [60, "SMS footer cannot exceed 60 characters"],
      default: "ABHISHEK FINANCE",
    },

    // ── Contact ──────────────────────────────────────────────────────────────
    address: {
      type: AddressSchema,
      default: () => ({}),
    },
    phone: {
      type: String,
      trim: true,
      match: [
        /^$|^[6-9]\d{9}$/,
        "Enter a valid 10-digit Indian mobile number",
      ],
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"],
      default: "",
    },
    website: {
      type: String,
      trim: true,
      maxlength: [200, "Website URL cannot exceed 200 characters"],
      default: "",
    },

    // ── System Genesis Date ──────────────────────────────────────────────────
    // The calendar date the software was first installed and the first
    // business day was opened. This is the HARD LOWER BOUND for all backdating.
    // SOURCE OF TRUTH: This field. AppConfig.SYSTEM_GENESIS_DATE is deprecated.
    systemGenesisDate: {
      type: Date,
      default: null,
    },
    genesisUpdatedAt: {
      type: Date,
      default: null,
    },
    genesisUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Legal Documents ──────────────────────────────────────────────────────
    // Stored as plain text / Markdown. Rendered in the client app.
    privacyPolicy: {
      type: String,
      default: "",
    },
    microfinanceRules: {
      type: String,
      default: "",
    },
    termsAndConditions: {
      type: String,
      default: "",
    },
    privacyUpdatedAt:    { type: Date, default: null },
    rulesUpdatedAt:      { type: Date, default: null },
    termsUpdatedAt:      { type: Date, default: null },

    // ── Metadata ─────────────────────────────────────────────────────────────
    configuredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // True once the institution has been meaningfully configured
    // (name + genesisDate set for the first time by the dev user).
    isConfigured: {
      type: Boolean,
      default: false,
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
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
// unique: true on singleton enforces the singleton constraint at the DB level.
InstitutionSchema.index({ singleton: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: logoUrl
// Backward-compatible string accessor — system branding API + PDF reports.
// Returns the Cloudinary secure URL from the logo sub-document.
// ─────────────────────────────────────────────────────────────────────────────
InstitutionSchema.virtual("logoUrl").get(function () {
  return this.logo?.url || null;
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: getInstance
// Always returns the single Institution document. On first call (fresh DB),
// creates it with all defaults. Safe to call multiple times — idempotent.
// Uses findOneAndUpdate with $setOnInsert to avoid race conditions.
// ─────────────────────────────────────────────────────────────────────────────
InstitutionSchema.statics.getInstance = async function () {
  const doc = await this.findOneAndUpdate(
    { singleton: "MASTER" },
    { $setOnInsert: { singleton: "MASTER" } },
    { upsert: true, returnDocument: "after", new: true },
  );
  return doc;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: updateConfig
// Safe partial update with $set. Returns the updated document.
// Tracks metadata: configuredBy (first time), lastUpdatedBy, timestamp guards.
// Caller is responsible for audit logging.
// ─────────────────────────────────────────────────────────────────────────────
InstitutionSchema.statics.updateConfig = async function (updates, updatedBy) {
  const safeUpdate = { ...updates, lastUpdatedBy: updatedBy };

  // Mark as configured when name or genesisDate are first set
  if (updates.name || updates.systemGenesisDate) {
    safeUpdate.isConfigured = true;
    safeUpdate.configuredBy = updatedBy;
  }

  // Track genesis date change separately for audit trail
  if (updates.systemGenesisDate !== undefined) {
    safeUpdate.genesisUpdatedAt = new Date();
    safeUpdate.genesisUpdatedBy = updatedBy;
  }

  // Track legal doc update timestamps independently
  if (updates.privacyPolicy !== undefined) safeUpdate.privacyUpdatedAt = new Date();
  if (updates.microfinanceRules !== undefined) safeUpdate.rulesUpdatedAt = new Date();
  if (updates.termsAndConditions !== undefined) safeUpdate.termsUpdatedAt = new Date();

  return this.findOneAndUpdate(
    { singleton: "MASTER" },
    { $set: safeUpdate },
    { upsert: true, returnDocument: "after", new: true, runValidators: true },
  );
};

module.exports = mongoose.model("Institution", InstitutionSchema);
