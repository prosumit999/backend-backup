"use strict";

const router = require("express").Router();
const ctrl = require("../controllers/backup.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

// Email links authenticate through an expiring signature, without a browser session.
router.get("/download", ctrl.downloadLinkedBackup);
router.use(authenticate);
router.get("/json", authorize("EXPORT_REPORTS"), ctrl.downloadJsonBackup);
router.post("/email", authorize("MANAGE_SETTINGS"), ctrl.emailJsonBackup);

module.exports = router;
