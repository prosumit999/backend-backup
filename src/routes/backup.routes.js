"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/backup.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

router.use(authenticate);

router.get("/excel", authorize("EXPORT_REPORTS"), ctrl.downloadExcelBackup);
router.post(
  "/google-drive",
  authorize("MANAGE_SETTINGS"),
  ctrl.uploadExcelBackupToDrive,
);

module.exports = router;
