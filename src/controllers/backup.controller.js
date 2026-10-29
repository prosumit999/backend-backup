"use strict";

const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const backupService = require("../services/backup.service");
const { runBackupJob } = require("../jobs/backup.job");

const sendFile = (res, next, file) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.download(file.path, file.fileName, (error) => {
    if (error) next(error);
  });
};

const downloadJsonBackup = asyncHandler(async (_req, res, next) => {
  return sendFile(res, next, await backupService.createJsonBackup());
});

const downloadLinkedBackup = asyncHandler(async (req, res, next) => {
  return sendFile(res, next, await backupService.resolveDownload(req.query.token));
});

const emailJsonBackup = asyncHandler(async (_req, res) => {
  const backup = await runBackupJob({ trigger: "manual" });
  if (!backup) return res.status(409).json({ success: false, message: "A backup is already running." });
  return res.status(201).json(new ApiResponse(201, backup, "JSON backup download link emailed"));
});

module.exports = { downloadJsonBackup, downloadLinkedBackup, emailJsonBackup };
