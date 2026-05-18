// src/models/User.model.js
"use strict";

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const env = require("../config/env");
const logger = require("../utils/logger");
const { hashToken } = require("../utils/crypto");
const { ROLES } = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: 2,
      maxlength: 100,
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
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },

    // ── Role ──────────────────────────────────────────────
    role: {
      type: String,
      enum: {
        values: Object.values(ROLES),
        message: "{VALUE} is not a valid role",
      },
      default: ROLES.AGENT,
    },

    // ── Access ────────────────────────────────────────────
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    // ── Agent / Admin / Dev specific ─────────────────────
    agentCode: { type: String, unique: true, sparse: true, trim: true },
    adminCode: { type: String, unique: true, sparse: true, trim: true },
    // devCode: unique identifier for the software vendor/developer account.
    // Format: DEV-XXXX. Used in audit logs to identify vendor-initiated changes.
    devCode: { type: String, unique: true, sparse: true, trim: true },
    smsEnabled: { type: Boolean, default: true },
    ledgerAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LedgerAccount",
      default: null,
    },

    // ── Security ──────────────────────────────────────────
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    passwordChangedAt: { type: Date, select: false },

    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenFamily: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    refreshTokenUpdatedAt: {
      type: Date,
      default: null,
      select: false,
    },

    // ── Audit ─────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Phone Verification (Agent creation OTP) ───────────
    // Tracks whether the agent's phone has been OTP-verified after creation.
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },

    // ── Pending Phone Change (Admin-initiated OTP flow) ───
    // Stores the NEW phone the admin wants to change to — only committed after
    // OTP to the new number is verified. Never overwrites the live phone field
    // until verification is confirmed.
    pendingPhone: { type: String, default: null, select: false },
    pendingPhoneOtpExpiry: { type: Date, default: null, select: false },
  },
  {
    timestamps: true,
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
userSchema.index({ role: 1, isActive: 1, isDeleted: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: hash password + record passwordChangedAt
// ─────────────────────────────────────────────────────────────────────────────
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, env.BCRYPT_ROUNDS);
  this.passwordChangedAt = new Date();
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FIND: exclude soft-deleted documents automatically
// NOTE: This runs on ALL /^find/ queries including findByIdAndUpdate.
//       Pass { _skipDeletedFilter: true } in query options to bypass —
//       required for all token/session operations so deleted users can
//       still have their sessions cleared for security.
// ─────────────────────────────────────────────────────────────────────────────
userSchema.pre(/^find/, function () {
  if (!this.options._skipDeletedFilter) {
    this.where({ isDeleted: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: password comparison
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password);
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: token generation
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    { _id: this._id, role: this.role, phone: this.phone },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
};

userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      jti: uuidv4(),
      fam: this.refreshTokenFamily,
      ver: this.refreshTokenVersion,
    },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: storeRefreshToken
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.storeRefreshToken = async function (token) {
  const hash = hashToken(token);
  await this.constructor.findByIdAndUpdate(
    this._id,
    { $set: { refreshTokenHash: hash } },
    { _skipDeletedFilter: true },
  );
  this.refreshTokenHash = hash; // sync in-memory for same-request reads
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: verifyAndRotateRefreshToken

// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.verifyAndRotateRefreshToken = async function (
  decoded,
  incomingToken,
) {
  const incomingHash = hashToken(incomingToken);

  // ── Step 1: Hash match (reuse / theft detection) ──────────────────────────
  if (this.refreshTokenHash !== incomingHash) {
    const isRecentRotation = this.refreshTokenUpdatedAt && (Date.now() - this.refreshTokenUpdatedAt < 15000);
    if (isRecentRotation) {
      return {
        valid: false,
        reason: "Concurrent refresh detected. Please retry your request.",
        stolen: false,
      };
    }
    await this.constructor.findByIdAndUpdate(
      this._id,
      {
        $set: {
          refreshTokenHash: null,
          refreshTokenFamily: null,
          refreshTokenVersion: 0,
          refreshTokenUpdatedAt: null,
        },
      },
      { _skipDeletedFilter: true },
    );
    return {
      valid: false,
      reason: "Token reuse detected. All sessions invalidated.",
      stolen: true,
    };
  }

  // ── Step 2: Family check (cross-session replay) ───────────────────────────
  if (decoded.fam !== this.refreshTokenFamily) {
    return { valid: false, reason: "Invalid token session.", stolen: false };
  }

  // ── Step 3: Version check (old rotation replayed) ─────────────────────────
  if (decoded.ver !== this.refreshTokenVersion) {
    await this.constructor.findByIdAndUpdate(
      this._id,
      {
        $set: {
          refreshTokenHash: null,
          refreshTokenFamily: null,
          refreshTokenVersion: 0,
          refreshTokenUpdatedAt: null,
        },
      },
      { _skipDeletedFilter: true },
    );
    return {
      valid: false,
      reason: "Token rotation reuse detected. All sessions invalidated.",
      stolen: true,
    };
  }

  // ── Step 4: Rotate — increment version atomically, issue new tokens ────────
  const nextVersion = this.refreshTokenVersion + 1;
  const newAccessToken = this.generateAccessToken();
  const newRefreshToken = jwt.sign(
    {
      _id: this._id,
      jti: uuidv4(),
      fam: this.refreshTokenFamily,
      ver: nextVersion,
    },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
  );

  const newHash = hashToken(newRefreshToken);

  const freshUser = await this.constructor
    .findByIdAndUpdate(
      this._id,
      { 
        $inc: { refreshTokenVersion: 1 },
        $set: { 
          refreshTokenHash: newHash,
          refreshTokenUpdatedAt: new Date(),
        }
      },
      { returnDocument: "after", _skipDeletedFilter: true },
    )
    .select("+refreshTokenHash +refreshTokenFamily +refreshTokenVersion +refreshTokenUpdatedAt");

  return {
    valid: true,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: invalidateAllSessions (logout / forced sign-out)
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.invalidateAllSessions = async function () {
  await this.constructor.findByIdAndUpdate(
    this._id,
    {
      $set: {
        refreshTokenHash: null,
        refreshTokenFamily: null,
        refreshTokenVersion: 0,
        refreshTokenUpdatedAt: null,
      },
    },
    { _skipDeletedFilter: true },
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: startNewSession (called after successful login)
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.startNewSession = async function () {
  const newFam = uuidv4();
  const newAccessToken = this.generateAccessToken();
  const newRefreshToken = jwt.sign(
    {
      _id: this._id,
      jti: uuidv4(),
      fam: newFam,
      ver: 0,
    },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
  );

  const newHash = hashToken(newRefreshToken);

  const freshUser = await this.constructor
    .findByIdAndUpdate(
      this._id,
      {
        $set: {
          refreshTokenHash: newHash,
          refreshTokenFamily: newFam,
          refreshTokenVersion: 0,
          refreshTokenUpdatedAt: new Date(),
        },
      },
      { returnDocument: "after", _skipDeletedFilter: true },
    )
    .select("+refreshTokenHash +refreshTokenFamily +refreshTokenVersion +refreshTokenUpdatedAt");

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: account lock helpers
// ─────────────────────────────────────────────────────────────────────────────
userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};


userSchema.methods.resetLoginAttempts = async function () {
  await this.constructor.findByIdAndUpdate(
    this._id,
    { $set: { loginAttempts: 0, lockUntil: null } },
    { _skipDeletedFilter: true },
  );
  this.loginAttempts = 0;
  this.lockUntil = null;
};

userSchema.methods.incrementLoginAttempts = async function (
  MAX_ATTEMPTS,
  LOCK_MINUTES,
) {
  if (MAX_ATTEMPTS == null || LOCK_MINUTES == null) {
    throw new Error(
      "[User.incrementLoginAttempts] MAX_ATTEMPTS and LOCK_MINUTES are required. " +
        "Read from AppConfig before calling.",
    );
  }

  // Expired lock — reset to 1 (this failed attempt)
  if (this.lockUntil && this.lockUntil < Date.now()) {
    const updated = await this.constructor
      .findByIdAndUpdate(
        this._id,
        { $set: { loginAttempts: 1, lockUntil: null } },
        { returnDocument: "after", _skipDeletedFilter: true },
      )
      .select("+loginAttempts +lockUntil");
    this.loginAttempts = updated.loginAttempts;
    this.lockUntil = updated.lockUntil;
    return updated;
  }

  const updated = await this.constructor
    .findByIdAndUpdate(
      this._id,
      { $inc: { loginAttempts: 1 } },
      { returnDocument: "after", _skipDeletedFilter: true },
    )
    .select("+loginAttempts +lockUntil");

  if (updated.loginAttempts >= MAX_ATTEMPTS && !updated.lockUntil) {
    const lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    const finalUpdate = await this.constructor
      .findByIdAndUpdate(
        this._id,
        { $set: { lockUntil } },
        { returnDocument: "after", _skipDeletedFilter: true },
      )
      .select("+loginAttempts +lockUntil");
    this.loginAttempts = finalUpdate.loginAttempts;
    this.lockUntil = finalUpdate.lockUntil;
    return finalUpdate;
  }

  this.loginAttempts = updated.loginAttempts;
  this.lockUntil = updated.lockUntil;
  return updated;
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE: wasPasswordChangedAfter
userSchema.methods.wasPasswordChangedAfter = function (jwtIssuedAt) {
  if (!this.passwordChangedAt) return false;
  const changedTs = Math.floor(this.passwordChangedAt.getTime() / 1000);
  return changedTs >= jwtIssuedAt;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────
userSchema.statics.findByPhone = function (phone) {
  return this.findOne({ phone }).select("+password +loginAttempts +lockUntil");
};

userSchema.statics.findForTokenRotation = function (userId) {
  return this.findById(userId).select(
    "+refreshTokenHash +refreshTokenFamily +refreshTokenVersion +refreshTokenUpdatedAt " +
      "+loginAttempts +lockUntil",
  );
};

userSchema.statics.findAllAgents = function (filters = {}) {
  return this.find({ role: ROLES.AGENT, ...filters });
};

module.exports = mongoose.model("User", userSchema);
