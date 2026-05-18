// src/controllers/user.controller.js

"use strict";
const userService = require("../services/user.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");

// ─────────────────────────────────────────────────────────
// GET /api/v1/user/me
// ─────────────────────────────────────────────────────────
const getMe = asyncHandler(async (req, res) => {
  const user = await userService.getProfile(req.user._id);
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user,
      },
      "Profile fetched",
    ),
  );
});

// ─────────────────────────────────────────────────────────
// PATCH /api/v1/user/me
// ─────────────────────────────────────────────────────────
const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile({
    userId: req.user._id,
    updates: req.body,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    requestId: req.id,
  });
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user,
      },
      "Profile updated",
    ),
  );
});

module.exports = {
  getMe,
  updateMe,
};
