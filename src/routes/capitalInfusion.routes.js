"use strict";

const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const { recordCapitalInfusion } = require("../controllers/capitalInfusion.controller");

router.use(authenticate);

// POST /api/v1/capital-infusion
// DR Cash (1001) | CR Owner's Capital (5002)
router.post("/", authorize("MANAGE_SETTINGS"), recordCapitalInfusion);

module.exports = router;
