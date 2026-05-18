// src/routes/collection.routes.js
// ─── Collection lifecycle ─────────────────────────────────
// Flow: agent records daily pigmy collection → receipt generated
//       → SMS sent → ledger DR Cash / CR Pigmy Deposits
//       Admin can reverse a collection (with audit trail)
// Reports: daily summary, missed, agent daily sheet
"use strict";

const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/collection.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const idempotency = require("../middleware/idempotency");
const requireIdempotencyKey = require("../middleware/requireIdempotencyKey");
const {
  recordCollectionSchema,
  reverseCollectionSchema,
  listCollectionsSchema,
  dailySheetSchema,
  dateQuerySchema,
  agentWiseReportSchema,
} = require("../validators/collection.validator");

router.use(authenticate);

// ── RECORD + LIST ─────────────────────────────────────────
router.post(
  "/",
  authorize("CREATE_COLLECTION"),
  requireIdempotencyKey,
  idempotency,
  validate(recordCollectionSchema),
  ctrl.recordCollection,
);
router.get(
  "/",
  authorize("VIEW_COLLECTION"),
  validate(listCollectionsSchema, "query"),
  ctrl.listCollections,
);

// ── STATIC ROUTES — before /:id ───────────────────────────

// GET /collections/summary/daily   → total collections for a day (admin)
router.get(
  "/summary/daily",
  authorize("VIEW_REPORTS"),
  validate(dateQuerySchema, "query"),
  ctrl.getDailySummary,
);

// GET /collections/summary/missed  → accounts with no collection today
router.get(
  "/summary/missed",
  authorize("VIEW_REPORTS"),
  validate(dateQuerySchema, "query"),
  ctrl.getMissedCollections,
);

// GET /collections/sheet           → agent's own daily sheet
router.get(
  "/sheet",
  authorize("VIEW_COLLECTION"),
  validate(dailySheetSchema, "query"),
  ctrl.getAgentDailySheet,
);

// GET /collections/sheet/:agentId  → admin views any agent's sheet
router.get(
  "/sheet/:agentId",
  authorize("VIEW_REPORTS"),
  validate(dailySheetSchema, "query"),
  ctrl.getAgentDailySheet,
);

// GET /collections/report/agent-wise → admin date-range report grouped by agent
router.get(
  "/report/agent-wise",
  authorize("VIEW_REPORTS"),
  validate(agentWiseReportSchema, "query"),
  ctrl.getAgentWiseReport,
);

// ── SINGLE COLLECTION ─────────────────────────────────────
// :id accepts MongoDB _id OR receipt number (RCP-2026-000001)
router.get("/:id", authorize("VIEW_COLLECTION"), ctrl.getCollection);

router.post(
  "/:id/reverse",
  authorize("REVERSE_COLLECTION"),
  requireIdempotencyKey,
  idempotency,
  validate(reverseCollectionSchema),
  ctrl.reverseCollection,
);

module.exports = router;
