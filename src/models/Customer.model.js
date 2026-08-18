// src/models/Customer.model.js
"use strict";

const mongoose = require("mongoose");
const {
  encrypt,
  decrypt,
  hashForSearch,
  maskAadhar,
} = require("../utils/crypto");
const { generateCustomerCode } = require("../utils/generateCode");

const { KYC_STATUS } = require("../config/constants");

const escapeRegex = (str) =>
  String(str)
    .trim()
    .slice(0, 100)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─────────────────────────────────────────────────────────────────────────────
// CLOUDINARY FILE SUB-SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const cloudinaryFileSchema = new mongoose.Schema(
  {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const customerSchema = new mongoose.Schema(
  {
    customerCode: {
      type: String,
      trim: true,
    },

    // ── Personal Info ──────────────────────────────────
    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      minlength: 2,
      maxlength: 150,
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
      unique: true,
      trim: true,
      match: [/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number"],
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Enter a valid email address"],
    },
    alternatePhone: {
      type: String,
      trim: true,
      match: [/^[6-9]\d{9}$/, "Enter a valid alternate mobile number"],
    },
    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
    },
    city: { type: String, trim: true },
    pincode: {
      type: String,
      trim: true,
      match: [/^\d{6}$/, "Enter valid 6-digit pincode"],
    },

    // ── Aadhaar (encrypted at rest) ────────────────────
    aadharEncrypted: { type: String, select: false },
    aadharMasked: { type: String },
    aadharSearchHash: { type: String, select: false },

    // ── PAN (encrypted at rest) ────────────────────────
    panEncrypted: { type: String, select: false },
    panMasked: { type: String },
    panSearchHash: { type: String, select: false },

    // ── KYC Status ────────────────────────────────────
    kycStatus: {
      type: String,
      enum: Object.values(KYC_STATUS),
      default: KYC_STATUS.PENDING,
      index: true,
    },

    // ── Phone OTP Verification ─────────────────────────
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },

    // ── KYC Documents (Cloudinary) ─────────────────────
    kycDocuments: {
      aadhaarFront: { type: cloudinaryFileSchema, default: () => ({}) },
      aadhaarBack: { type: cloudinaryFileSchema, default: () => ({}) },
      panCard: { type: cloudinaryFileSchema, default: () => ({}) },
      photo: { type: cloudinaryFileSchema, default: () => ({}) },
      signature: { type: cloudinaryFileSchema, default: () => ({}) },
    },

    // ── KYC Admin Actions ─────────────────────────────
    kycVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    kycVerifiedAt: { type: Date, default: null },
    kycRejectedReason: { type: String, trim: true, default: null },
    kycSubmittedAt: { type: Date, default: null },

    // ── Nominee ───────────────────────────────────────
    nomineeName: { type: String, trim: true },
    nomineeRelation: { type: String, trim: true },

    // ── Agent Assignment ──────────────────────────────
    assignedAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    requiresReassignment: {
      type: Boolean,
      default: false,
    },

    reassignmentReason: {
      type: String,
      enum: ["agent_terminated", "manual"],
      default: null,
    },

    // ── Phone Change Flow (2-step OTP) ────────────────
    // pendingPhone is set when an admin initiates a phone change.
    // It is committed to `phone` only after OTP verification.
    pendingPhone: {
      type: String,
      trim: true,
      match: [/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number"],
      default: null,
    },
    pendingPhoneOtpExpiry: { type: Date, default: null },

    // ── Settings + Soft Delete ────────────────────────
    smsEnabled: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedReason: { type: String, trim: true, default: null },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────
customerSchema.virtual("isKycComplete").get(function () {
  return this.kycStatus === KYC_STATUS.KYC_VERIFIED;
});

customerSchema.virtual("isDocumentsComplete").get(function () {
  const docs = this.kycDocuments;
  return !!(
    docs?.aadhaarFront?.url &&
    docs?.aadhaarBack?.url &&
    docs?.panCard?.url &&
    docs?.photo?.url &&
    docs?.signature?.url
  );
});

customerSchema
  .virtual("aadharRaw")
  .get(function () {
    return this._aadharRaw;
  })
  .set(function (v) {
    this._aadharRaw = v;
  });

customerSchema
  .virtual("panRaw")
  .get(function () {
    return this._panRaw;
  })
  .set(function (v) {
    this._panRaw = v;
  });

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
customerSchema.index({ customerCode: 1 }, { unique: true, sparse: true });
customerSchema.index({ aadharSearchHash: 1 }, { unique: true, sparse: true });
customerSchema.index({ panSearchHash: 1 }, { unique: true, sparse: true });
customerSchema.index({ assignedAgent: 1, isActive: 1 });
customerSchema.index({ isDeleted: 1, isActive: 1 });
customerSchema.index({ kycStatus: 1, isDeleted: 1 });
customerSchema.index({ createdAt: -1 });
customerSchema.index(
  { requiresReassignment: 1, isDeleted: 1, isActive: 1 },
  { name: "reassignment_queue_scan" },
);

// ─────────────────────────────────────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────────────────────────────────────

// PRE-FIND: exclude soft-deleted
customerSchema.pre(/^find/, function () {
  if (!this.options._skipDeletedFilter) {
    this.where({ isDeleted: false });
  }
});

// PRE-SAVE: auto-generate customerCode + encrypt sensitive fields
customerSchema.pre("save", async function () {
  if (this.isNew && !this.customerCode) {
    this.customerCode = await generateCustomerCode();
  }

  if (this.aadharRaw) {
    const aadhar = String(this.aadharRaw).trim();
    this.aadharEncrypted = encrypt(aadhar);
    this.aadharMasked = maskAadhar(aadhar);
    this.aadharSearchHash = hashForSearch(aadhar);
    this.aadharRaw = undefined; // clear scratchpad — not persisted
  }

  if (this.panRaw) {
    const pan = String(this.panRaw).toUpperCase().trim();
    this.panEncrypted = encrypt(pan);
    this.panMasked = `${pan.slice(0, 5)}XXXX${pan.slice(-1)}`;
    this.panSearchHash = hashForSearch(pan);
    this.panRaw = undefined; // clear scratchpad
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────────────────────────────────────
customerSchema.methods.softDelete = async function (deletedBy, deletedReason) {
  this.isDeleted = true;
  this.isActive = false;
  this.deletedBy = deletedBy;
  this.deletedReason = deletedReason || null;
  this.deletedAt = new Date();
  return this.save({ validateBeforeSave: false });
};

// Restore a soft-deleted customer — requires _skipDeletedFilter on the query
customerSchema.methods.restore = async function (restoredBy) {
  this.isDeleted = false;
  this.isActive = true;
  this.deletedBy = null;
  this.deletedAt = null;
  return this.save({ validateBeforeSave: false });
};

customerSchema.methods.getDecryptedAadhar = function () {
  if (!this.aadharEncrypted) {
    throw new Error(
      "Aadhaar ciphertext not available on this document. " +
        'Load with: Customer.findById(id).select("+aadharEncrypted")',
    );
  }
  return decrypt(this.aadharEncrypted);
};

customerSchema.methods.getDecryptedPan = function () {
  if (!this.panEncrypted) {
    throw new Error(
      "PAN ciphertext not available on this document. " +
        'Load with: Customer.findById(id).select("+panEncrypted")',
    );
  }
  return decrypt(this.panEncrypted);
};

customerSchema.methods.getKycPublicIds = function () {
  const docs = this.kycDocuments || {};
  return [
    docs.aadhaarFront?.publicId,
    docs.aadhaarBack?.publicId,
    docs.panCard?.publicId,
    docs.photo?.publicId,
    docs.signature?.publicId,
  ].filter(Boolean);
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────
customerSchema.statics.findByAadhar = function (rawAadhar) {
  const hash = hashForSearch(String(rawAadhar).trim());
  return this.findOne({ aadharSearchHash: hash }).setOptions({
    _skipDeletedFilter: true,
  });
};

customerSchema.statics.findByPan = function (rawPan) {
  const hash = hashForSearch(String(rawPan).toUpperCase().trim());
  return this.findOne({ panSearchHash: hash }).setOptions({
    _skipDeletedFilter: true,
  });
};

customerSchema.statics.findByPhone = function (phone) {
  return this.findOne({ phone });
};

customerSchema.statics.findByAgent = function (agentId) {
  return this.find({ assignedAgent: agentId });
};

customerSchema.statics.findByCode = function (customerCode) {
  return this.findOne({
    customerCode: String(customerCode).toUpperCase().trim(),
  });
};

customerSchema.statics.search = function (query) {
  const safe = escapeRegex(query);
  return this.find({
    $or: [
      { name: { $regex: safe, $options: "i" } },
      { phone: { $regex: safe } },
      { customerCode: { $regex: safe, $options: "i" } },
    ],
  });
};

module.exports = mongoose.model("Customer", customerSchema);
module.exports.escapeRegex = escapeRegex;
