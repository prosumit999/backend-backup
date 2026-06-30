"use strict";

const { Readable } = require("stream");
const ExcelJS = require("exceljs");
const { google } = require("googleapis");
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

const BACKUP_SHEETS = [
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

const buildBackupFileName = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `afs-backup-${stamp}.xlsx`;
};

const normalizeValue = (value) => {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "object" && value._bsontype === "ObjectId") {
    return value.toString();
  }
  if (typeof value === "object") return JSON.stringify(value);
  return value;
};

const flattenObject = (input, prefix = "", output = {}) => {
  if (!input || typeof input !== "object") return output;

  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (
      value &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Buffer.isBuffer(value) &&
      value._bsontype !== "ObjectId" &&
      !Array.isArray(value)
    ) {
      flattenObject(value, path, output);
    } else {
      output[path] = normalizeValue(value);
    }
  }

  return output;
};

const addSheet = (workbook, sheetName, rows) => {
  const worksheet = workbook.addWorksheet(sheetName.slice(0, 31));
  const flatRows = rows.map((row) => flattenObject(row));
  const headers = Array.from(
    flatRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set()),
  );

  if (!headers.length) {
    worksheet.addRow(["No records"]);
    return;
  }

  worksheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: Math.min(Math.max(header.length + 2, 14), 45),
  }));

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };

  for (const row of flatRows) {
    worksheet.addRow(row);
  }
};

const createWorkbookBuffer = async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AFS Backend";
  workbook.created = new Date();
  workbook.modified = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Sheet", key: "sheet", width: 28 },
    { header: "Records", key: "records", width: 14 },
    { header: "Generated At", key: "generatedAt", width: 28 },
  ];
  summary.getRow(1).font = { bold: true };

  for (const sheet of BACKUP_SHEETS) {
    const rows = await sheet.model
      .find({})
      .setOptions({ _skipDeletedFilter: true })
      .sort(sheet.sort)
      .lean({ virtuals: false });

    addSheet(workbook, sheet.name, rows);
    summary.addRow({
      sheet: sheet.name,
      records: rows.length,
      generatedAt: new Date().toISOString(),
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const getDriveAuth = () => {
  let credentials;

  if (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64) {
    credentials = JSON.parse(
      Buffer.from(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8"),
    );
  } else if (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_DRIVE_PRIVATE_KEY) {
    credentials = {
      client_email: env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
      private_key: env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    };
  }

  if (!credentials) {
    throw ApiError.badRequest(
      "Google Drive backup is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64 or service account email/private key.",
    );
  }

  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
};

const uploadBackupToDrive = async ({ buffer, fileName }) => {
  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    throw ApiError.badRequest("GOOGLE_DRIVE_FOLDER_ID is not set.");
  }

  const drive = google.drive({ version: "v3", auth: getDriveAuth() });
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [env.GOOGLE_DRIVE_FOLDER_ID],
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: Readable.from(buffer),
    },
    fields: "id,name,webViewLink,webContentLink",
  });

  return response.data;
};

const createBackupWorkbook = async () => {
  const fileName = buildBackupFileName();
  const buffer = await createWorkbookBuffer();
  return { fileName, buffer };
};

module.exports = {
  createBackupWorkbook,
  uploadBackupToDrive,
};
