// src/middleware/uploaders.js

"use strict";

const { createUploader } = require("./upload.middleware");


const uploadKycDocs = createUploader({
  folder: "kyc_docs",
  allowPdf: true,
  maxSizeMB: 5,
  fields: [
    {
      name: "aadhaarFront",
      maxCount: 1,
    },
    {
      name: "aadhaarBack",
      maxCount: 1,
    },
    {
      name: "panCard",
      maxCount: 1,
    },
    {
      name: "photo",
      maxCount: 1,
    },
    { name: "signature", maxCount: 1 },
  ],
});

// ── Agent Profile Photo (standalone photo upload) ─────────
const uploadAgentPhoto = createUploader({
  folder: "agent_photos",
  imagesOnly: true,
  maxSizeMB: 2,
  fields: [
    {
      name: "photo",
      maxCount: 1,
    },
  ],
});

// ── Agent KYC Documents ───────────────────────────────────

const uploadAgentKycDocs = createUploader({
  folder: "agent_kyc_docs",
  allowPdf: true,
  maxSizeMB: 5,
  fields: [
    {
      name: "aadhaarFront",
      maxCount: 1,
    },
    {
      name: "aadhaarBack",
      maxCount: 1,
    },
    {
      name: "panCard",
      maxCount: 1,
    },
    {
      name: "photo",
      maxCount: 1,
    },
    {
      name: "signedAgreement",
      maxCount: 1,
    },
  ],
});

// ── Loan Documents ────────────────────────────────────────
const uploadLoanDocs = createUploader({
  folder: "loan_docs",
  allowPdf: true,
  maxSizeMB: 10,
  fields: [
    {
      name: "salarySlip",
      maxCount: 1,
    },
    {
      name: "bankStatement",
      maxCount: 1,
    },
    {
      name: "collateral",
      maxCount: 1,
    },
  ],
});

// ── Institution Logo (Dev Panel only — images-only, 2MB) ──────────────────────
const uploadLogo = createUploader({
  folder: "institution_logo",
  imagesOnly: true,
  maxSizeMB: 2,
  fields: [{ name: "file", maxCount: 1 }],
});

module.exports = {
  uploadKycDocs,
  uploadAgentPhoto,
  uploadAgentKycDocs,
  uploadLoanDocs,
  uploadLogo,
};
