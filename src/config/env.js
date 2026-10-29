// src/config/env.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for ALL environment variables.
// Every process.env access in the ENTIRE project must go through this file.
// Never call process.env.ANYTHING directly in services/utils/models.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("./load-env");

const _env = {
  // ── Server ────────────────────────────────────────────────────────────────
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 5000,

  // ── Database ──────────────────────────────────────────────────────────────
  MONGO_URI: process.env.MONGO_URI,

  // ── JWT ───────────────────────────────────────────────────────────────────
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "15m",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || "7d",

  // ── Auth ──────────────────────────────────────────────────────────────────
  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,

  // ── Field Encryption (AES-256-GCM for PII — Aadhaar, PAN) ─────────────────
  FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY,
  FIELD_HASH_KEY: process.env.FIELD_HASH_KEY,

  // ── SMS — MSG91 (primary) ─────────────────────────────────────────────────
  MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
  MSG91_SENDER_ID: process.env.MSG91_SENDER_ID,

  // ── SMS — Fast2SMS (OTP fallback only) ────────────────────────────────────
  FAST2SMS_API_KEY: process.env.FAST2SMS_API_KEY || null,

  // ── SMS — Dev/Test mode ───────────────────────────────────────────────────
  SMS_MOCK_MODE: process.env.SMS_MOCK_MODE === "true",

  // ── Cloudinary (KYC document storage) ────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  CLOUDINARY_BASE_FOLDER: process.env.CLOUDINARY_BASE_FOLDER || "kycdocs",
  // Email delivery and private storage for JSON backup links.
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_SERVICE: process.env.SMTP_SERVICE,
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_FROM: process.env.SMTP_FROM,
  BACKUP_EMAIL_TO: process.env.BACKUP_EMAIL_TO,
  BACKUP_PUBLIC_BASE_URL: process.env.BACKUP_PUBLIC_BASE_URL,
  BACKUP_STORAGE_DIR: process.env.BACKUP_STORAGE_DIR || require("path").resolve(__dirname, "../../backups"),
  BACKUP_LINK_TTL_HOURS: Number(process.env.BACKUP_LINK_TTL_HOURS || 168),
  BACKUP_WEEKLY_ENABLED: process.env.BACKUP_WEEKLY_ENABLED !== "false",
  BACKUP_ON_STARTUP: process.env.BACKUP_ON_STARTUP !== "false",
  BACKUP_STARTUP_DELAY_MS:
    parseInt(process.env.BACKUP_STARTUP_DELAY_MS, 10) || 15000,

  // ── Rate Limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS:
    parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,

  // ── CORS ──────────────────────────────────────────────────────────────────
  // "*" is the dev default — allow all origins in development.
  // Production enforcement is handled in the production safety guards below.
  ALLOWED_ORIGINS: (() => {
    const raw = process.env.ALLOWED_ORIGINS;
    if (!raw || raw.trim() === "*") return "*"; // dev default → allow all
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  })(),
};

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED VARS — App refuses to start if any of these are missing.
// Only add vars here that cause IMMEDIATE data loss or security failure
// if missing. Optional vars (SMS keys, Cloudinary) are handled below.
// ─────────────────────────────────────────────────────────────────────────────
const required = [
  "MONGO_URI",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "FIELD_ENCRYPTION_KEY",
  "FIELD_HASH_KEY",
];

for (const key of required) {
  if (!_env[key]) {
    throw new Error(
      `[ENV] Missing required environment variable: ${key}\n` +
        `      Add it to your .env file and restart the server.\n` +
        `      This variable is required for secure operation of the NBFC system.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MINIMUM SECURITY LENGTH CHECKS
// ─────────────────────────────────────────────────────────────────────────────
if (_env.JWT_SECRET.length < 32)
  throw new Error(
    "[ENV] JWT_SECRET must be at least 32 characters. Use: openssl rand -hex 32",
  );

if (_env.JWT_REFRESH_SECRET.length < 32)
  throw new Error(
    "[ENV] JWT_REFRESH_SECRET must be at least 32 characters. Use: openssl rand -hex 32",
  );

if (_env.FIELD_ENCRYPTION_KEY.length < 32)
  throw new Error(
    "[ENV] FIELD_ENCRYPTION_KEY must be at least 32 characters.\n" +
      "      AES-256-GCM requires a 32-byte key. Use: openssl rand -hex 32",
  );

if (_env.FIELD_HASH_KEY.length < 16)
  throw new Error(
    "[ENV] FIELD_HASH_KEY must be at least 16 characters.\n" +
      "      Used for HMAC-SHA256 Aadhaar/PAN duplicate search. Use: openssl rand -hex 16",
  );

if (!process.env.JWT_REFRESH_EXPIRES_IN) {
  throw new Error(
    "FATAL: JWT_REFRESH_EXPIRES_IN is not set in .env — cookie and JWT TTL will silently diverge.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL FEATURE WARNINGS
// These don't block startup but warn admin in logs if features will be broken.
// ─────────────────────────────────────────────────────────────────────────────
const optionalWarnings = [
  [
    "MSG91_AUTH_KEY",
    "SMS via MSG91 will not work. Set SMS_MOCK_MODE=true for dev.",
  ],
  [
    "MSG91_SENDER_ID",
    "SMS via MSG91 will not work. Set SMS_MOCK_MODE=true for dev.",
  ],
  [
    "CLOUDINARY_CLOUD_NAME",
    "KYC document uploads will fail. Cloudinary is required for production.",
  ],
  [
    "CLOUDINARY_API_KEY",
    "KYC document uploads will fail. Cloudinary is required for production.",
  ],
  [
    "CLOUDINARY_API_SECRET",
    "KYC document uploads will fail. Cloudinary is required for production.",
  ],
];

for (const [key, warning] of optionalWarnings) {
  if (!_env[key]) {
    console.warn(`[ENV] WARNING: ${key} is not set. ${warning}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION SAFETY GUARDS
// ─────────────────────────────────────────────────────────────────────────────
if (_env.NODE_ENV === "production") {
  if (_env.SMS_MOCK_MODE) {
    throw new Error(
      "[ENV] SMS_MOCK_MODE=true is NOT allowed in production. Remove it from .env.",
    );
  }

  if (_env.BCRYPT_ROUNDS < 10) {
    throw new Error(
      "[ENV] BCRYPT_ROUNDS must be >= 10 in production. Recommended: 12.",
    );
  }

  // Development uses "*" as the default (see ALLOWED_ORIGINS parsing above).
  if (_env.ALLOWED_ORIGINS === "*") {
    throw new Error(
      "[ENV] ALLOWED_ORIGINS=* is NOT allowed in production.\n" +
        "      Set a comma-separated list: ALLOWED_ORIGINS=https://app.myfinance.com",
    );
  }

  if (
    !Array.isArray(_env.ALLOWED_ORIGINS) ||
    _env.ALLOWED_ORIGINS.length === 0
  ) {
    throw new Error(
      "[ENV] ALLOWED_ORIGINS must be set in production.\n" +
        "      Example: ALLOWED_ORIGINS=https://app.myfinance.com",
    );
  }
}

if (!Number.isFinite(_env.BACKUP_LINK_TTL_HOURS) || _env.BACKUP_LINK_TTL_HOURS <= 0) {
  throw new Error("BACKUP_LINK_TTL_HOURS must be a positive number.");
}
if (!Number.isInteger(_env.SMTP_PORT) || _env.SMTP_PORT < 1 || _env.SMTP_PORT > 65535) {
  throw new Error("SMTP_PORT must be a valid port number.");
}

module.exports = Object.freeze(_env);
