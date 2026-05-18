// src/models/AgentProfile.model.js
"use strict";

const mongoose = require("mongoose");
const { AGENT_KYC_STATUS, AGENT_STATUS } = require("../config/constants");
const escapeRegex = require("../utils/escapeRegex");

// ─── BANK DETAILS SUB-SCHEMA ──────────────────────────────
const bankDetailsSchema = new mongoose.Schema(
  {
    accountHolderName: { type: String, trim: true },
    bankName: { type: String, trim: true },
    accountNumberEncrypted: { type: String, select: false },
    accountNumberLast4: { type: String, trim: true },
    ifscCode: { type: String, trim: true, uppercase: true },
    branchName: { type: String, trim: true },
    verifiedAt: { type: Date, default: null },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: false },
);

// ─── ADDRESS SUB-SCHEMA ───────────────────────────────────
const addressSchema = new mongoose.Schema(
  {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true, default: "Maharashtra" },
    pincode: {
      type: String,
      trim: true,
      match: [/^\d{6}$/, "Invalid pincode"],
    },
  },
  { _id: false },
);

// ─── DOCUMENT META SUB-SCHEMA ─────────────────────────────
const documentSchema = new mongoose.Schema(
  {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
    resourceType: { type: String, default: "image" },
    uploadedAt: { type: Date, default: null },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: false },
);

// ─── AGENT PROFILE SCHEMA ─────────────────────────────────
const agentProfileSchema = new mongoose.Schema(
  {
    // ── Core Link ─────────────────────────────────────────
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      unique: true,
    },

    agentCode: {
      type: String,
      unique: true,
      trim: true,
    },

    // ── Personal Details ──────────────────────────────────
    fullName: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
    },

    dateOfBirth: { type: Date, required: false, default: null },

    gender: {
      type: String,
      enum: ["male", "female", "other"],
      required: false,
      default: null,
    },

    fatherOrSpouseName: { type: String, trim: true, default: null },

    // ── Contact ───────────────────────────────────────────
    alternatePhone: {
      type: String,
      trim: true,
      match: [/^[6-9]\d{9}$/, "Invalid phone number"],
      default: null,
    },
    personalEmail: { type: String, trim: true, lowercase: true, default: null },

    // ── Address ───────────────────────────────────────────
    currentAddress: { type: addressSchema, default: () => ({}) },
    permanentAddress: { type: addressSchema, default: () => ({}) },
    isSameAddress: { type: Boolean, default: false },

    // ── KYC Documents ─────────────────────────────────────
    documents: {
      aadhaarFront: { type: documentSchema, default: () => ({}) },
      aadhaarBack: { type: documentSchema, default: () => ({}) },
      panCard: { type: documentSchema, default: () => ({}) },
      photo: { type: documentSchema, default: () => ({}) },
      signedAgreement: { type: documentSchema, default: () => ({}) },
    },

    // ── Encrypted KYC Numbers ─────────────────────────────

    aadhaarNumberEncrypted: { type: String, select: false },
    aadhaarLast4: { type: String, trim: true },
    aadhaarSearchHash: { type: String, select: false },

    panNumberEncrypted: { type: String, select: false },
    panLast4: { type: String, trim: true },
    panSearchHash: { type: String, select: false },

    // ── KYC Status ────────────────────────────────────────
    kycStatus: {
      type: String,
      enum: Object.values(AGENT_KYC_STATUS),
      default: AGENT_KYC_STATUS.PENDING,
      index: true,
    },
    kycVerifiedAt: { type: Date, default: null },
    kycVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    kycRejectedAt: { type: Date, default: null },
    kycRejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    kycRejectionNote: { type: String, trim: true, default: null },

    kycSubmittedAt: { type: Date, default: null },

    // ── Field Operations ──────────────────────────────────
    area: { type: String, trim: true, default: null },
    assignedPincodes: [{ type: String, trim: true }],

    // ── Commission Config ─────────────────────────────────
    commissionRateBps: { type: Number, default: 0 },
    commissionType: {
      type: String,
      enum: ["percentage", "fixed", "none"],
      default: "none",
    },

    // ── Bank Details (salary/commission payout) ───────────
    bankDetails: { type: bankDetailsSchema, default: () => ({}) },

    // ── Joining Info ──────────────────────────────────────
    joiningDate: { type: Date, default: Date.now },
    employeeId: { type: String, trim: true, default: null },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(AGENT_STATUS),
      default: AGENT_STATUS.ACTIVE,
      index: true,
    },

    // ── Permissions (admin-controlled) ────────────────────
    // Admin can toggle these flags per agent via the agent update API.
    // Frontend reads these on login to conditionally show/hide features.
    permissions: {
      canAddCustomer: { type: Boolean, default: true },
    },

    // ── Suspension / Termination ──────────────────────────
    suspendedAt: { type: Date, default: null },
    suspendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    suspensionReason: { type: String, trim: true, default: null },

    terminatedAt: { type: Date, default: null },
    terminatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    terminationReason: { type: String, trim: true, default: null },

    // ── Audit ─────────────────────────────────────────────
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── INDEXES ──────────────────────────────────────────────
agentProfileSchema.index({ status: 1, isDeleted: 1 });
agentProfileSchema.index({ area: 1, status: 1 });
agentProfileSchema.index({ kycStatus: 1, isDeleted: 1 });
agentProfileSchema.index({ aadhaarSearchHash: 1 }, { unique: true, sparse: true });
agentProfileSchema.index({ panSearchHash: 1 }, { unique: true, sparse: true });

