"use strict";

const fs = require("fs/promises");
const path = require("path");
const { randomBytes, createHmac, timingSafeEqual } = require("crypto");
const nodemailer = require("nodemailer");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");

const Customer = require("../models/Customer.model");
const SavingAccount = require("../models/SavingAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const Collection = require("../models/Collection.model");
const Transaction = require("../models/Transaction.model");
const AgentDeposit = require("../models/AgentDeposit.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const LedgerEntry = require("../models/LedgerEntry.model");
const LoanPlan = require("../models/LoanPlan.model");
const User = require("../models/User.model");
const BusinessDay = require("../models/BusinessDay.model");
const AppConfig = require("../models/AppConfig.model");
const Institution = require("../models/Institution.model");
const AuditLog = require("../models/AuditLog.model");

const BACKUP_COLLECTIONS = [
  { name: "Customers", model: Customer, sort: { createdAt: 1 } },
  { name: "Saving Accounts", model: SavingAccount, sort: { createdAt: 1 } },
  { name: "Pigmy Accounts", model: PigmyAccount, sort: { createdAt: 1 } },
  { name: "Loans", model: LoanAccount, sort: { createdAt: 1 } },
  { name: "Collections", model: Collection, sort: { collectionDate: 1, createdAt: 1 } },
  { name: "Transactions", model: Transaction, sort: { createdAt: 1 } },
  { name: "Agent Deposits", model: AgentDeposit, sort: { createdAt: 1 } },
  { name: "Ledger Accounts", model: LedgerAccount, sort: { createdAt: 1 } },
  { name: "Ledger Entries", model: LedgerEntry, sort: { createdAt: 1 } },
  { name: "Loan Plans", model: LoanPlan, sort: { createdAt: 1 } },
  { name: "Users", model: User, sort: { createdAt: 1 } },
  { name: "Business Days", model: BusinessDay, sort: { businessDate: 1 } },
  { name: "App Config", model: AppConfig, sort: { key: 1 } },
  { name: "Institution", model: Institution, sort: { createdAt: 1 } },
  { name: "Audit Logs", model: AuditLog, sort: { createdAt: 1 } },
];

const SENSITIVE_KEYS = new Set([
  "password",
  "refreshTokenHash",
  "refreshTokenFamily",
  "refreshTokenVersion",
  "refreshTokenUpdatedAt",
  "loginAttempts",
  "lockUntil",
  "passwordChangedAt",
  "pendingPhone",
  "pendingPhoneOtpExpiry",
  "aadharEncrypted",
  "aadharSearchHash",
  "panEncrypted",
  "panSearchHash",
]);

// Preserve nested JSON while excluding the same sensitive fields as the old export.
const sanitize = (value) => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object" || value instanceof Date ||
      Buffer.isBuffer(value) || value._bsontype) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEYS.has(key))
    .map(([key, nested]) => [key, sanitize(nested)]));
};

const backupDirectory = () => path.resolve(env.BACKUP_STORAGE_DIR);
const filePath = (id) => path.join(backupDirectory(), `afs-backup-${id}.json`);
const retentionMs = () => env.BACKUP_LINK_TTL_HOURS * 60 * 60 * 1000;

