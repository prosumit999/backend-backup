// src/utils/crypto.js
"use strict";

const crypto = require("crypto");
const env = require("../config/env");
const logger = require("./logger");

const GCM_ALGORITHM = "aes-256-gcm";
const GCM_IV_LENGTH = 12;
const CBC_ALGORITHM = "aes-256-cbc";
const CURRENT_VERSION = "v1";

let _cachedKey = null;

const getKey = () => {
  if (_cachedKey) return _cachedKey;

  const secret = env.FIELD_ENCRYPTION_KEY;

  _cachedKey = crypto.createHash("sha256").update(secret).digest();
  return _cachedKey;
};

const encrypt = (plainText) => {
  if (!plainText) return null;

  const key = getKey();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return (
    `${CURRENT_VERSION}:` +
    `${iv.toString("hex")}:` +
    `${authTag.toString("hex")}:` +
    `${encrypted.toString("hex")}`
  );
};

const decrypt = (encryptedText) => {
  if (!encryptedText) return null;

  try {
    if (encryptedText.startsWith("v1:")) {
      return _decryptGCM(encryptedText);
    }

    logger.warn(
      "[crypto] Decrypting legacy CBC record. " +
        "Re-save this record to migrate it to AES-256-GCM format.",
    );
    return _decryptCBC(encryptedText);
  } catch (err) {
    logger.error("[crypto] DECRYPTION_FAILED", {
      error: err.message,
      hint:
        "Possible causes: " +
        "(1) FIELD_ENCRYPTION_KEY changed without data migration, " +
        "(2) DB record tampered/corrupted (GCM auth tag mismatch), " +
        "(3) Ciphertext stored with encoding error. " +
        "Do NOT ignore this — contact superadmin immediately.",
    });
    return null;
  }
};

const _decryptGCM = (encryptedText) => {
  const parts = encryptedText.split(":");
  if (parts.length !== 4) {
    throw new Error(
      `Invalid GCM format — expected 4 colon-separated parts, got ${parts.length}`,
    );
  }

  const [, ivHex, authTagHex, cipherHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const cipherBuf = Buffer.from(cipherHex, "hex");

  const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString(
    "utf8",
  );
};

const _decryptCBC = (encryptedText) => {
  const parts = encryptedText.split(":");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid CBC format — expected 2 colon-separated parts, got ${parts.length}`,
    );
  }

  const [ivHex, cipherHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const cipherBuf = Buffer.from(cipherHex, "hex");

  const decipher = crypto.createDecipheriv(CBC_ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString(
    "utf8",
  );
};

// ─── HMAC-SHA256 for searchable fields ───────────────────────────────────────
const hashForSearch = (value) => {
  if (!value) return null;

  const hashKey = env.FIELD_HASH_KEY;

  return crypto
    .createHmac("sha256", hashKey)
    .update(String(value))
    .digest("hex");
};

// ─── SHA-256 one-way hash for refresh tokens ──────────────────────────────────
const hashToken = (token) => {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
};

// ─── Display masks (DPDPA 2023 compliance) ────────────────────────────────────
const maskAadhar = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/[\s-]/g, "");
  if (digits.length !== 12) return null;
  return `XXXX-XXXX-${digits.slice(-4)}`;
};

const maskPhone = (phone) => {
  if (!phone || String(phone).length !== 10) return "**********";
  return String(phone).replace(/(\d{2})\d{6}(\d{2})/, "$1******$2");
};

module.exports = {
  encrypt,
  decrypt,
  hashForSearch,
  hashToken,
  maskAadhar,
  maskPhone,
};
