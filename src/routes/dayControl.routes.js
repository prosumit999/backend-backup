// src/routes/dayControl.routes.js

"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/dayControl.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const Joi = require("joi");

router.use(authenticate);

// GET /api/v1/day-control/status
// Dashboard widget — returns isOpen, businessDate, displayDate.
// ALL roles (admin, agent, superadmin) need this to drive DayGuard and date pickers.
router.get("/status", authorize("VIEW_DAY_STATUS"), ctrl.getDayStatus);

// POST /api/v1/day-control/open
// Normal open     : no body required.
// Correction mode : { backdate: "YYYY-MM-DD", backdatePassword: "..." }
//                   Opens historical date for ledger correction. EOD skipped.
// Catch-up mode   : { backdate: "YYYY-MM-DD", backdatePassword: "...", catchupMode: true }
//                   Opens missed business day. EOD runs on close (SUPERADMIN only).
// Service enforces the role guard + bcrypt check — route just validates shape.
router.post(
  "/open",
  authorize("DAY_OPEN"),
  validate(
    Joi.object({
      backdate: Joi.string()
        .pattern(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .messages({ "string.pattern.name": "backdate must be in YYYY-MM-DD format." }),
      backdatePassword: Joi.when("backdate", {
        is: Joi.string().exist(),
        then: Joi.string().min(1).required().messages({
          "any.required": "backdatePassword is required when backdate is supplied.",
        }),
        otherwise: Joi.string().optional(),
      }),
      catchupMode: Joi.when("backdate", {
        is: Joi.string().exist(),
        then: Joi.boolean().default(false),
        otherwise: Joi.forbidden().messages({
          "any.unknown": "catchupMode can only be set when backdate is supplied.",
        }),
      }),
    })
  ),
  ctrl.openDay
);

// POST /api/v1/day-control/close

router.post(
  "/close",
  authorize("DAY_CLOSE"),
  validate(Joi.object({ forceClose: Joi.boolean().default(false) })),
  ctrl.closeDay,
);

// GET /api/v1/day-control/history
// Returns historical BusinessDay records (e.g. last 30 days)
router.get(
  "/history",
  authorize("VIEW_DAY_STATUS"),
  validate(
    Joi.object({
      limit: Joi.number().min(1).max(100).default(30),
    }),
    "query"
  ),
  ctrl.getDayHistory
);

module.exports = router;
