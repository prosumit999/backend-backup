"use strict";

const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const backupService = require("../services/backup.service");

const EXCEL_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const downloadExcelBackup = asyncHandler(async (_req, res) => {
  const { fileName, buffer } = await backupService.createBackupWorkbook();

  res.setHeader("Content-Type", EXCEL_MIME);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", buffer.length);
  return res.status(200).send(buffer);
});

const uploadExcelBackupToDrive = asyncHandler(async (_req, res) => {
  const { fileName, buffer } = await backupService.createBackupWorkbook();
  const file = await backupService.uploadBackupToDrive({ buffer, fileName });

  return res
    .status(201)
    .json(new ApiResponse(201, { file }, "Backup uploaded to Google Drive"));
});

module.exports = {
  downloadExcelBackup,
  uploadExcelBackupToDrive,
};
