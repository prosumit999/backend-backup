// src/config/cloudinary.js
"use strict";

const cloudinary = require("cloudinary").v2;
const logger = require("../utils/logger");
const _env = require("../config/env");

cloudinary.config({
  cloud_name: _env.CLOUDINARY_CLOUD_NAME,
  api_key: _env.CLOUDINARY_API_KEY,
  api_secret: _env.CLOUDINARY_API_SECRET,
  secure: true,
});

cloudinary.api
  .ping()
  .then(() => logger.info("[Cloudinary] Connected successfully."))

  .catch((e) => logger.error(`[Cloudinary] Connection failed: ${e.message}`));

module.exports = cloudinary;
