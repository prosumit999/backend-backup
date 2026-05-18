// src/routes/agentDeposit.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// AGENT DEPOSIT ROUTES
//
// Mount point (in app.js / index.js):
//   app.use("/api/v1/agent-deposits", require("./routes/agentDeposit.routes"));
//
// ROUTE ORDER RULE — CRITICAL:
//   Express matches routes top-to-bottom.
//   Static segment routes  ( /  and  /:depositId/reverse )
//   MUST appear BEFORE wildcard param routes ( /:identifier ).
//   Otherwise GET /:identifier would intercept POST /:depositId/reverse.
//
//   Current order is correct:
//     POST  /                    ← static
//     GET   /                    ← static
//     POST  /:depositId/reverse  ← two-segment — Express will NOT confuse
//                                  this with GET /:identifier because
//                                  method + segment count differ
//     GET   /:identifier         ← single wildcard — always last
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/agentDeposit.controller");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const validate = require("../middleware/validate");
const idempotency = require("../middleware/idempotency");
const requireIdempotencyKey = require("../middleware/requireIdempotencyKey");

const {
  recordDepositSchema,
  reverseDepositSchema,
  listDepositsSchema,
} = require("../validators/agentDeposit.validator");

// ─────────────────────────────────────────────────────────────────────────────
// ALL routes require a valid JWT — authenticate runs first, always.
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ═════════════════════════════════════════════════════════════════════════════
// 1. RECORD AGENT DEPOSIT
//    POST /api/v1/agent-deposits
//    Access: admin only
//    Body:   { agentId, amountInPaise, note? }
// ═════════════════════════════════════════════════════════════════════════════
router.post(
  "/",
  authorize("RECORD_AGENT_DEPOSIT"),
  validate(recordDepositSchema),
  requireIdempotencyKey,
  idempotency,
  ctrl.recordAgentDeposit,
);

// ═════════════════════════════════════════════════════════════════════════════
// 2. LIST AGENT DEPOSITS  (paginated)
//    GET /api/v1/agent-deposits?page=1&limit=20&agentId=...&fromDate=...
//    Access: admin only
//    Agent's own deposit history → service scopes by req.user.id when
//    role === agent (VIEW_AGENT_DEPOSIT is shared; admin list is admin-only
//    by convention in the service — see agentDeposit.service.listDeposits)
// ═════════════════════════════════════════════════════════════════════════════
router.get(
  "/",
  authorize("VIEW_AGENT_DEPOSIT"),
  validate(listDepositsSchema, "query"),
  ctrl.listAgentDeposits,
);

// ═════════════════════════════════════════════════════════════════════════════
// 3. REVERSE AGENT DEPOSIT
//    POST /api/v1/agent-deposits/:depositId/reverse
//    Access: superadmin + admin
//    :depositId = ObjectId | DEP-YYYY-NNNNN | DRCP-YYYY-NNNNN
//    Body: { reversalReason }
//
//    WHY POST and not PATCH?
//    Reversal is a side-effecting operation that creates NEW records
//    (reversal Transaction + ledger entries). It is not a partial update
//    of the deposit document itself. POST is semantically correct here.
//    Same pattern used in collection.routes.js → POST /:id/reverse.
// ═════════════════════════════════════════════════════════════════════════════
router.post(
  "/:depositId/reverse",
  authorize("REVERSE_AGENT_DEPOSIT"),
  validate(reverseDepositSchema), // validates req.body
  ctrl.reverseAgentDeposit,
);

// ═════════════════════════════════════════════════════════════════════════════
// 4. GET AGENT CASH BALANCE      ← MUST be before /:identifier
//    GET /api/v1/agent-deposits/cash-balance/:agentId
//    Access: admin | agent (own only, enforced in controller)
//
//    REASON THIS IS ABOVE /:identifier:
//    Express matches routes top-to-bottom by registration order.
//    If /:identifier appeared first, a request for:
//      GET /agent-deposits/cash-balance/AGENTID
//    would match /:identifier with identifier="cash-balance" and
//    hit resolveDeposit("cash-balance") → 400 "Invalid deposit identifier".
//    Placing this static two-segment path first avoids the ambiguity entirely.
// ═════════════════════════════════════════════════════════════════════════════
router.get(
  "/cash-balance/:agentId",
  authorize("VIEW_AGENT_DEPOSIT"),
  ctrl.getAgentCashBalance,
);

// ═════════════════════════════════════════════════════════════════════════════
// 5. GET SINGLE AGENT DEPOSIT    ← wildcard — always LAST
//    GET /api/v1/agent-deposits/:identifier
//    Access: admin + agent (agent ownership enforced in service layer)
//    :identifier = ObjectId | DEP-YYYY-NNNNN | DRCP-YYYY-NNNNN
//
//    NOTE: No validate() here — identifier format is intentionally flexible.
//    The service normalises and resolves all three formats.
//    An invalid format simply results in a 404, not a 422.
// ═════════════════════════════════════════════════════════════════════════════
router.get(
  "/:identifier",
  authorize("VIEW_AGENT_DEPOSIT"),
  ctrl.getAgentDeposit,
);

// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