const cleanupExpiredBackups = async () => {
  await fs.mkdir(backupDirectory(), { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(backupDirectory())) {
    if (!/^afs-backup-[a-f0-9]{48}\.json$/.test(name)) continue;
    const target = path.join(backupDirectory(), name);
    try {
      const stat = await fs.stat(target);
      if (Date.now() - stat.mtimeMs > retentionMs()) await fs.unlink(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
};

// Write one document at a time instead of holding the entire database in memory.
const createJsonBackup = async () => {
  await cleanupExpiredBackups();
  const id = randomBytes(24).toString("hex");
  const target = filePath(id);
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      exportType: "sanitized-data-export",
    }).slice(0, -1) + ',"collections":{');
    let firstCollection = true;
    for (const { model, sort } of BACKUP_COLLECTIONS) {
      await handle.writeFile((firstCollection ? "" : ",") +
        JSON.stringify(model.collection.name) + ":[");
      firstCollection = false;
      const cursor = model.find({}).setOptions({ _skipDeletedFilter: true })
        .sort(sort).lean({ virtuals: false }).cursor();
      try {
        let first = true;
        for await (const row of cursor) {
          await handle.writeFile((first ? "" : ",") + JSON.stringify(sanitize(row)));
          first = false;
        }
      } finally {
        await cursor.close();
      }
      await handle.writeFile("]");
    }
    await handle.writeFile("}}\n");
  } catch (error) {
    await handle.close();
    await fs.unlink(target).catch(() => {});
    throw error;
  }
  await handle.close();
  return { id, fileName: path.basename(target), path: target };
};

const sign = (value) => createHmac("sha256", env.JWT_SECRET)
  .update(`backup-download:${value}`).digest("hex");

const createDownloadToken = (id, expiresAt) => {
  const value = `${id}.${expiresAt}`;
  return `${value}.${sign(value)}`;
};

const resolveDownload = async (token) => {
  if (typeof token !== "string" || !/^[a-f0-9]{48}\.[0-9]{13}\.[a-f0-9]{64}$/.test(token)) {
    throw ApiError.unauthorized("Invalid backup download link.");
  }
  const [id, expiry, signature] = token.split(".");
  const expected = sign(`${id}.${expiry}`);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    throw ApiError.unauthorized("Invalid backup download link.");
  }
  if (Date.now() >= Number(expiry)) throw new ApiError(410, "Backup download link has expired.");
  const target = filePath(id);
  try {
    await fs.access(target);
  } catch (error) {
    if (error.code === "ENOENT") throw ApiError.notFound("Backup file is no longer available.");
    throw error;
  }
  return { path: target, fileName: path.basename(target) };
};

const emailJsonBackup = async () => {
  const required = ["SMTP_USER", "SMTP_PASS", "BACKUP_EMAIL_TO", "BACKUP_PUBLIC_BASE_URL"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (!env.SMTP_HOST && !env.SMTP_SERVICE) missing.push("SMTP_HOST or SMTP_SERVICE");
  if (missing.length) throw ApiError.badRequest(`Backup email configuration missing: ${missing.join(", ")}`);
  const base = new URL(env.BACKUP_PUBLIC_BASE_URL);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(env.NODE_ENV !== "production" && base.protocol === "http:"))) {
    throw ApiError.badRequest("BACKUP_PUBLIC_BASE_URL must be an HTTPS API base URL without credentials, query, or fragment.");
  }
  const transport = nodemailer.createTransport({
    ...(env.SMTP_SERVICE ? { service: env.SMTP_SERVICE } : {
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
    }),
    requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
  // Reject bad SMTP configuration before doing the database export.
  await transport.verify();
  const backup = await createJsonBackup();
  const expiresAt = Date.now() + retentionMs();
  const link = new URL("/api/v1/backups/download", base);
  link.searchParams.set("token", createDownloadToken(backup.id, expiresAt));
  try {
    const result = await transport.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: env.BACKUP_EMAIL_TO,
      subject: "Finance system JSON backup download",
      text: `Your JSON data export is ready.\n\nDownload: ${link.href}\n\nExpires: ${new Date(expiresAt).toISOString()}\nAnyone with this link can download the file until it expires. Keep it private.\nThis export excludes authentication secrets and selected encrypted identity fields.`,
    });
    if (!result.accepted?.length || result.rejected?.length) {
      throw ApiError.serviceUnavailable("Backup email was not accepted for all configured recipients.");
    }
  } catch (error) {
    await fs.unlink(backup.path).catch(() => {});
    throw error;
  }
  return { fileName: backup.fileName, expiresAt: new Date(expiresAt).toISOString() };
};

module.exports = { createJsonBackup, emailJsonBackup, resolveDownload, cleanupExpiredBackups };