// ─── PRE-FIND HOOK ────────────────────────────────────────
agentProfileSchema.pre(/^find/, function () {
  if (!this.options._skipDeletedFilter) this.where({ isDeleted: false });
});

// ─── VIRTUALS ─────────────────────────────────────────────
agentProfileSchema.virtual("age").get(function () {
  if (!this.dateOfBirth) return null;
  const diff = Date.now() - new Date(this.dateOfBirth).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
});

agentProfileSchema.virtual("isKycVerified").get(function () {
  return this.kycStatus === AGENT_KYC_STATUS.KYC_VERIFIED;
});

agentProfileSchema.virtual("maskedAadhaar").get(function () {
  return this.aadhaarLast4 ? `XXXX XXXX ${this.aadhaarLast4}` : null;
});

// AGT-S-10: PAN masked virtual
agentProfileSchema.virtual("maskedPan").get(function () {
  return this.panLast4 ? `XXXXXX${this.panLast4}` : null;
});

agentProfileSchema.virtual("commissionRatePercent").get(function () {
  return this.commissionRateBps
    ? parseFloat((this.commissionRateBps / 100).toFixed(2))
    : 0;
});

// ─── INSTANCE METHODS ─────────────────────────────────────
agentProfileSchema.methods.isOperational = function () {
  return (
    this.status === AGENT_STATUS.ACTIVE &&
    this.kycStatus === AGENT_KYC_STATUS.KYC_VERIFIED &&
    !this.isDeleted
  );
};

// ─── STATICS ──────────────────────────────────────────────
agentProfileSchema.statics.findVerifiedByUserId = function (userId) {
  return this.findOne({
    user: userId,
    kycStatus: AGENT_KYC_STATUS.KYC_VERIFIED,
    status: AGENT_STATUS.ACTIVE,
  });
};

agentProfileSchema.statics.findKycPending = function () {
  return this.find({
    kycStatus: {
      $in: [AGENT_KYC_STATUS.PENDING, AGENT_KYC_STATUS.DOCUMENTS_SUBMITTED],
    },
  });
};

agentProfileSchema.statics.findByArea = function (area, activeOnly = true) {
  const filter = {
    area: { $regex: escapeRegex(area), $options: "i" },
  };
  if (activeOnly) {
    filter.status = AGENT_STATUS.ACTIVE;
    filter.kycStatus = AGENT_KYC_STATUS.KYC_VERIFIED;
  }
  return this.find(filter).populate("user", "name phone agentCode isActive");
};

module.exports = mongoose.model("AgentProfile", agentProfileSchema);
