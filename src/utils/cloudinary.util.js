// src/utils/cloudinary.util.js
"use strict";

const cloudinary = require("../config/cloudinary");
const logger = require("./logger");

const BASE_FOLDER = process.env.CLOUDINARY_BASE_FOLDER || "finance";

// ─────────────────────────────────────────────────────────
// DELETE SINGLE ASSET
// ─────────────────────────────────────────────────────────
const deleteAsset = async (publicId, resourceType = "auto") => {
  if (!publicId) return false;

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });

    if (result.result === "ok" || result.result === "not found") {
      logger.info(`[Cloudinary] Deleted | ${publicId}`);
      return true;
    }

    logger.error(`[Cloudinary] Delete failed | ${publicId} | ${result.result}`);
    return false;
  } catch (err) {
    logger.error(`[Cloudinary] Delete error | ${publicId} | ${err.message}`);
    return false;
  }
};

// ─────────────────────────────────────────────────────────
// DELETE MULTIPLE ASSETS IN PARALLEL
// ─────────────────────────────────────────────────────────
const deleteAssets = async (publicIds = []) => {
  const valid = publicIds.filter(Boolean);
  if (!valid.length) return;

  // allSettled — one failure never blocks others
  await Promise.allSettled(valid.map((id) => deleteAsset(id)));
};

// ─────────────────────────────────────────────────────────
// REPLACE — delete old before saving new
// ─────────────────────────────────────────────────────────
const replaceAsset = async (oldPublicId, newBuffer, options = {}) => {
  if (oldPublicId) {
    await deleteAsset(oldPublicId, options.resource_type || "image");
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(newBuffer);
  });
};

// ─────────────────────────────────────────────────────────
// DELETE ENTIRE CUSTOMER FOLDER
// Used when customer is permanently deleted.
// ─────────────────────────────────────────────────────────
const deleteCustomerFolder = async (customerCode) => {
  if (!customerCode) return;

  const folder = `${BASE_FOLDER}/kyc_docs/${customerCode}`;

  try {
    await cloudinary.api.delete_resources_by_prefix(folder);
    await cloudinary.api.delete_folder(folder);
    logger.info(`[Cloudinary] Folder deleted | ${folder}`);
  } catch (err) {
    logger.error(
      `[Cloudinary] Folder delete failed | ${folder} | ${err.message}`,
    );
  }
};

module.exports = {
  deleteAsset,
  deleteAssets,
  replaceAsset,
  deleteCustomerFolder,
};
