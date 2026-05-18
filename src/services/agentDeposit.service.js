// src/services/agentDeposit.service.js
// ─────────────────────────────────────────────────────────────────────────────
// AGENT DEPOSIT SERVICE
//
// Handles the SECOND LEG of the daily cash flow:
//
//   Leg 1 — Collection (collection.service.js):
//     Agent collects cash from customer in the field.
//     DR Agent Cash (AGNT-xxx)  |  CR Pigmy Deposits (2002)
//
//   Leg 2 — Deposit (THIS FILE):
//     Agent hands collected cash to admin at the office.
//     DR Cash in Hand (1001)  |  CR Agent Cash (AGNT-xxx)
//
// After Leg 2, the agent's personal ledger balance = ₹0.
// dayClose.service.js blocks day close until ALL agent balances = ₹0.
//
// ACID GUARANTEE:
//   Every write — Transaction + LedgerEntries + AgentDeposit — is wrapped
//   in withTransaction(). Either ALL commit or ALL roll back.
//   No partial state is possible.
//
// IMMUTABILITY:
//   AgentDeposit records are never hard-deleted (pre-hooks block it).
//   Corrections = reverseAgentDeposit() which creates a new reversal
//   record and posts the opposite ledger pair.
//
// FUNCTIONS:
//   1. recordAgentDeposit    — agent hands cash to admin at office
//   2. reverseAgentDeposit   — undo an incorrect deposit
//   3. getAgentDeposit       — single deposit by ObjectId / DEP- / DRCP-
//   4. listAgentDeposits     — paginated, filtered, role-scoped
//   5. getAgentCashBalance   — agent's current outstanding ledger balance
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const AgentDeposit = require("../models/AgentDeposit.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const Transaction = require("../models/Transaction.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const User = require("../models/User.model");
const AgentProfile = require("../models/AgentProfile.model");

const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");

const {
  generateDepositId,
  generateDepositReceiptNumber,
  generateTransactionId,
} = require("../utils/generateCode");

const {
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  ROLES,
  AGENT_STATUS,
  PAGINATION,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER — Business date resolver
//
// Every financial write goes through this first.
// If the day is closed → 503.
// Business date always comes from AppConfig — NEVER from wall clock.
// Same pattern as collection.service.js and loan.service.js.
// ─────────────────────────────────────────────────────────────────────────────
const getBusinessDate = async () => {
  const [isDayOpen, rawDate] = await Promise.all([
    AppConfig.isDayOpen(),
    AppConfig.getCurrentBusinessDate(),
  ]);

  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. " +
      "Admin must open the day before recording agent deposits.",
    );
  }
  if (!rawDate) {
    throw new ApiError(
      503,
      "Current business date is not configured. Contact superadmin.",
    );
  }

  return startOfDay(new Date(rawDate));
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER — Resolve deposit by flexible identifier
//
// Accepts any of three valid formats:
//   MongoDB ObjectId   →  _id lookup
//   DEP-YYYY-XXXXX     →  depositId lookup
//   DRCP-YYYY-XXXXX    →  receiptNumber lookup
//
// Returns a fully populated AgentDeposit doc or throws 404.
// Used by getAgentDeposit() and reverseAgentDeposit().
// ─────────────────────────────────────────────────────────────────────────────
const resolveDeposit = async (identifier) => {
  const str = String(identifier).trim();
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(str);
  const isDepositId = /^DEP-/i.test(str);
  const isReceiptNum = /^DRCP-/i.test(str);

  let query;
  if (isObjectId) {
    query = { _id: identifier, isDeleted: false };
  } else if (isDepositId) {
    query = { depositId: str.toUpperCase(), isDeleted: false };
  } else if (isReceiptNum) {
    query = { receiptNumber: str.toUpperCase(), isDeleted: false };
  } else {
    throw new ApiError(
      400,
      `Invalid deposit identifier "${identifier}". ` +
      `Must be a MongoDB ObjectId, DEP-YYYY-XXXXX, or DRCP-YYYY-XXXXX.`,
    );
  }

  const deposit = await AgentDeposit.findOne(query)
    .populate("agent", "name phone agentCode")
    .populate("receivedBy", "name role")
    .populate("reversedBy", "name role")
    .populate("transaction", "transactionId type status createdAt");

  if (!deposit) {
    throw new ApiError(404, `Agent deposit not found: ${identifier}`);
  }

  return deposit;
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. RECORD AGENT DEPOSIT
//
// Agent physically hands collected cash to admin at the office counter.
// Cash moves from agent's pocket into the company vault.
//
// Ledger:
//   DR Cash in Hand (1001)    — company vault increases
//   CR Agent Cash (AGNT-xxx)  — agent's outstanding reduces
//
// WRITE ORDER inside withTransaction:
//   Step 1 — Re-read agent ledger balance WITH session lock  (race-safe)
//   Step 2 — Immutable Transaction record
//   Step 3 — Double-entry Ledger  DR Cash | CR Agent
//   Step 4 — AgentDeposit receipt record
//
// Outside transaction (non-critical — will NOT roll back on failure):
//   Step 5 — AuditLog
// ═════════════════════════════════════════════════════════════════════════════
const recordAgentDeposit = async ({
  agentId,
  amountInPaise,
  receivedBy,
  note = "",
  requestId,
  ipAddress,
}) => {
  const businessDate = await getBusinessDate();

  // ── Gate 1: Idempotency via requestId ─────────────────────────────────────
  // requestId is injected by express-request-id middleware on every request.
  // Prevents double-submission if admin's browser retries on network failure.
  if (requestId) {
    const duplicate = await Transaction.findOne({
      requestId,
      type: TRANSACTION_TYPES.AGENT_DEPOSIT,
      isDeleted: false,
    }).lean();
    if (duplicate) {
      throw new ApiError(
        409,
        `Duplicate request [${requestId}]. ` +
        `This deposit may already have been recorded. ` +
        `Check deposit history before retrying.`,
      );
    }
  }

  // ── Gate 2: Load and validate agent User ──────────────────────────────────
  const agentUser = await User.findById(agentId).select(
    "name phone agentCode isActive role",
  );
  if (!agentUser) {
    throw new ApiError(404, "Agent not found.");
  }
  if (agentUser.role !== ROLES.AGENT) {
    throw new ApiError(400, `User ${agentId} is not an agent.`);
  }
  if (!agentUser.isActive) {
    throw new ApiError(
      400,
      `Agent ${agentUser.agentCode} is inactive. ` +
      `Activate the agent before recording a deposit.`,
    );
  }

  // ── Gate 3: Check agent profile operational status ────────────────────────
  const agentProfile = await AgentProfile.findOne({ user: agentId });
  if (!agentProfile) {
    throw new ApiError(404, "Agent profile not found.");
  }
  if (agentProfile.status === AGENT_STATUS.SUSPENDED) {
    throw new ApiError(
      400,
      `Agent ${agentUser.agentCode} is currently suspended. ` +
      `Cannot record a deposit for a suspended agent.`,
    );
  }
  if (agentProfile.status === AGENT_STATUS.TERMINATED) {
    throw new ApiError(
      400,
      `Agent ${agentUser.agentCode} is terminated. ` +
      `Cannot record a deposit for a terminated agent.`,
    );
  }

  // ── Gate 4: Verify agent personal ledger account exists ───────────────────
  // Format: "AGNT-" + agentCode  →  e.g. "AGNT-AGT-2026-0001"
  // This account is created by createAgent() in agent.service.js
  // during agent onboarding. Missing = onboarding was incomplete.
  const agentLedgerCode = `AGNT-${agentUser.agentCode}`;
  const agentLedgerAccount = await LedgerAccount.findByCode(agentLedgerCode);
  if (!agentLedgerAccount) {
    throw new ApiError(
      500,
      `Agent ledger account [${agentLedgerCode}] not found. ` +
      `Agent onboarding may be incomplete — personal ledger account ` +
      `was not created. Contact superadmin.`,
    );
  }

  // ── Gate 5: Advisory pre-flight — deposit amount vs agent balance ──────────
  // Gives a clear human-readable error BEFORE the session opens.
  // The DEFINITIVE race-condition-safe guard is the $gte check inside
  // LedgerAccount.updateRunningBalance() within createDoublePair().
  // Both guards are needed: this one for UX, that one for correctness.
  if (agentLedgerAccount.runningBalanceInPaise <= 0) {
    throw new ApiError(
      400,
      `Agent ${agentUser.agentCode} has no outstanding cash balance to deposit. ` +
      `Current balance: ₹${(agentLedgerAccount.runningBalanceInPaise / 100).toFixed(2)}. ` +
      `Record collections before attempting a deposit.`,
    );
  }
  if (amountInPaise > agentLedgerAccount.runningBalanceInPaise) {
    throw new ApiError(
      400,
      `Deposit amount ₹${(amountInPaise / 100).toFixed(2)} exceeds ` +
      `agent ${agentUser.agentCode}'s current outstanding cash balance ` +
      `₹${(agentLedgerAccount.runningBalanceInPaise / 100).toFixed(2)}. ` +
      `Agent can only deposit what they have physically collected.`,
    );
  }

  // ── Generate IDs OUTSIDE session ──────────────────────────────────────────
  // Counter increments involve async DB writes. Doing them inside the session
  // would hold the write lock open unnecessarily and increase write-conflict
  // risk on high-traffic days. Same pattern as collection.service.js.
  const depositId = await generateDepositId(businessDate);
  const receiptNumber = await generateDepositReceiptNumber(businessDate);
  const transactionRef = await generateTransactionId(businessDate);

  let deposit;
  let newAgentBalance;

  // ── ACID Transaction ───────────────────────────────────────────────────────
  await withTransaction(async (session) => {
    // Step 1 — Re-read agent ledger balance WITH session lock
    // The advisory check above used a pre-session snapshot.
    // A concurrent deposit from the same agent could have reduced the balance
    // between that read and now. Re-reading inside the session ensures the
    // $gte guard in createDoublePair operates on the current true balance.
    const freshAgentAccount = await LedgerAccount.findByCode(
      agentLedgerCode,
      session,
    );
    if (!freshAgentAccount) {
      throw new ApiError(
        500,
        `Agent ledger account [${agentLedgerCode}] disappeared during transaction. ` +
        `This should never happen — contact superadmin.`,
      );
    }
    if (freshAgentAccount.runningBalanceInPaise < amountInPaise) {
      throw new ApiError(
        400,
        `Insufficient agent cash balance (race condition caught inside transaction). ` +
        `Available ₹${(freshAgentAccount.runningBalanceInPaise / 100).toFixed(2)}, ` +
        `Requested ₹${(amountInPaise / 100).toFixed(2)}. ` +
        `Another deposit for this agent may have been recorded concurrently.`,
      );
    }

    // Agent balance after this deposit.
    // Computed from session-locked fresh read → accurate under concurrency.
    const expectedNewAgentBalance =
      freshAgentAccount.runningBalanceInPaise - amountInPaise;

    // Step 2 — Immutable Transaction record
    // Created BEFORE ledger entries so Transaction._id is available
    // as the transactionId reference inside createDoublePair().
    const [txn] = await Transaction.create(
      [
        {
          transactionId: transactionRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.AGENT_DEPOSIT,
          agent: agentId,
          customer: null, // agent deposits have no customer
          performedBy: receivedBy,
          amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: amountInPaise,
          balanceAfterInPaise: expectedNewAgentBalance,
          reference: depositId,
          note:
            note ||
            `Agent cash deposit — ${agentUser.agentCode} | ${receiptNumber}`,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate,
        },
      ],
      { session },
    );

    // Step 3 — Double-entry Ledger
    // DR Cash in Hand (1001)    — company vault increases
    // CR Agent Cash (AGNT-xxx)  — agent's outstanding reduces
    // Atomic $gte guard inside createDoublePair() is the definitive
    // race-condition safeguard. No negative agent balance is possible.
    await ledger.recordAgentDeposit(
      {
        transactionId: txn._id,
        transactionRef,
        amountInPaise,
        performedBy: receivedBy,
        businessDate,
        session,
      },
      agentLedgerCode,
    );

    newAgentBalance = expectedNewAgentBalance;

    // Step 4 — AgentDeposit receipt record
    // agentLedgerCode stored as snapshot — safe for future reversal
    // even if agent's code structure ever changes.
    [deposit] = await AgentDeposit.create(
      [
        {
          depositId,
          receiptNumber,
          agent: agentId,
          receivedBy,
          amountInPaise,
          agentLedgerCode,
          transaction: txn._id,
          status: TRANSACTION_STATUS.COMPLETED,
          isReversed: false,
          businessDate,
          requestId: requestId || null,
          note: note || "",
        },
      ],
      { session },
    );
  });
  // ── End ACID Transaction ───────────────────────────────────────────────────

  // Step 5 — AuditLog (non-critical, outside txn)
  // Transaction is already fully committed at this point.
  // AuditLog failure must NEVER roll back a completed financial record.
  await AuditLog.log({
    performedBy: receivedBy,
    action: AUDIT_ACTIONS.AGENT_DEPOSIT_RECORDED,
    entity: "AgentDeposit",
    entityId: deposit._id,
    newData: {
      depositId,
      receiptNumber,
      agentCode: agentUser.agentCode,
      amountInPaise,
      agentLedgerCode,
      agentBalanceAfterInPaise: newAgentBalance,
      businessDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
    businessDate,
  }).catch((e) => logger.error(`[AgentDeposit] AuditLog failed: ${e.message}`));

  logger.info(
    `[AgentDeposit] RECORDED | ${depositId} | ` +
    `₹${(amountInPaise / 100).toFixed(2)} | ` +
    `Agent: ${agentUser.agentCode} | ` +
    `Remaining balance: ₹${(newAgentBalance / 100).toFixed(2)} | ` +
    `By: ${receivedBy}`,
  );

  return AgentDeposit.findById(deposit._id)
    .populate("agent", "name phone agentCode")
    .populate("receivedBy", "name role")
    .populate("transaction", "transactionId type status createdAt");
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. REVERSE AGENT DEPOSIT
//
// Admin undoes an incorrect deposit (wrong amount, wrong agent, etc.).
// Cash goes BACK out of company vault, attributed back to agent's account.
// This RE-OPENS the agent's balance — day close blocks again until the
// agent re-deposits the correct amount.
//
// Ledger:
//   DR Agent Cash (AGNT-xxx)  — agent balance restored
//   CR Cash in Hand (1001)    — company vault decreases
//
// WRITE ORDER inside withTransaction:
//   Step 1 — Re-read BOTH balances WITH session lock  (race-safe)
//   Step 2 — Reversal Transaction record  (AGENT_DEPOSIT_REVERSAL)
//   Step 3 — Reversal Ledger  DR Agent | CR Cash
//   Step 4 — Mark original Transaction as reversed  (flag update only)
//   Step 5 — Mark original AgentDeposit as reversed
//
// Outside transaction (non-critical):
//   Step 6 — AuditLog
// ═════════════════════════════════════════════════════════════════════════════
const reverseAgentDeposit = async ({
  depositId,
  reversalReason,
  reversedBy,
  requestId,
  ipAddress,
}) => {
  const businessDate = await getBusinessDate();

  // ── Load and validate the original deposit ────────────────────────────────
  const deposit = await resolveDeposit(depositId);

  if (deposit.isReversed) {
    throw new ApiError(
      400,
      `Deposit ${deposit.depositId} is already reversed. Cannot reverse twice.`,
    );
  }
  if (deposit.status !== "completed") {
    throw new ApiError(
      400,
      `Only completed deposits can be reversed. ` +
      `Current status: "${deposit.status}".`,
    );
  }

  // Use agentLedgerCode STORED on the deposit at time of recording.
  // Safe even if agent code structure ever changes in future.
  // This is exactly why AgentDeposit.agentLedgerCode field exists.
  const { agentLedgerCode } = deposit;

  if (!agentLedgerCode) {
    throw new ApiError(
      500,
      `CRITICAL: Deposit ${deposit.depositId} has no agentLedgerCode stored. ` +
      `Cannot determine which agent account to debit on reversal. ` +
      `Manual correction required — contact superadmin.`,
    );
  }

  // Resolve originalTxnId before session.
  // deposit.transaction is populated so we access ._id.
  const originalTxnId = deposit.transaction?._id || deposit.transaction;

  // Generate reversal transaction ID OUTSIDE session
  const reversalTxnRef = await generateTransactionId(businessDate);

  let reversalTxn;
  let newAgentBalance;

  // ── ACID Transaction ───────────────────────────────────────────────────────
  await withTransaction(async (session) => {
    // Step 1 — Re-read BOTH balances WITH session lock
    // Concurrent reversals or new deposits could change balances between
    // the pre-session advisory check and now.
    const freshAgentAccount = await LedgerAccount.findByCode(
      agentLedgerCode,
      session,
    );
    if (!freshAgentAccount) {
      throw new ApiError(
        500,
        `Agent ledger account [${agentLedgerCode}] not found during reversal. ` +
        `Contact superadmin.`,
      );
    }

    // Company cash (1001) must have sufficient balance to return to agent.
    // This advisory check gives a human-readable error before the DB write.
    // The definitive atomic guard is inside createDoublePair $gte check.
    const freshCashAccount = await LedgerAccount.findByCode("1001", session);
    if (!freshCashAccount) {
      throw new ApiError(500, "Cash in Hand ledger account [1001] not found.");
    }
    if (freshCashAccount.runningBalanceInPaise < deposit.amountInPaise) {
      throw new ApiError(
        400,
        `Cannot reverse deposit ${deposit.depositId}. ` +
        `Company cash balance ₹${(freshCashAccount.runningBalanceInPaise / 100).toFixed(2)} ` +
        `is less than reversal amount ₹${(deposit.amountInPaise / 100).toFixed(2)}. ` +
        `Ensure sufficient cash in hand before reversing.`,
      );
    }

    // Agent balance AFTER reversal = current balance + original deposit amount
    const expectedNewAgentBalance =
      freshAgentAccount.runningBalanceInPaise + deposit.amountInPaise;

    // Step 2 — Reversal Transaction record (immutable audit trail)
    [reversalTxn] = await Transaction.create(
      [
        {
          transactionId: reversalTxnRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.AGENT_DEPOSIT_REVERSAL,
          agent: deposit.agent._id || deposit.agent,
          customer: null,
          performedBy: reversedBy,
          amountInPaise: deposit.amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: deposit.amountInPaise,
          balanceAfterInPaise: expectedNewAgentBalance,
          reference: deposit.depositId,
          reversalOf: originalTxnId,
          note: `Reversal of deposit ${deposit.depositId}. Reason: ${reversalReason}`,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate,
        },
      ],
      { session },
    );

    // Step 3 — Reversal Ledger entry
    // DR Agent Cash (AGNT-xxx)  — agent balance restored
    // CR Cash in Hand (1001)    — company cash decreases
    // Atomic $gte guard in createDoublePair prevents company cash
    // going negative even under concurrent pressure.
    await ledger.recordAgentDepositReversal(
      {
        transactionId: reversalTxn._id,
        transactionRef: reversalTxnRef,
        amountInPaise: deposit.amountInPaise,
        performedBy: reversedBy,
        businessDate,
        session,
      },
      agentLedgerCode,
    );

    newAgentBalance = expectedNewAgentBalance;

    // Step 4 — Mark original Transaction as reversed
    // Transaction records are immutable — we only SET the reversal flags.
    // The record stays on the books permanently. Same pattern as collection.service.js.
    await Transaction.findByIdAndUpdate(
      originalTxnId,
      {
        $set: {
          isReversed: true,
          reversedBy,
          reversedAt: businessDate,
          reversalNote: reversalReason,
          status: "reversed",
        },
      },
      { session },
    );

    // ✅ Step 5 — Bug #27 FIX — Mark original AgentDeposit as reversed (atomic guard)
    //
    // OLD: findByIdAndUpdate — no condition on current state.
    //      Two concurrent requests both see isReversed:false before the session,
    //      both enter withTransaction, both execute Step 2+3 creating duplicate
    //      Transaction records and double ledger entries → agent balance inflated
    //      permanently → day close blocked forever.
    //
    // NEW: findOneAndUpdate with { isReversed: false, status: "completed" } filter.
    //      Only ONE session can win this atomic update. The other gets null → throws
    //      409 → withTransaction rolls back Steps 2+3 automatically.
    const guardedReversal = await AgentDeposit.findOneAndUpdate(
      {
        _id: deposit._id,
        isReversed: false, // ← atomic guard — only one session wins
        status: "completed", // ← only completed deposits can be reversed
      },
      {
        $set: {
          isReversed: true,
          reversedBy,
          reversedAt: businessDate,
          reversalNote: reversalReason,
          status: "reversed",
        },
      },
      { returnDocument: "after", session },
    );

    if (!guardedReversal) {
      throw new ApiError(
        409,
        `Deposit ${deposit.depositId} was already reversed by another concurrent session. ` +
        `Refresh and check deposit status before retrying.`,
      );
    }
  });
  // ── End ACID Transaction ───────────────────────────────────────────────────

  // Step 6 — AuditLog (non-critical, outside txn)
  await AuditLog.log({
    performedBy: reversedBy,
    action: AUDIT_ACTIONS.AGENT_DEPOSIT_REVERSED,
    entity: "AgentDeposit",
    entityId: deposit._id,
    oldData: {
      depositId: deposit.depositId,
      amountInPaise: deposit.amountInPaise,
      status: TRANSACTION_STATUS.COMPLETED,
    },
    newData: {
      reversalReason,
      reversalTxnRef,
      agentBalanceAfterInPaise: newAgentBalance,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
    businessDate,
  }).catch((e) =>
    logger.error(`[AgentDeposit] Reversal AuditLog failed: ${e.message}`),
  );

  logger.warn(
    `[AgentDeposit] REVERSED | ${deposit.depositId} | ` +
    `₹${(deposit.amountInPaise / 100).toFixed(2)} | ` +
    `Agent balance restored: ₹${(newAgentBalance / 100).toFixed(2)} | ` +
    `Reason: ${reversalReason} | By: ${reversedBy}`,
  );

  return {
    message: `Deposit ${deposit.depositId} reversed successfully.`,
    originalDepositId: deposit.depositId,
    reversalTransactionRef: reversalTxnRef,
    amountInPaise: deposit.amountInPaise,
    amountInRupees: `₹${(deposit.amountInPaise / 100).toFixed(2)}`,
    agentBalanceAfterInPaise: newAgentBalance,
    agentBalanceAfterRupees: `₹${(newAgentBalance / 100).toFixed(2)}`,
    note: "Day close will now block until this agent re-deposits the correct amount.",
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET SINGLE AGENT DEPOSIT
//
// Fetches one deposit by any of the three valid identifiers:
//   MongoDB ObjectId   →  _id
//   DEP-YYYY-XXXXX     →  depositId
//   DRCP-YYYY-XXXXX    →  receiptNumber
//
// OWNERSHIP GUARD:
//   Agents can only fetch their OWN deposits.
//   Admins and superadmins can fetch any deposit.
// ═════════════════════════════════════════════════════════════════════════════
const getAgentDeposit = async (
  identifier,
  requestingUserId,
  requestingUserRole,
) => {
  const deposit = await resolveDeposit(identifier);

  // Ownership guard — agents can only see their own deposits
  if (requestingUserRole === ROLES.AGENT) {
    const agentOwnerId =
      deposit.agent?._id?.toString() || deposit.agent?.toString();
    if (agentOwnerId !== requestingUserId.toString()) {
      throw new ApiError(403, "You can only view your own deposits.");
    }
  }

  return deposit;
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. LIST AGENT DEPOSITS — paginated, filtered, role-scoped
//
// Agents are automatically scoped to their own deposits — no override.
// Admins can filter by agentId, date range, or status.
//
// Query params (all optional):
//   page       → default: PAGINATION.DEFAULT_PAGE
//   limit      → default: PAGINATION.DEFAULT_LIMIT (max: PAGINATION.MAX_LIMIT)
//   agentId    → admin filter only (ignored if requesting user is agent)
//   fromDate   → ISO date string
//   toDate     → ISO date string
//   status     → "completed" | "reversed"
// ═════════════════════════════════════════════════════════════════════════════
const listAgentDeposits = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  agentId,
  fromDate,
  toDate,
  status,
  requestingUserRole,
  requestingUserId,
}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const filter = { isDeleted: false };

  // ── Role-based scoping ────────────────────────────────────────────────────
  // Agents are always and only scoped to their own records.
  // Admin agentId filter is ignored if the requester is an agent.
  if (requestingUserRole === ROLES.AGENT) {
    filter.agent = requestingUserId;
  } else if (agentId) {
    filter.agent = agentId;
  }

  // ── Status filter ─────────────────────────────────────────────────────────
  if (status) filter.status = status;

  // ── Date range filter (IST-correct) ─────────────────────────────────────────
  if (fromDate || toDate) {
    filter.businessDate = {};
    if (fromDate) filter.businessDate.$gte = startOfDay(new Date(fromDate));
    if (toDate) filter.businessDate.$lte = endOfDay(new Date(toDate));
  }

  const [deposits, total] = await Promise.all([
    AgentDeposit.find(filter)
      .select(
        "depositId receiptNumber agent receivedBy amountInPaise " +
        "agentLedgerCode status isReversed businessDate note createdAt",
      )
      .populate("agent", "name phone agentCode")
      .populate("receivedBy", "name role")
      .sort({ businessDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    AgentDeposit.countDocuments(filter),
  ]);

  return {
    deposits,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 5. GET AGENT CASH BALANCE
//
// Returns the agent's current outstanding cash balance from their personal
// ledger account (AGNT-xxx).
// This is the amount they have collected but NOT yet deposited at the office.
//
// Used by:
//   — dayClose.service.js  → blocks day close when any agent balance > ₹0
//   — Admin dashboard      → "pending deposits" widget
//   — Agent app            → "my outstanding balance" screen
//
// Balance = ₹0  → agent has fully deposited. Day close allowed.
// Balance > ₹0  → cash still physically with agent. Day close BLOCKED.
// ═════════════════════════════════════════════════════════════════════════════
const getAgentCashBalance = async (agentId) => {
  // ── Load agent User ───────────────────────────────────────────────────────
  const agentUser = await User.findById(agentId).select(
    "name phone agentCode isActive role",
  );
  if (!agentUser) throw new ApiError(404, "Agent not found.");
  if (agentUser.role !== ROLES.AGENT) {
    throw new ApiError(400, `User ${agentId} is not an agent.`);
  }

  // ── Load agent personal ledger account ───────────────────────────────────
  const agentLedgerCode = `AGNT-${agentUser.agentCode}`;
  const agentLedgerAccount = await LedgerAccount.findByCode(agentLedgerCode);
  if (!agentLedgerAccount) {
    throw new ApiError(
      500,
      `Agent ledger account [${agentLedgerCode}] not found. ` +
      `Agent onboarding may be incomplete. Contact superadmin.`,
    );
  }

  const balanceInPaise = agentLedgerAccount.runningBalanceInPaise;

  // ── Today's deposit summary (enrichment) ─────────────────────────────────
  // Shows how much agent has already deposited today vs outstanding balance.
  const businessDate = await AppConfig.getCurrentBusinessDate().catch(
    () => null,
  );
  let todayDepositTotal = { totalDepositedInPaise: 0, depositCount: 0 };
  if (businessDate) {
    todayDepositTotal = await AgentDeposit.getTodayDepositTotal(
      agentId,
      businessDate,
    );
  }

  return {
    agentId,
    agentCode: agentUser.agentCode,
    agentName: agentUser.name,
    agentLedgerCode,
    balanceInPaise,
    balanceInRupees: `₹${(balanceInPaise / 100).toFixed(2)}`,
    depositStatus: balanceInPaise === 0 ? "clear" : "outstanding",
    todayDeposits: {
      count: todayDepositTotal.depositCount,
      totalInPaise: todayDepositTotal.totalDepositedInPaise,
      totalInRupees: `₹${(todayDepositTotal.totalDepositedInPaise / 100).toFixed(2)}`,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  recordAgentDeposit,
  reverseAgentDeposit,
  getAgentDeposit,
  listAgentDeposits,
  getAgentCashBalance,
};
