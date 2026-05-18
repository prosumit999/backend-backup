// src/services/collection.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Collection Service — handles all pigmy daily collection operations
//
// REPAYMENT FLOW:
// recordCollection() → ONLY updates PigmyAccount.balanceInPaise
// Loan outstanding is NEVER touched here automatically.
// Admin manually calls applyPigmyToLoan() from loan.service.js.
//
// AGENT CASH FLOW (NEW):
// OLD: recordCollection() → DR Cash 1001 | CR Pigmy Deposits 2002
//      Cash was always attributed to company directly.
// NEW: recordCollection() → DR Agent Cash (AGNT-xxx) | CR Pigmy Deposits 2002
//      Cash sits in agent's personal ledger until they deposit it.
//      Agent deposit (agentDeposit.service) moves it: DR Cash 1001 | CR AGNT-xxx
//      Day close blocks until ALL agent ledger balances = 0.
//
// BACKWARD COMPATIBILITY:
//   Old Collection records have collectionLedgerDebitCode: null
//   → reverseCollection() detects null → falls back to old recordCollectionReversal
//   → credits Cash 1001 (correct for legacy records)
//   New records store agentLedgerCode → reversal credits the correct agent account.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Collection = require("../models/Collection.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const Transaction = require("../models/Transaction.model");
const User = require("../models/User.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const smsService = require("../utils/sms.service");
const { assertPigmyAccountActive } = require("./pigmy.service");
const { startOfDay, endOfDay, toIndianDate } = require("../utils/dateHelpers");
const {
  COLLECTION_STATUS,
  COLLECTION_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  AUDIT_ACTIONS,
  ACCOUNT_STATUS,
  AUDIT_STATUS,
  ROLES,
  PAGINATION,
} = require("../config/constants");
const {
  generateReceiptNumber,
  generateTransactionId,
} = require("../utils/generateCode");

// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPER — Fetch + validate AppConfig business date
//
// C-6 FIX: Two sequential DB round-trips → one parallel Promise.all.
// isDayOpen() and getCurrentBusinessDate() each hit MongoDB separately (2× RTT).
// Promise.all fires both simultaneously — halves the latency for every
// financial write that calls getBusinessDate().
// ═════════════════════════════════════════════════════════════════════════════

const getBusinessDate = async () => {
  const [isDayOpen, rawDate] = await Promise.all([
    AppConfig.isDayOpen(),
    AppConfig.getCurrentBusinessDate(),
  ]);
  if (!isDayOpen) {
    throw new ApiError(
      503,
      "Business day is not open. Admin must open the day before recording collections.",
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

// ═════════════════════════════════════════════════════════════════════════════
// 1. RECORD COLLECTION
// ═════════════════════════════════════════════════════════════════════════════
const recordCollection = async ({
  accountId,
  amountInPaise,
  collectionDate,
  collectionType = COLLECTION_TYPES.DAILY,
  note,
  agentId,
  recordedBy,
  requestingUserRole,    // ← C-4: required to enforce agent ledger ownership
  idempotencyKey,
  ipAddress,
  requestId,
}) => {
  const businessDate = await getBusinessDate();

  const account = await PigmyAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw new ApiError(404, "Pigmy account not found");

  assertPigmyAccountActive(account);

  if (
    collectionType !== COLLECTION_TYPES.MANUAL &&
    amountInPaise !== account.dailyDepositAmountInPaise
  ) {
    throw new ApiError(
      400,
      `Collection amount ₹${(amountInPaise / 100).toFixed(2)} does not match ` +
      `account's fixed deposit ₹${(account.dailyDepositAmountInPaise / 100).toFixed(2)}. ` +
      `Use collectionType: 'manual' for custom amounts.`,
    );
  }

  // ── C-4 FIX: Agent identity security override ────────────────────────────────
  // Without this guard, an agent can set ANY agentId in the request body and
  // collected cash gets posted to another agent's personal ledger account.
  // If the JWT role is AGENT, their own recordedBy ID overrides the body agentId.
  const effectiveAgentId =
    requestingUserRole === ROLES.AGENT ? recordedBy : (agentId || null);

  const effectiveDate = startOfDay(
    collectionDate ? new Date(collectionDate) : new Date(businessDate),
  );

  const businessDateEnd = endOfDay(businessDate);

  // ── BUG FIX: Agents CANNOT backdate — locked to business date only ────────
  // Only admin/superadmin can use the 3-day backdate window.
  // Agents in the field must record on the open business day only.
  if (requestingUserRole === ROLES.AGENT) {
    const agentDateStr = effectiveDate.toISOString().split("T")[0];
    const bizDateStr = businessDate.toISOString().split("T")[0];
    if (agentDateStr !== bizDateStr) {
      throw new ApiError(
        403,
        "Agents can only record collections for the current business day. " +
        "Contact your admin to record past-date collections.",
      );
    }
  }

  // ── C-7 FIX: Millisecond arithmetic — no setDate()/getDate() ─────────────────
  const threeDaysAgo = startOfDay(
    new Date(businessDate.getTime() - 3 * 24 * 60 * 60 * 1000),
  );

  // ── C-2 FIX: Idempotency cache check BEFORE date validation ──────────────────
  if (idempotencyKey) {
    const existing = await Collection.findOne({ idempotencyKey }).lean();
    if (existing) {
      logger.info(
        `[Collection] Idempotent replay | key: ${idempotencyKey} | receipt: ${existing.receiptNumber}`,
      );
      return Collection.findById(existing._id)
        .populate("customer", "name phone customerCode")
        .populate(
          "pigmyAccount",
          "accountNumber balanceInPaise dailyDepositAmountInPaise",
        )
        .populate("agent", "name agentCode");
    }
  }

  // ── C-8 FIX: Cheap date guards BEFORE expensive requestId DB query ────────────
  if (effectiveDate > businessDateEnd) {
    throw new ApiError(
      400,
      "Cannot record collection for a date beyond the current business date.",
    );
  }
  // Admin 3-day backdate window (agents already blocked above)
  if (effectiveDate < threeDaysAgo) {
    throw new ApiError(
      400,
      "Cannot back-date collection more than 3 days. Contact admin for manual entry.",
    );
  }

  // ── BUG FIX: Collection date cannot be BEFORE the account was created ────────
  // Prevents marking collection for days before the pigmy account existed.
  const accountOpenDate = startOfDay(
    new Date(account.openedAt || account.createdAt),
  );
  if (effectiveDate < accountOpenDate) {
    throw new ApiError(
      400,
      `Cannot record collection for ${effectiveDate.toISOString().split("T")[0]} — ` +
      `this account was opened on ${accountOpenDate.toISOString().split("T")[0]}.`,
    );
  }

  // requestId de-duplication DB check (runs after cheap guards pass)
  if (requestId) {
    const duplicate = await Transaction.findOne({ requestId }).lean();
    if (duplicate) {
      throw new ApiError(
        409,
        `Duplicate request [${requestId}]. Collection may already be recorded. ` +
        `Check receipt before retrying.`,
      );
    }
  }

  // ── Resolve agent ledger code BEFORE session opens ────────────────────────
  let agentLedgerCode = null;
  if (effectiveAgentId) {
    const agentUser = await User.findById(effectiveAgentId)
      .select("ledgerAccount")
      .populate("ledgerAccount", "code");
    agentLedgerCode = agentUser?.ledgerAccount?.code || null;

    if (!agentLedgerCode) {
      logger.warn(
        `[Collection] Agent ${effectiveAgentId} has no ledger account. ` +
        `Falling back to legacy Cash 1001 debit. ` +
        `Run agent ledger migration or recreate agent.`,
      );
    }
  }

  const receiptNumber = await generateReceiptNumber(businessDate);
  const transactionRef = await generateTransactionId(businessDate);

  let collection;
  let newBalance;

  await withTransaction(async (session) => {
    const sameDayExists = await Collection.findOne({
      pigmyAccount: accountId,
      collectionDate: {
        $gte: effectiveDate,            // C-9 FIX: effectiveDate is already startOfDay(…) — no double-wrap
        $lte: endOfDay(effectiveDate),
      },
      isReversed: false,
      isDeleted: false,
    }).session(session);

    if (sameDayExists) {
      throw new ApiError(
        409,
        `Collection already recorded for account ${account.accountNumber} ` +
        `on ${effectiveDate.toDateString()}. Receipt: ${sameDayExists.receiptNumber}`,
      );
    }

    // ── Step 1: Update PigmyAccount — FIX C-3: atomic ACCOUNT_STATUS guard ──
    // Outer assertPigmyAccountActive() uses stale read. A concurrent admin
    // freeze between that check and here would credit a frozen account.
    // findOneAndUpdate with status filter prevents that atomically.
    const updatedAccount = await PigmyAccount.findOneAndUpdate(
      {
        _id: accountId,
        status: ACCOUNT_STATUS.ACTIVE,
      },
      {
        $inc: {
          balanceInPaise: +amountInPaise,
          totalCollectedInPaise: +amountInPaise,
          totalCollectionDays: +1,
        },
        $set: {
          lastCollectionDate: effectiveDate,
        },
      },
      { returnDocument: "after", session },
    );

    if (!updatedAccount) {
      throw new ApiError(
        403,
        `Pigmy account ${account.accountNumber} is no longer active ` +
        `(may have been frozen or closed during this request). ` +
        `Refresh and retry.`,
      );
    }

    newBalance = updatedAccount.balanceInPaise;

    // ── Step 2: Immutable Transaction record ───────────────────────────────
    const [txn] = await Transaction.create(
      [
        {
          transactionId: transactionRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.PIGMY_COLLECTION,
          toPigmyAccount: accountId,
          customer: account.customer._id,
          agent: effectiveAgentId || null,
          performedBy: recordedBy,
          amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: amountInPaise,
          balanceAfterInPaise: newBalance,
          reference: receiptNumber,
          note: note || `Daily pigmy collection — ${receiptNumber}`,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate,
        },
      ],
      { session },
    );

    // ── Step 3: Double-entry Ledger ────────────────────────────────────────
    // NEW  (agentLedgerCode present): DR Agent Cash (AGNT-xxx) | CR Pigmy 2002
    // LEGACY (agentLedgerCode null) : DR Cash in Hand (1001)   | CR Pigmy 2002
    const ledgerParams = {
      transactionId: txn._id,
      transactionRef,
      amountInPaise,
      customer: account.customer._id,
      performedBy: recordedBy,
      businessDate,
      session,
    };

    if (agentLedgerCode) {
      await ledger.recordAgentCollection(ledgerParams, agentLedgerCode);
    } else {
      await ledger.recordPigmyCollection(ledgerParams);
    }

    // ── Step 4: Collection receipt record ─────────────────────────────────
    [collection] = await Collection.create(
      [
        {
          receiptNumber,
          pigmyAccount: accountId,
          customer: account.customer._id,
          agent: effectiveAgentId,
          recordedBy,
          amountInPaise,
          balanceAfterInPaise: newBalance,
          transaction: txn._id,
          collectionDate: effectiveDate,
          businessDate,
          collectionType,
          status: COLLECTION_STATUS.COLLECTED,
          idempotencyKey: idempotencyKey || requestId,
          note: note || null,
          recordedAt: new Date(),
          collectionLedgerDebitCode: agentLedgerCode || null,
        },
      ],
      { session },
    );
  });

  // ── Step 5: SMS receipt (non-critical) ────────────────────────────────────
  const customer = account.customer;
  const smsResult = await smsService
    .sendCollectionReceipt(
      customer.phone,
      customer.name,
      (amountInPaise / 100).toFixed(0),
      toIndianDate(effectiveDate),    // C-1 FIX: IST-correct display via timeZone: "Asia/Kolkata"
      receiptNumber,
      (newBalance / 100).toFixed(0),
    )
    .catch((e) => {
      logger.error(
        `[Collection] SMS failed | Receipt: ${receiptNumber} | ${e.message}`,
      );
      return { success: false };
    });

  if (smsResult?.success) {
    await collection.markSmsSent().catch(() => { });
  }

  // ── Step 6: AuditLog (non-critical) ───────────────────────────────────────
  await AuditLog.log({
    performedBy: recordedBy,
    action: AUDIT_ACTIONS.COLLECTION_RECORDED,
    entity: "Collection",
    entityId: collection._id,
    newData: {
      receiptNumber,
      accountNumber: account.accountNumber,
      amountInPaise,
      balanceAfterInPaise: newBalance,
      collectionDate: effectiveDate,
      businessDate,
      agentLedgerCode: agentLedgerCode || "legacy-cash-1001",
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
    businessDate,
  }).catch((e) => logger.error(`[Collection] AuditLog failed: ${e.message}`));

  logger.info(
    `[Collection] RECORDED | ${receiptNumber} | ` +
    `₹${(amountInPaise / 100).toFixed(2)} | Acc: ${account.accountNumber} | ` +
    `Ledger DR: ${agentLedgerCode || "1001"}`,
  );

  return Collection.findById(collection._id)
    .populate("customer", "name phone customerCode")
    .populate(
      "pigmyAccount",
      "accountNumber balanceInPaise dailyDepositAmountInPaise",
    )
    .populate("agent", "name agentCode");
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. GET SINGLE COLLECTION — UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════
const getCollection = async (identifier) => {
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(String(identifier));
  const query = isObjectId
    ? { _id: identifier, isDeleted: false }
    : { receiptNumber: String(identifier).toUpperCase(), isDeleted: false };

  const collection = await Collection.findOne(query)
    .populate("customer", "name phone customerCode")
    .populate(
      "pigmyAccount",
      "accountNumber dailyDepositAmountInPaise balanceInPaise",
    )
    .populate("agent", "name phone agentCode")
    .populate("recordedBy", "name role")
    .populate("transaction", "transactionId type status createdAt")
    .populate("reversedBy", "name role");

  if (!collection) throw new ApiError(404, "Collection not found");
  return collection;
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. LIST COLLECTIONS — UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════
const listCollections = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  fromDate,
  toDate,
  agentId,
  customerId,
  accountId,
  status,
  requestingUserRole,
  requestingUserId,
}) => {
  const filter = { isDeleted: false };

  if (requestingUserRole === ROLES.AGENT) {
    filter.agent = requestingUserId;
  } else if (agentId) {
    filter.agent = agentId;
  }

  if (customerId) filter.customer = customerId;
  if (accountId) filter.pigmyAccount = accountId;
  if (status) filter.status = status;

  if (fromDate || toDate) {
    filter.collectionDate = {};
    if (fromDate) filter.collectionDate.$gte = startOfDay(new Date(fromDate));
    if (toDate) filter.collectionDate.$lte = endOfDay(new Date(toDate));
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [collections, total] = await Promise.all([
    Collection.find(filter)
      .select(
        "receiptNumber customer pigmyAccount agent " +
        "amountInPaise balanceAfterInPaise collectionDate " +
        "collectionType status smsSent isReversed recordedAt",
      )
      .populate("customer", "name phone customerCode")
      .populate("pigmyAccount", "accountNumber")
      .populate("agent", "name agentCode")
      .skip(skip)
      .limit(safeLimit)
      .sort({ collectionDate: -1, createdAt: -1 })
      .lean(),
    Collection.countDocuments(filter),
  ]);

  return {
    collections,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. GET AGENT DAILY SHEET — UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════
const getAgentDailySheet = async ({
  agentId,
  date,
  requestingUserId,
  requestingUserRole,
}) => {
  if (
    requestingUserRole === ROLES.AGENT &&
    agentId.toString() !== requestingUserId.toString()
  ) {
    throw new ApiError(403, "You can only view your own collection sheet.");
  }

  // ── C-5 FIX: Default to AppConfig business date, not wall clock ──────────────
  // new Date() returns wall-clock UTC. On cloud servers this can be a different
  // IST calendar date than the open business day (e.g. after midnight IST).
  const _sheetDefaultRaw = date
    ? new Date(date)
    : new Date((await AppConfig.getCurrentBusinessDate()) || Date.now());
  const sheetDate = startOfDay(_sheetDefaultRaw);
  const sheetEnd = endOfDay(_sheetDefaultRaw);

  const [assignedAccounts, todayCollections] = await Promise.all([
    PigmyAccount.find({
      assignedAgent: agentId,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    })
      .populate("customer", "name phone customerCode address")
      .lean(),

    Collection.find({
      agent: agentId,
      collectionDate: { $gte: sheetDate, $lte: sheetEnd },
      isDeleted: false,
      isReversed: false,
    })
      .select("pigmyAccount amountInPaise receiptNumber status")
      .lean(),
  ]);

  const collectedMap = new Map(
    todayCollections.map((c) => [c.pigmyAccount.toString(), c]),
  );

  const sheet = assignedAccounts.map((acc) => {
    const col = collectedMap.get(acc._id.toString()) || null;
    const done = col !== null;
    return {
      accountId: acc._id,
      accountNumber: acc.accountNumber,
      customer: {
        id: acc.customer._id,
        name: acc.customer.name,
        phone: acc.customer.phone,
        customerCode: acc.customer.customerCode,
        address: acc.customer.address,
      },
      dailyDepositAmountInPaise: acc.dailyDepositAmountInPaise,
      dailyDepositAmountInRup: (acc.dailyDepositAmountInPaise / 100).toFixed(2),
      currentBalanceInPaise: acc.balanceInPaise,
      currentBalanceInRup: (acc.balanceInPaise / 100).toFixed(2),
      collectionFrequency: acc.collectionFrequency,
      collectionStatus: done ? "collected" : "pending",
      receiptNumber: col?.receiptNumber || null,
      collectedAmountInPaise: col?.amountInPaise || null,
    };
  });

  const totalCollectedPaise = todayCollections.reduce(
    (s, c) => s + c.amountInPaise,
    0,
  );
  const expectedTotalPaise = assignedAccounts.reduce(
    (s, a) => s + a.dailyDepositAmountInPaise,
    0,
  );
  const collectedCount = sheet.filter(
    (s) => s.collectionStatus === "collected",
  ).length;

  return {
    date: toIndianDate(sheetDate),    // C-1 FIX: IST-correct date display
    agentId,
    summary: {
      totalAccounts: sheet.length,
      collectedCount,
      pendingCount: sheet.length - collectedCount,
      collectionRate:
        sheet.length > 0
          ? `${((collectedCount / sheet.length) * 100).toFixed(1)}%`
          : "0%",
      totalCollectedInPaise: totalCollectedPaise,
      totalCollectedInRupees: (totalCollectedPaise / 100).toFixed(2),
      expectedTotalInPaise: expectedTotalPaise,
      expectedTotalInRupees: (expectedTotalPaise / 100).toFixed(2),
    },
    sheet,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 5. REVERSE COLLECTION
// ═════════════════════════════════════════════════════════════════════════════
const reverseCollection = async ({
  collectionId,
  reversalReason,
  reversedBy,
  ipAddress,
  requestId,
}) => {
  const businessDate = await getBusinessDate();

  const collection = await Collection.findById(collectionId).populate(
    "pigmyAccount",
    "accountNumber balanceInPaise",
  );

  if (!collection) throw new ApiError(404, "Collection not found");

  // Outer check — fast-fail on obvious already-reversed (stale read is OK here
  // as a soft guard only; the definitive check runs inside the session below)
  if (collection.isReversed) {
    throw new ApiError(
      400,
      `Collection ${collection.receiptNumber} is already reversed.`,
    );
  }
  if (collection.status !== COLLECTION_STATUS.COLLECTED) {
    throw new ApiError(400, `Only 'collected' entries can be reversed.`);
  }

  const transactionRef = await generateTransactionId(businessDate);
  let reversalTxn;
  let newBalance;

  await withTransaction(async (session) => {
    // ── FIX C-1: Session-locked isReversed re-check ────────────────────────
    // Outer check uses stale closure value. On a withTransaction write-conflict
    // retry, collection.isReversed is still false in closure even if a
    // concurrent request already committed a reversal. This session-locked
    // read is the definitive guard that prevents double-reversal.
    const freshCollection = await Collection.findById(collectionId)
      .select("isReversed receiptNumber status amountInPaise")
      .session(session);

    if (!freshCollection) {
      throw new ApiError(404, "Collection not found during reversal. Retry.");
    }
    if (freshCollection.isReversed) {
      throw new ApiError(
        409,
        `Collection ${freshCollection.receiptNumber} was already reversed ` +
        `by a concurrent request.`,
      );
    }

    const updated = await PigmyAccount.findOneAndUpdate(
      {
        _id: collection.pigmyAccount._id,
        balanceInPaise: { $gte: collection.amountInPaise },
      },
      {
        $inc: {
          balanceInPaise: -collection.amountInPaise,
          totalCollectedInPaise: -collection.amountInPaise,
          totalCollectionDays: -1,
        },
      },
      { returnDocument: "after", session },
    );

    if (!updated) {
      // Re-read for human-readable error only — no write dependency on this
      const current = await PigmyAccount.findById(collection.pigmyAccount._id)
        .session(session)
        .lean();
      throw new ApiError(
        400,
        `Cannot reverse. Current pigmy balance ` +
        `₹${((current?.balanceInPaise || 0) / 100).toFixed(2)} ` +
        `is less than the collection amount ` +
        `₹${(collection.amountInPaise / 100).toFixed(2)}. ` +
        `The funds may have already been applied to a loan.`,
      );
    }

    newBalance = updated.balanceInPaise;

    // ── Step 3: Reversal Transaction record ───────────────────────────────
    [reversalTxn] = await Transaction.create(
      [
        {
          transactionId: transactionRef,
          requestId: requestId || null,
          type: TRANSACTION_TYPES.COLLECTION_REVERSAL,
          fromPigmyAccount: collection.pigmyAccount._id,
          customer: collection.customer,
          performedBy: reversedBy,
          amountInPaise: collection.amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: collection.amountInPaise,
          balanceAfterInPaise: newBalance,
          reference: collection.receiptNumber,
          reversalOf: collection.transaction,
          note: `Reversal of ${collection.receiptNumber}. Reason: ${reversalReason}`,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate,
        },
      ],
      { session },
    );

    // ── Step 4: Reversal Ledger entry ──────────────────────────────────────
    // CASE A — collectionLedgerDebitCode SET (agent cash flow):
    //   Original: DR Agent Cash (AGNT-xxx) | CR Pigmy Deposits 2002
    //   Reversal: DR Pigmy Deposits 2002   | CR Agent Cash (AGNT-xxx)
    //
    // CASE B — collectionLedgerDebitCode NULL (legacy):
    //   Original: DR Cash in Hand 1001     | CR Pigmy Deposits 2002
    //   Reversal: DR Pigmy Deposits 2002   | CR Cash in Hand 1001
    const reversalLedgerParams = {
      transactionId: reversalTxn._id,
      transactionRef,
      amountInPaise: collection.amountInPaise,
      customer: collection.customer,
      performedBy: reversedBy,
      businessDate,
      session,
    };

    if (collection.collectionLedgerDebitCode) {
      await ledger.recordAgentCollectionReversal(
        reversalLedgerParams,
        collection.collectionLedgerDebitCode,
      );
    } else {
      await ledger.recordCollectionReversal(reversalLedgerParams);
    }

    // ── Step 5: Mark original Transaction as reversed ──────────────────────
    await Transaction.findByIdAndUpdate(
      collection.transaction,
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

    // ── Step 6: Mark Collection as reversed ───────────────────────────────
    await Collection.findByIdAndUpdate(
      collectionId,
      {
        $set: {
          isReversed: true,
          reversedAt: businessDate,
          reversedBy,
          reversalReason,
          reversalTxnId: reversalTxn._id,
          // C-3 FIX: Use REVERSED not MISSED — reversal ≠ non-collection.
          // MISSED status is reserved for accounts where no agent showed up.
          // Marking a reversal as MISSED inflates missed-day counts and
          // triggers wrong penalty calculations for the agent.
          status: COLLECTION_STATUS.REVERSED,
        },
      },
      { session },
    );
  });

  // ── Step 7: AuditLog (non-critical) ───────────────────────────────────────
  await AuditLog.log({
    performedBy: reversedBy,
    action: AUDIT_ACTIONS.COLLECTION_REVERSED,
    entity: "Collection",
    entityId: collectionId,
    oldData: {
      amountInPaise: collection.amountInPaise,
      receiptNumber: collection.receiptNumber,
    },
    newData: {
      reversalReason,
      reversalTxnId: reversalTxn._id,
      transactionRef,
      balanceAfter: newBalance,
      ledgerCredited: collection.collectionLedgerDebitCode || "1001",
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
    businessDate,
  }).catch((e) => logger.error(`[Collection] AuditLog failed: ${e.message}`));

  logger.warn(
    `[Collection] REVERSED | ${collection.receiptNumber} | ` +
    `₹${(collection.amountInPaise / 100).toFixed(2)} | By: ${reversedBy} | ` +
    `Ledger CR: ${collection.collectionLedgerDebitCode || "1001"}`,
  );

  return {
    message: "Collection reversed successfully.",
    receiptNumber: collection.receiptNumber,
    reversalTxnRef: transactionRef,
    balanceAfterInRupees: (newBalance / 100).toFixed(2),
  };
};
// ═════════════════════════════════════════════════════════════════════════════
// 6. GET DAILY SUMMARY — UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════
const getDailySummary = async (date) => {
  // ── C-5 FIX: Default to AppConfig business date, not wall clock ──────────────
  const _summaryDefaultRaw = date
    ? new Date(date)
    : new Date((await AppConfig.getCurrentBusinessDate()) || Date.now());
  const summaryDate = startOfDay(_summaryDefaultRaw);
  const summaryEnd = endOfDay(_summaryDefaultRaw);

  const [totals, agentBreakdown] = await Promise.all([
    Collection.getDailyTotal(summaryDate),
    Collection.aggregate([
      {
        $match: {
          collectionDate: { $gte: summaryDate, $lte: summaryEnd },
          status: COLLECTION_STATUS.COLLECTED,
          isDeleted: false,
          isReversed: false,
        },
      },
      {
        $group: {
          _id: "$agent",
          totalInPaise: { $sum: "$amountInPaise" },
          totalCollections: { $sum: 1 },
          uniqueCustomers: { $addToSet: "$customer" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "agentInfo",
        },
      },
      {
        $project: {
          agentName: { $arrayElemAt: ["$agentInfo.name", 0] },
          agentCode: { $arrayElemAt: ["$agentInfo.agentCode", 0] },
          totalInPaise: 1,
          totalInRupees: { $divide: ["$totalInPaise", 100] },
          totalCollections: 1,
          uniqueCustomers: { $size: "$uniqueCustomers" },
        },
      },
      { $sort: { totalInPaise: -1 } },
    ]),
  ]);

  return {
    date: toIndianDate(summaryDate),    // C-1 FIX: IST-correct date display
    totalInPaise: totals.totalInPaise,
    totalInRupees: (totals.totalInPaise / 100).toFixed(2),
    totalCollections: totals.count,
    agentBreakdown,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 7. GET MISSED COLLECTIONS — UNCHANGED
// ═════════════════════════════════════════════════════════════════════════════
const getMissedCollections = async ({ date, agentId } = {}) => {
  // ── C-5 FIX: Default to AppConfig business date, not wall clock ──────────────
  const _missedDefaultRaw = date
    ? new Date(date)
    : new Date((await AppConfig.getCurrentBusinessDate()) || Date.now());
  const targetDate = startOfDay(_missedDefaultRaw);
  const targetEnd = endOfDay(_missedDefaultRaw);

  const accountFilter = { status: ACCOUNT_STATUS.ACTIVE, isDeleted: false };
  if (agentId) accountFilter.assignedAgent = agentId;

  const [allAccounts, collectedAccountIds] = await Promise.all([
    PigmyAccount.find(accountFilter)
      .select("accountNumber assignedAgent customer dailyDepositAmountInPaise")
      .populate("customer", "name phone customerCode")
      .lean(),
    Collection.find({
      collectionDate: { $gte: targetDate, $lte: targetEnd },
      isDeleted: false,
      isReversed: false,
      status: COLLECTION_STATUS.COLLECTED,
    }).distinct("pigmyAccount"),
  ]);

  const collectedSet = new Set(collectedAccountIds.map((id) => id.toString()));
  const missed = allAccounts.filter(
    (acc) => !collectedSet.has(acc._id.toString()),
  );

  const totalMissedPaise = missed.reduce(
    (sum, acc) => sum + acc.dailyDepositAmountInPaise,
    0,
  );

  return {
    date: toIndianDate(targetDate),    // C-1 FIX: IST-correct date display
    missedCount: missed.length,
    totalMissedInPaise: totalMissedPaise,
    totalMissedInRupees: (totalMissedPaise / 100).toFixed(2),
    missed: missed.map((acc) => ({
      accountNumber: acc.accountNumber,
      customer: acc.customer,
      dailyDepositAmountInPaise: acc.dailyDepositAmountInPaise,
      dailyDepositAmountInRup: (acc.dailyDepositAmountInPaise / 100).toFixed(2),
    })),
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 8. AGENT-WISE COLLECTION REPORT
// Aggregates collections by agent for a date range.
// Optionally filter by a single agentId.
// Returns: per-agent total, count, customer count, daily breakdown.
// ═════════════════════════════════════════════════════════════════════════════
const { toObjId } = require("../utils/dateHelpers");

const getAgentWiseReport = async ({ fromDate, toDate, agentId } = {}) => {
  // Validate required date params upfront.
  // new Date(undefined) silently creates an Invalid Date, causing wrong MongoDB queries.
  if (!fromDate || !toDate) {
    throw ApiError.badRequest("fromDate and toDate are required for the agent-wise report.");
  }
  const from = startOfDay(new Date(fromDate));
  const to = endOfDay(new Date(toDate));

  const matchStage = {
    collectionDate: { $gte: from, $lte: to },
    isDeleted: false,
    isReversed: false,
    status: COLLECTION_STATUS.COLLECTED,
  };
  if (agentId) matchStage.agent = toObjId(agentId, "agentId");

  const agentTotals = await Collection.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$agent",
        totalInPaise: { $sum: "$amountInPaise" },
        totalCollections: { $sum: 1 },
        uniqueCustomers: { $addToSet: "$customer" },
        uniqueAccounts: { $addToSet: "$pigmyAccount" },
        firstDate: { $min: "$collectionDate" },
        lastDate: { $max: "$collectionDate" },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "agentInfo",
      },
    },
    {
      $project: {
        agentId: "$_id",
        agentName: { $arrayElemAt: ["$agentInfo.name", 0] },
        agentCode: { $arrayElemAt: ["$agentInfo.agentCode", 0] },
        agentPhone: { $arrayElemAt: ["$agentInfo.phone", 0] },
        totalInPaise: 1,
        totalInRupees: { $round: [{ $divide: ["$totalInPaise", 100] }, 2] },
        totalCollections: 1,
        uniqueCustomerCount: { $size: "$uniqueCustomers" },
        uniqueAccountCount: { $size: "$uniqueAccounts" },
        firstDate: 1,
        lastDate: 1,
      },
    },
    { $sort: { totalInPaise: -1 } },
  ]);

  const grandTotal = agentTotals.reduce(
    (acc, a) => {
      acc.totalInPaise += a.totalInPaise;
      acc.totalCollections += a.totalCollections;
      return acc;
    },
    { totalInPaise: 0, totalCollections: 0 },
  );

  return {
    fromDate: toIndianDate(from),
    toDate: toIndianDate(to),
    agentCount: agentTotals.length,
    grandTotalInPaise: grandTotal.totalInPaise,
    grandTotalInRupees: (grandTotal.totalInPaise / 100).toFixed(2),
    grandTotalCollections: grandTotal.totalCollections,
    agents: agentTotals,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  recordCollection,
  reverseCollection,
  getCollection,
  listCollections,
  getAgentDailySheet,
  getDailySummary,
  getMissedCollections,
  getAgentWiseReport,
};
