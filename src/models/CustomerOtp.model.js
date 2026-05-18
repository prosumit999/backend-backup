// src/models/CustomerOtp.model.js
// Dedicated OTP store for customer phone verification.
// Auto-expires after 10 minutes via TTL index.
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const customerOtpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    // purpose: "creation" | "phone_change"
    // Isolates OTP namespaces — a phone_change OTP cannot satisfy a creation verify and vice-versa.
    purpose: {
      type: String,
      enum: ["creation", "phone_change"],
      default: "creation",
      index: true,
    },
    // OTP is stored as SHA-256 hash — never plain text
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    },
    attempts: { type: Number, default: 0 }, // Max 3 wrong attempts
    isUsed: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// TTL index — MongoDB auto-deletes expired OTPs at expiresAt
customerOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
customerOtpSchema.index({ customerId: 1, purpose: 1, isUsed: 1 });

// ─── STATICS ──────────────────────────────────────────────

// Generate OTP and save — returns plain OTP (to send via SMS)
// purpose defaults to "creation" for backward-compat with existing callers
customerOtpSchema.statics.generateOtp = async function (customerId, phone, purpose = "creation") {
  const env = require("../config/env");

  // Generate cryptographically secure 6-digit OTP
  const otp = String(crypto.randomInt(100000, 999999));
  const otpHash = crypto.createHmac("sha256", env.FIELD_HASH_KEY).update(otp).digest("hex");

  await this.findOneAndUpdate(
    { customerId, phone, purpose, isUsed: false },
    {
      $set: {
        otpHash,
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }
    },
    { upsert: true }
  );

  return otp;
};

// Verify OTP — returns { valid, reason }, handles attempt tracking
// purpose must match to prevent cross-purpose OTP reuse attacks
customerOtpSchema.statics.verifyOtp = async function (
  customerId,
  phone,
  plainOtp,
  session = null,
  purpose = "creation",
) {
  const env = require("../config/env");
  const record = await this.findOne({
    customerId,
    phone,
    purpose,
    isUsed: false,
    expiresAt: { $gt: new Date() },
  }).session(session);

  if (!record) {
    return {
      valid: false,
      reason: "OTP expired or not found. Request a new OTP.",
    };
  }

  if (record.attempts >= 3) {
    await record.deleteOne({ session });
    return {
      valid: false,
      reason: "Too many wrong attempts. Request a new OTP.",
    };
  }

  const inputHash = crypto
    .createHmac("sha256", env.FIELD_HASH_KEY)
    .update(String(plainOtp))
    .digest("hex");

  const inputBuf = Buffer.from(inputHash, "hex");
  const storedBuf = Buffer.from(record.otpHash, "hex");
  const isMatch = crypto.timingSafeEqual(inputBuf, storedBuf);

  if (!isMatch) {
    const updated = await this.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { returnDocument: "after", session }
    );
    if (!updated) {
       return { valid: false, reason: "OTP concurrently verified." };
    }
    if (updated.attempts >= 3) {
      await updated.deleteOne({ session });
      return { valid: false, reason: "Too many wrong attempts. Request a new OTP." };
    }
    const left = 3 - updated.attempts;
    return { valid: false, reason: `Wrong OTP. ${left} attempt(s) remaining.` };
  }

  // Mark as used — can never be reused
  record.isUsed = true;
  await record.save({ session });

  return { valid: true };
};

module.exports = mongoose.model("CustomerOtp", customerOtpSchema);


