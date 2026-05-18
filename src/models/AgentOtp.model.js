// src/models/AgentOtp.model.js
// Dedicated OTP store for agent phone verification (creation + phone change).
// Two purpose fields:
//   purpose: "creation"       — verifies phone on agent account creation
//   purpose: "phone_change"   — verifies NEW phone before swapping it in
// Auto-expires after 10 minutes via TTL index.
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const agentOtpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true,
    },
    agentUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: ["creation", "phone_change"],
      required: true,
    },
    // OTP is stored as SHA-256 HMAC — never plain text
    otpHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    },
    attempts: { type: Number, default: 0 }, // Max 3 wrong attempts before record deleted
    isUsed: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// TTL index — MongoDB auto-deletes expired OTPs
agentOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Compound index for fast lookup queries
agentOtpSchema.index({ agentUserId: 1, purpose: 1, isUsed: 1 });

// ─────────────────────────────────────────────────────────
// STATIC: generateOtp
// Creates (or replaces) an active OTP for the agent+phone+purpose.
// Returns plain OTP — caller must send via SMS and never persist it.
// ─────────────────────────────────────────────────────────
agentOtpSchema.statics.generateOtp = async function (agentUserId, phone, purpose) {
  const env = require("../config/env");

  const otp = String(crypto.randomInt(100000, 999999));
  const otpHash = crypto
    .createHmac("sha256", env.FIELD_HASH_KEY)
    .update(otp)
    .digest("hex");

  // Upsert: if an unused OTP already exists for this agent+purpose, replace it
  await this.findOneAndUpdate(
    { agentUserId, purpose, isUsed: false },
    {
      $set: {
        phone,
        otpHash,
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    },
    { upsert: true },
  );

  return otp; // Return plain OTP — caller sends it via SMS
};

// ─────────────────────────────────────────────────────────
// STATIC: verifyOtp
// Returns { valid: true } or { valid: false, reason: string }.
// Uses timing-safe comparison to prevent timing attacks.
// ─────────────────────────────────────────────────────────
agentOtpSchema.statics.verifyOtp = async function (
  agentUserId,
  phone,
  purpose,
  plainOtp,
  session = null,
) {
  const env = require("../config/env");

  const record = await this.findOne({
    agentUserId,
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
      { returnDocument: "after", session },
    );
    if (!updated) {
      // Already deleted by concurrent request
      return { valid: false, reason: "OTP concurrently consumed. Request a new OTP." };
    }
    if (updated.attempts >= 3) {
      await updated.deleteOne({ session });
      return { valid: false, reason: "Too many wrong attempts. Request a new OTP." };
    }
    const remaining = 3 - updated.attempts;
    return { valid: false, reason: `Wrong OTP. ${remaining} attempt(s) remaining.` };
  }

  // Mark as used — single-use guarantee
  record.isUsed = true;
  await record.save({ session });

  return { valid: true };
};

module.exports = mongoose.model("AgentOtp", agentOtpSchema);
