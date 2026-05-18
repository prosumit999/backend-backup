// src/middleware/upload.middleware.js
"use strict";

const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");
const ApiError = require("../utils/ApiError");

const BASE_FOLDER = process.env.CLOUDINARY_BASE_FOLDER || "finance";
const IMAGE_MIMETYPES = ["image/jpeg", "image/png", "image/webp"];
const PDF_MIMETYPES = ["application/pdf"];

const getResourceType = (mimetype) =>
  PDF_MIMETYPES.includes(mimetype) ? "raw" : "image";

const subfolderMap = {
  aadhaarFront: "aadhaar_front",
  aadhaarBack: "aadhaar_back",
  panCard: "pan_card",
  photo: "photo",
  signature: "signature",
  salarySlip: "salary_slip",
  bankStatement: "bank_statement",
  collateral: "collateral",
  signedAgreement: "signed_agreement",
};

const createUploader = ({
  folder,
  fields,
  maxSizeMB = 5,
  allowPdf = true,
  imagesOnly = false,
}) => {
  if (!folder) throw new Error("createUploader: folder is required");
  if (!fields?.length)
    throw new Error("createUploader: fields array is required");

  const allowedMimes = imagesOnly
    ? IMAGE_MIMETYPES
    : allowPdf
      ? [...IMAGE_MIMETYPES, ...PDF_MIMETYPES]
      : IMAGE_MIMETYPES;

  const MIME_TO_FORMAT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  };
  const allowedFormats = allowedMimes
    .map((m) => MIME_TO_FORMAT[m])
    .filter(Boolean);

  const storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => {
      const entityCode =
        req.customer?.customerCode ??
        req.agent?.agentCode ??
        req.user?._id?.toString() ??
        "general";

      const subfolder = subfolderMap[file.fieldname] ?? file.fieldname;
      const resourceType = getResourceType(file.mimetype);

      return {
        folder: `${BASE_FOLDER}/${folder}/${entityCode}/${subfolder}`,
        public_id: `${entityCode}_${subfolder}`,
        resource_type: resourceType,
        allowed_formats: allowedFormats,
        transformation:
          resourceType === "image"
            ? [{ quality: "auto", fetch_format: "auto" }]
            : undefined,
        tags: [entityCode, file.fieldname, folder],
      };
    },
  });

  const fileFilter = (req, file, cb) => {
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const allowed = imagesOnly ? "JPG, PNG, WEBP" : "JPG, PNG, WEBP, PDF";
      cb(
        ApiError.badRequest(
          `Invalid file type for '${file.fieldname}'. Allowed: ${allowed}`,
        ),
        false,
      );
    }
  };

  return multer({
    storage,
    fileFilter,
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
  }).fields(fields);
};

module.exports = { createUploader };
