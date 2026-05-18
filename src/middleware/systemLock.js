// src/middleware/systemLock.js
"use strict";

const AppConfig = require("../models/AppConfig.model");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { CONFIG_KEYS, ROLES } = require("../config/constants");

const systemLock = asyncHandler(async (req, res, next) => {
  // Skip all read operations — maintenance mode only blocks writes
  if (req.method === "GET") return next();

  if (req.user?.role === ROLES.SUPERADMIN) return next();

  const isLocked = await AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED);

  if (isLocked) {
    throw ApiError.serviceUnavailable(
      "System is under maintenance. Write operations are disabled.",
    );
  }

  next();
});

module.exports = systemLock;
