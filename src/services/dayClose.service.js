// src/services/dayClose.service.js

"use strict";

const AppConfig = require("../models/AppConfig.model");
const BusinessDay = require("../models/BusinessDay.model");
const Institution = require("../models/Institution.model");
const LedgerEntry = require("../models/LedgerEntry.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const Collection = require("../models/Collection.model");
const AuditLog = require("../models/AuditLog.model");
const User = require("../models/User.model");
const ApiError = require("../utils/ApiError");
const withTransaction = require("../utils/withTransaction");
const logger = require("../utils/logger");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");
const {
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  DAY_STATUS,
  LOAN_STATUS,
  CONFIG_KEYS,
  ROLES,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// EOD JOB IMPORTS — event-driven execution on Day Close
// Order: MissedDay → Penalty → DeficitWarning → Reconcile
// ─────────────────────────────────────────────────────────────────────────────
const { runMissedDayTrackingJob } = require("../jobs/missedDayTracking.job");
const { runPenaltyAndOverdueJob } = require("../jobs/penaltyAndOverdue.job");
const { runDeficitWarningJob } = require("../jobs/deficitWarning.job");
const { runReconcileJob } = require("../jobs/reconcile.job");

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPER — verify superadmin’s own password for sensitive operations.
// This is a second-factor check: the user is already JWT-authenticated.
// We re-fetch their password hash from MongoDB to guard against stolen-token
// attacks where attacker has the JWT but not the actual account password.
// ─────────────────────────────────────────────────────────────────────────────
const _verifyAdminPassword = async (userId, plainPassword) => {
  const bcrypt = require("bcrypt");
  const user = await User.findById(userId)
    .select("+password")
    .setOptions({ _skipDeletedFilter: true })
    .lean();
  if (!user) throw new ApiError(404, "Authenticated user record not found.");
  if (!user.password) throw new ApiError(500, "No password hash stored for this user.");
  const isMatch = await bcrypt.compare(plainPassword, user.password);
  return { isMatch };
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. OPEN DAY
// Parameters:
//   openedBy           — ObjectId of the performing user (from req.user._id)
//   ipAddress          — from req.ip
//   requestId          — from req.id
//   backdate           — Optional ISO date "YYYY-MM-DD" (superadmin only)
//   backdatePassword   — Required with backdate: superadmin’s own password
//   performingUserRole — ROLES value from req.user.role (passed from controller)
// ─────────────────────────────────────────────────────────────────────────────
const openDay = async ({
  openedBy,
  ipAddress,
  requestId,
  backdate = null,
  backdatePassword = null,
  catchupMode = false,
  performingUserRole,
}) => {
  const isBackdateMode = !!backdate;
  const isLocked = await AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED);
  if (isLocked) {
    throw new ApiError(
      503,
      "SYSTEM LOCKED. Reconcile job detected ledger balance mismatches. " +
      "Superadmin must investigate and unlock via config before day can be opened.",
    );
  }

  // ── BACKDATE PATH ─────────────────────────────────────────────────────────
  // Entirely separate from the normal path so normal open is ZERO-risk regression.
  if (isBackdateMode) {
    // Guard 1: role
    if (performingUserRole !== ROLES.SUPERADMIN) {
      throw new ApiError(403, "Backdating requires SUPERADMIN role.");
    }
    // Guard 2: password presence
    if (!backdatePassword || !backdatePassword.trim()) {
      throw new ApiError(400, "backdatePassword is required when backdate is supplied.");
    }
    // Guard 3: date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(backdate)) {
      throw new ApiError(400, "backdate must be in YYYY-MM-DD format.");
    }
    // Guard 4: must be a past date
    const targetDate = startOfDay(new Date(backdate));
    const serverToday = startOfDay(new Date());
    if (targetDate >= serverToday) {
      throw new ApiError(
        400,
        `Backdate target (${backdate}) must be in the past. Use normal Day Open for today.`,
      );
    }
    // Guard 5: day must currently be closed
    const bdCurrentStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
    if (bdCurrentStatus === DAY_STATUS.OPEN) {
      throw new ApiError(400, "Day is already open. Close it before opening a backdated day.");
    }

    // ── Pre-flight check: Target date cannot be before system genesis date ────
    // Institution.getInstance() is the canonical source for systemGenesisDate.
    // AppConfig.SYSTEM_GENESIS_DATE is deprecated — do not read from there.
    const institution = await Institution.getInstance();
    let genesisDate = institution.systemGenesisDate;

    if (!genesisDate) {
      // Genesis date not yet configured by the dev user.
      // Fall back to the earliest BusinessDay record if one exists,
      // so backdating is not accidentally blocked on a fresh deployment.
      const earliestDay = await BusinessDay.findOne().sort({ businessDate: 1 }).lean();
      if (earliestDay) {
        genesisDate = earliestDay.businessDate;
        // Auto-populate Institution with the derived genesis date
        await Institution.updateConfig({ systemGenesisDate: genesisDate }, openedBy);
        logger.warn(
          `[DayOpen] systemGenesisDate was not configured. ` +
          `Auto-derived from first BusinessDay record: ${genesisDate.toISOString()}. ` +
          "Please configure it via the Dev Panel.",
        );
      } else {
        // Absolute first open — no genesis date, no historical records.
        // Allow the open; genesis will be set by the dev panel.
        logger.info("[DayOpen] No systemGenesisDate configured and no BusinessDay records. Allowing first open.");
        genesisDate = null;
      }
    }

    if (genesisDate && new Date(targetDate) < startOfDay(new Date(genesisDate))) {
      throw new ApiError(
        422,
        `Cannot backdate before the system genesis date (${new Date(genesisDate).toLocaleDateString("en-IN")}). ` +
        "Contact the software vendor (Dev) to update the genesis date if this is a migration.",
      );
    }

    // ── Second-factor password verification ──────────────────────────────────
    let passwordVerified = false;
    try {
      const { isMatch } = await _verifyAdminPassword(openedBy, backdatePassword.trim());
      passwordVerified = isMatch;
    } catch (verifyErr) {
      logger.error(`[DayOpen] Backdate password verify error: ${verifyErr.message}`);
      throw new ApiError(500, "Password verification failed. Try again.");
    }

    if (!passwordVerified) {
      await AuditLog.log({
        performedBy: openedBy,
        action: AUDIT_ACTIONS.BACKDATE_AUTH_FAILED,
        entity: "AppConfig",
        entityId: null,
        newData: { attemptedBackdate: backdate, serverTime: new Date().toISOString() },
        ipAddress,
        requestId,
        status: AUDIT_STATUS.FAILURE,
      }).catch((e) => logger.error(`[DayOpen] BACKDATE_AUTH_FAILED audit error: ${e.message}`));

      logger.warn(
        `[DayControl] BACKDATE AUTH FAILED | By: ${openedBy} | Target: ${backdate} | IP: ${ipAddress}`,
      );
      throw new ApiError(401, "Incorrect password. Backdating requires your superadmin account password.");
    }

    // ── EOD DOUBLE-CHARGE GUARD (banking standard — prevents phantom penalties) ─
    // If catch-up is requested but EOD was already applied for this date
    // (e.g., it was closed normally before, or already caught-up), auto-downgrade
    // to CORRECTION mode. NEVER allow double EOD — this is the #1 financial risk.
    if (catchupMode) {
      const eodAlreadyApplied = await BusinessDay.hasEodBeenApplied(targetDate);
      if (eodAlreadyApplied) {
        logger.warn(
          `[DayControl] CATCHUP DOWNGRADED TO CORRECTION — EOD already applied for ${backdate}. ` +
          `By: ${openedBy} | IP: ${ipAddress}`,
        );
        catchupMode = false; // eslint-disable-line no-param-reassign
      }
    }

    // ── CATCH-UP: Sequential date guard (RBI/NBFC-MFI banking standard) ────────
    // Missed days must be processed in strict calendar order.
    // Cannot jump from Apr 18 to Apr 21 — must go 19 > 20 > 21 one at a time.
    if (catchupMode) {
      const lastDateStr = await AppConfig.getValue(CONFIG_KEYS.CURRENT_BUSINESS_DATE);
      if (lastDateStr) {
        const lastClosed   = startOfDay(new Date(lastDateStr));
        const expectedNext = new Date(lastClosed.getTime() + 86_400_000);
        if (targetDate.getTime() !== expectedNext.getTime()) {
          throw new ApiError(
            400,
            `Catch-up requires sequential dates (banking standard). ` +
            `Last processed: ${lastClosed.toLocaleDateString("en-IN")}. ` +
            `Next allowed: ${expectedNext.toLocaleDateString("en-IN")}. ` +
            `Requested: ${targetDate.toLocaleDateString("en-IN")}. ` +
            `Process each missed day in order.`,
          );
        }
      }
    }

    // ── Determine open mode string for BusinessDay record ────────────────────
    const openMode = catchupMode ? "CATCHUP" : "CORRECTION";
    const dateFormatted = backdate; // already YYYY-MM-DD

    // ── Atomic write (crash-safe bulkWrite) ──────────────────────────────────
    const bdBulk = await AppConfig.bulkWrite(
      [
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.DAY_STATUS, value: DAY_STATUS.CLOSED },
            update: { $set: { value: DAY_STATUS.OPEN, updatedBy: openedBy } },
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.CURRENT_BUSINESS_DATE },
            update: { $set: { value: targetDate.toISOString(), updatedBy: openedBy } },
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED },
            update: { $set: { value: true, updatedBy: openedBy } },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.IS_CATCHUP_MODE },
            update: { $set: { value: catchupMode, updatedBy: openedBy } },
            upsert: true,
          },
        },
      ],
      { ordered: true },
    );

    if (bdBulk.modifiedCount < 1) {
      const recheck = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
      if (recheck === DAY_STATUS.OPEN) {
        throw new ApiError(400, "Day was just opened by another session. Refresh.");
      }
      throw new ApiError(500, "Backdate open failed — concurrent modification. Retry.");
    }

    // ── Create BusinessDay record (upsert — correction day may reopen same date) ─
    await BusinessDay.findOneAndUpdate(
      { businessDate: targetDate },
      {
        $set: {
          businessDateFormatted: dateFormatted,
          status: "OPEN",
          openedBy,
          openedAt: new Date(),
          openMode,
          eodStatus: "PENDING",
          isImmutable: false,
          isForceClose: false,
          closedBy: null,
          closedAt: null,
          eodAppliedAt: null,
          eodSkipReason: null,
          note: catchupMode
            ? "Catch-up: Superadmin opening missed business day. EOD will run on close."
            : "Correction: Superadmin opened past date for ledger fix. EOD skipped on close.",
        },
        $setOnInsert: {
          summary: {},
          eodResults: {},
        },
      },
      { upsert: true, new: true },
    );

    // ── Audit log — distinct action for catch-up vs correction ───────────────
    await AuditLog.log({
      performedBy: openedBy,
      action: catchupMode ? AUDIT_ACTIONS.DAY_OPENED_CATCHUP : AUDIT_ACTIONS.DAY_OPENED_BACKDATED,
      entity: "BusinessDay",
      entityId: null,
      newData: {
        dayStatus: DAY_STATUS.OPEN,
        targetBackdate: backdate,
        targetBusinessDate: targetDate.toISOString(),
        catchupMode,
        openMode,
        serverTimeWhenExecuted: new Date().toISOString(),
        note: catchupMode
          ? "Catch-up: Superadmin opening missed business day. EOD jobs will run on close."
          : "Correction: Superadmin opened past date for ledger fix. EOD skipped on close.",
      },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.SUCCESS,
    }).catch((e) => logger.error(`[DayOpen] Backdate/Catchup AuditLog failed: ${e.message}`));

    const modeLabel = catchupMode ? "CATCH-UP" : "CORRECTION";
    logger.warn(
      `[DayControl] ${modeLabel} DAY OPENED | Target: ${backdate} | ` +
      `Server: ${new Date().toLocaleDateString("en-IN")} | By: ${openedBy} | IP: ${ipAddress}`,
    );

    const modeMsg = catchupMode
      ? `Catch-up day opened for ${targetDate.toLocaleDateString("en-IN")}. ` +
        `Record any missed transactions, then close. Penalty and missed-day charges will apply on close.`
      : `Correction day opened for ${targetDate.toLocaleDateString("en-IN")}. ` +
        `Ledger corrections only — EOD jobs will be skipped on close.`;

    return {
      message: modeMsg,
      dayStatus: DAY_STATUS.OPEN,
      businessDate: targetDate,
      isBackdated: true,
      isCatchupMode: catchupMode,
      openMode,
      targetBackdate: backdate,
    };
  }
  // ── END BACKDATE PATH — Normal open continues below ──────────────────────

  const [currentStatus, lastBusinessDateStr] = await Promise.all([
    AppConfig.getValue(CONFIG_KEYS.DAY_STATUS),
    AppConfig.getValue(CONFIG_KEYS.CURRENT_BUSINESS_DATE),
  ]);

  const isFirstRun = !currentStatus;

  if (currentStatus === DAY_STATUS.OPEN) {
    throw new ApiError(400, "Day is already open. Transactions are permitted.");
  }

  const today = startOfDay(new Date());

  if (!isFirstRun && lastBusinessDateStr) {
    const lastDate = startOfDay(new Date(lastBusinessDateStr));

    if (today.getTime() === lastDate.getTime()) {
      throw new ApiError(
        400,
        `Cannot reopen day for ${today.toLocaleDateString("en-IN")}. ` +
        `This date was already closed. Business date must move forward.`,
      );
    }

    if (today < lastDate) {
      throw new ApiError(
        400,
        `Server clock appears to be in the past. ` +
        `Last business date: ${lastDate.toLocaleDateString("en-IN")} | ` +
        `Server date: ${today.toLocaleDateString("en-IN")}. ` +
        `Check server time before opening day.`,
      );
    }
  }

  // ── ISSUE-10 FIX: Warn if previous day was force-closed on imbalanced ledger ─
  // This check is non-blocking — it never prevents day open.
  // Purpose: operators must always know when prior-day books are unreconciled
  // before they accept new transactions. The warning surfaces in application logs
  // where the ops team monitors for [CRITICAL] prefixed lines.
  // ─────────────────────────────────────────────────────────────────────────────
  if (!isFirstRun) {
    try {
      const lastCloseAudit = await AuditLog.findOne({
        action: AUDIT_ACTIONS.DAY_CLOSED,
      })
        .sort({ createdAt: -1 })
        .lean();

      if (lastCloseAudit?.newData?.ledgerIntegrity === "IMBALANCED (force closed)") {
        const prevDate = lastCloseAudit.newData?.businessDate
          ? new Date(lastCloseAudit.newData.businessDate).toLocaleDateString("en-IN")
          : "unknown date";
        const diffRupees = (
          (lastCloseAudit.newData?.ledgerDifferenceInPaise || 0) / 100
        ).toFixed(2);

        logger.error(
          `[DayOpen] ⚠️  CRITICAL WARNING: Previous business day (${prevDate}) was ` +
          `FORCE-CLOSED with an IMBALANCED ledger. ` +
          `Difference: ₹${diffRupees}. ` +
          `Investigate and post a correcting Journal Voucher BEFORE recording any new transactions. ` +
          `Proceeding without correction will compound the imbalance.`,
        );
      }
    } catch (warnErr) {
      // Never block day open due to this check failing — log and continue.
      logger.warn(`[DayOpen] Could not check previous-day ledger integrity: ${warnErr.message}`);
    }
  }

  // ── Atomic dual-write ────────────────────────────────────────────

  // OLD: two separate findOneAndUpdate calls — if server crashed between them,
  //      DAY_STATUS=OPEN but CURRENT_BUSINESS_DATE was still yesterday.
  //      Every transaction would be stamped with the wrong business date.
  //
  // NEW: bulkWrite with ordered:true — MongoDB executes both ops in document order.
  //      If the first op fails (another session already opened the day), bulkWrite
  //      throws and the second op never runs — no partial state possible.
  //      If both succeed the day is open with the correct date in a single round-trip.
  // ────────────────────────────────────────────────────────────────────────────

  let updated;

  if (isFirstRun) {
    // First ever run — no DAY_STATUS doc yet, so insert both atomically.
    const firstRunResult = await AppConfig.bulkWrite(
      [
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.DAY_STATUS },
            update: {
              $set: { value: DAY_STATUS.OPEN, updatedBy: openedBy },
              $setOnInsert: { key: CONFIG_KEYS.DAY_STATUS, description: "Day open/close status" },
            },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.CURRENT_BUSINESS_DATE },
            update: {
              $set: { value: today.toISOString(), updatedBy: openedBy },
              $setOnInsert: { key: CONFIG_KEYS.CURRENT_BUSINESS_DATE, description: "Current business date" },
            },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED },
            update: { $set: { value: false, updatedBy: openedBy } },
            upsert: true,
          },
        },
        // NOTE: SYSTEM_GENESIS_DATE is no longer managed via AppConfig.
        // It now lives in Institution.model.js. See Institution.updateConfig().
      ],
      { ordered: true }, // ordered:true = stop on first failure
    );
    updated = firstRunResult.ok === 1;
  } else {
    // Normal daily open — status must be CLOSED to proceed (prevents double-open).
    // Both writes in one bulkWrite — crash-safe.
    const bulkResult = await AppConfig.bulkWrite(
      [
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.DAY_STATUS, value: DAY_STATUS.CLOSED },
            update: { $set: { value: DAY_STATUS.OPEN, updatedBy: openedBy } },
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.CURRENT_BUSINESS_DATE },
            update: { $set: { value: today.toISOString(), updatedBy: openedBy } },
          },
        },
        {
          updateOne: {
            filter: { key: CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED },
            update: { $set: { value: false, updatedBy: openedBy } },
            upsert: true,
          },
        },
      ],
      { ordered: true }, // ordered:true = if status update fails, date is never changed
    );

    updated = bulkResult.modifiedCount >= 1;

    if (!updated) {
      // Status op matched 0 docs — either already OPEN or some unexpected state
      const recheckStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
      if (recheckStatus === DAY_STATUS.OPEN) {
        throw new ApiError(
          400,
          "Day was just opened by another session. Refresh the page.",
        );
      }
      throw new ApiError(
        500,
        "Could not open day. Concurrent modification detected. Retry.",
      );
    }
  }

  // ── Create BusinessDay record for this normal day ───────────────────────
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(today.getTime() + IST_OFFSET_MS);
  const todayFormatted = `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}-${String(istDate.getUTCDate()).padStart(2, '0')}`;

  await BusinessDay.findOneAndUpdate(
    { businessDate: today },
    {
      $set: {
        businessDateFormatted: todayFormatted,
        status: "OPEN",
        openedBy,
        openedAt: new Date(),
        openMode: "NORMAL",
        eodStatus: "PENDING",
        isImmutable: false,
        isForceClose: false,
        closedBy: null,
        closedAt: null,
        eodAppliedAt: null,
        eodSkipReason: null,
        note: isFirstRun ? "First-ever business day" : null,
      },
      $setOnInsert: {
        summary: {},
        eodResults: {},
      },
    },
    { upsert: true, new: true },
  );

  await AuditLog.log({
    performedBy: openedBy,
    action: AUDIT_ACTIONS.DAY_OPENED,
    entity: "BusinessDay",
    entityId: null,
    newData: { dayStatus: DAY_STATUS.OPEN, businessDate: today, isFirstRun },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[DayOpen] AuditLog failed: ${e.message}`));

  logger.info(
    `[DayControl] DAY OPENED | Date: ${today.toLocaleDateString("en-IN")} | ` +
    `${isFirstRun ? "(First Run) " : ""}By: ${openedBy}`,
  );

  return {
    message: "Day opened. Transactions are now permitted.",
    dayStatus: DAY_STATUS.OPEN,
    businessDate: today,
    openMode: "NORMAL",
    isFirstRun,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLOSE DAY
// ─────────────────────────────────────────────────────────────────────────────
const closeDay = async ({
  closedBy,
  ipAddress,
  requestId,
  forceClose = false,
}) => {
  // ── Guard: Must be open ───────────────────────────────────────────────────
  const currentStatus = await AppConfig.getValue(CONFIG_KEYS.DAY_STATUS);
  if (currentStatus !== DAY_STATUS.OPEN) {
    throw new ApiError(400, "Day is not open. Nothing to close.");
  }

  const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
  if (!rawBusinessDate) {
    throw new ApiError(500, "Business date not set. Cannot close day.");
  }
  // P2-MED-2: Normalize to IST start-of-day for consistent audit timestamps.
  const businessDate = startOfDay(new Date(rawBusinessDate));

  // ── Pre-close check 1: Ledger integrity ───────────────────────────────────
  const integrityResult = await LedgerEntry.verifyIntegrity(
    new Date(businessDate),
  );

  if (!integrityResult.isBalanced) {
    logger.error(
      `[DayClose] LEDGER IMBALANCE | ` +
      `DR: ₹${(integrityResult.totalDebitsInPaise / 100).toFixed(2)} ≠ ` +
      `CR: ₹${(integrityResult.totalCreditsInPaise / 100).toFixed(2)} | ` +
      `Diff: ₹${(integrityResult.differenceInPaise / 100).toFixed(2)} | ` +
      `forceClose: ${forceClose}`,
    );

    await AuditLog.log({
      performedBy: closedBy,
      action: AUDIT_ACTIONS.RECONCILIATION_BREACH,
      entity: "LedgerEntry",
      entityId: null,
      newData: integrityResult,
      ipAddress,
      requestId,
      status: "failure",
      errorMessage: `Ledger imbalance: ${integrityResult.differenceInPaise} paise`,
    }).catch((e) => logger.error(`[DayClose] AuditLog failed: ${e.message}`));

    if (!forceClose) {
      throw new ApiError(
        500,
        `CRITICAL: Day close BLOCKED. Ledger is imbalanced. ` +
        `Difference: ₹${(integrityResult.differenceInPaise / 100).toFixed(2)}. ` +
        `Fix all transactions before closing, ` +
        `or use forceClose:true to override (will be logged).`,
      );
    }

    logger.warn(
      `[DayClose] FORCE CLOSE used on imbalanced ledger | ` +
      `Diff: ₹${(integrityResult.differenceInPaise / 100).toFixed(2)} | By: ${closedBy}`,
    );
  }

  // ── Pre-close check 2: Agent cash balance check ───────────────────────────
  const unsettledAgents = await LedgerAccount.find({
    isAgentAccount: true,
    runningBalanceInPaise: { $gt: 0 },
    isActive: true,
  })
    .populate("agentRef", "name agentCode phone")
    .lean();

  if (unsettledAgents.length > 0) {
    const totalUnsettledInPaise = unsettledAgents.reduce(
      (sum, a) => sum + a.runningBalanceInPaise,
      0,
    );

    const agentList = unsettledAgents
      .map(
        (a) =>
          `${a.agentRef?.agentCode || a.code} (${a.agentRef?.name || "Unknown"}): ` +
          `₹${(a.runningBalanceInPaise / 100).toFixed(2)}`,
      )
      .join(" | ");

    logger.warn(
      `[DayClose] BLOCKED — ${unsettledAgents.length} agent(s) have outstanding cash | ` +
      `Total: ₹${(totalUnsettledInPaise / 100).toFixed(2)} | ${agentList}`,
    );

    if (!forceClose) {
      throw new ApiError(
        400,
        `Day close BLOCKED. ${unsettledAgents.length} agent(s) have not deposited all collected cash. ` +
        `Total outstanding: ₹${(totalUnsettledInPaise / 100).toFixed(2)}. ` +
        `Agents: ${agentList}. ` +
        `All agents must deposit collected cash before day close. ` +
        `If agent is unreachable, use forceClose:true (incident will be logged).`,
      );
    }

    // forceClose override — critical incident logged, day close proceeds
    logger.error(
      `[DayClose] ⚠️ FORCE CLOSE — ${unsettledAgents.length} UNSETTLED AGENT(S) | ` +
      `Total unrecovered: ₹${(totalUnsettledInPaise / 100).toFixed(2)} | ` +
      `Agents: ${agentList} | By: ${closedBy}`,
    );

    await AuditLog.log({
      performedBy: closedBy,
      action: AUDIT_ACTIONS.FORCE_CLOSE_UNSETTLED_AGENTS,
      entity: "LedgerAccount",
      entityId: null,
      newData: {
        unsettledAgents: unsettledAgents.map((a) => ({
          agentCode: a.agentRef?.agentCode,
          name: a.agentRef?.name,
          phone: a.agentRef?.phone,
          unsettledAmountInPaise: a.runningBalanceInPaise,
        })),
        totalUnsettledInPaise,
        businessDate,
        forcedBy: closedBy,
      },
      ipAddress,
      requestId,
      status: "force_override",
      errorMessage: `Force close with ${unsettledAgents.length} unsettled agent(s). Manual reconciliation required.`,
    }).catch((e) =>
      logger.error(`[DayClose] Force close AuditLog failed: ${e.message}`),
    );
  }

  // ── Steps 3 & 4: Overdue transition + Status change — ATOMIC ─────────────

  let newOverdueCount = 0;
  let updated;

  await withTransaction(async (session) => {
    // Step 3: ACTIVE → OVERDUE loan transition (inside session)

    const overdueTransitionResult = await LoanAccount.updateMany(
      {
        status: LOAN_STATUS.ACTIVE,
        maturityDate: { $lte: endOfDay(new Date(businessDate)) },
        outstandingBalanceInPaise: { $gt: 0 },
        isDeleted: false,
      },
      { $set: { status: LOAN_STATUS.OVERDUE } },
      { session },
    );

    newOverdueCount = overdueTransitionResult.modifiedCount;

    if (newOverdueCount > 0) {
      logger.warn(
        `[DayClose] ${newOverdueCount} loan(s) transitioning ACTIVE → OVERDUE | ` +
        `BusinessDate: ${new Date(businessDate).toLocaleDateString("en-IN")}`,
      );
    }

    // Step 4: Atomic status change — OPEN → CLOSED (inside SAME session)
    updated = await AppConfig.findOneAndUpdate(
      { key: CONFIG_KEYS.DAY_STATUS, value: DAY_STATUS.OPEN },
      { $set: { value: DAY_STATUS.CLOSED, updatedBy: closedBy } },
      { returnDocument: "after", session },
    );

    if (!updated) {
      // Throws inside the transaction → entire transaction aborts
      // → overdue transition rolls back automatically — no inconsistency
      // Use session-scoped findOne so the recheck reads within
      // the same transaction snapshot instead of potentially reading stale data.
      const recheckDoc = await AppConfig.findOne({ key: CONFIG_KEYS.DAY_STATUS }).session(session);
      const recheckStatus = recheckDoc?.value;
      if (recheckStatus === DAY_STATUS.CLOSED) {
        throw new ApiError(
          400,
          "Day was already closed by another session. Refresh the page.",
        );
      }
      throw new ApiError(
        500,
        "Could not close day. Concurrent modification detected. Retry.",
      );
    }
  });

  // ── Step 5: Summary snapshot (after transaction commits) ─────────────────
  const [collectionTotals, overdueCount] = await Promise.all([
    Collection.getDailyTotal(new Date(businessDate)),
    LoanAccount.countDocuments({
      status: LOAN_STATUS.OVERDUE,
      isDeleted: false,
    }),
  ]);

  const daySummary = {
    businessDate,
    ledgerIntegrity: integrityResult.isBalanced
      ? "BALANCED"
      : "IMBALANCED (force closed)",
    ledgerDifferenceInPaise: integrityResult.differenceInPaise || 0,
    collections: {
      count: collectionTotals.count,
      totalInPaise: collectionTotals.totalInPaise,
      totalInRupees: (collectionTotals.totalInPaise / 100).toFixed(2),
      totalRepaidInPaise: collectionTotals.totalRepaidInPaise,
      totalRepaidInRupees: (collectionTotals.totalRepaidInPaise / 100).toFixed(
        2,
      ),
    },
    loans: {
      totalOverdueCount: overdueCount,
      newOverdueTodayCount: newOverdueCount,
    },
    agents: {
      unsettledCount: unsettledAgents.length,
      totalUnsettledInPaise: unsettledAgents.reduce(
        (sum, a) => sum + a.runningBalanceInPaise,
        0,
      ),
      note:
        unsettledAgents.length === 0
          ? "All agents confirmed cleared before day close."
          : `FORCE CLOSE: ${unsettledAgents.length} agent(s) not settled — manual reconciliation required.`,
    },
  };

  await AuditLog.log({
    performedBy: closedBy,
    action: AUDIT_ACTIONS.DAY_CLOSED,
    entity: "AppConfig",
    entityId: null,
    newData: daySummary,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[DayClose] AuditLog failed: ${e.message}`));

  logger.info(
    `[DayControl] DAY CLOSED | ` +
    `Date: ${new Date(businessDate).toLocaleDateString("en-IN")} | ` +
    `Collections: ${daySummary.collections.count} | ` +
    `Total: ₹${daySummary.collections.totalInRupees} | ` +
    `Loan Repaid: ₹${daySummary.collections.totalRepaidInRupees} | ` +
    `Overdue Loans: ${overdueCount} (${newOverdueCount} new today) | ` +
    `By: ${closedBy}`,
  );

  // ── Step 6: EVENT-DRIVEN EOD PROCESSING ──────────────────────────────────
  // Decision matrix (two flags read together):
  //
  //  isBackdated | isCatchupMode | shouldRunEod | Reason
  //  ------------|---------------|--------------|------------------------------------
  //  false       | false         | YES          | Normal business day
  //  true        | true          | YES          | Catch-up: missed day, run charges
  //  true        | false         | NO           | Correction: ledger fix, skip EOD
  //
  // Penalty/missed-day jobs are idempotent per (loanId, businessDate) — safe
  // to run on catch-up days without risk of double-charging.
  // ─────────────────────────────────────────────────────────────────────────
  const [isBackdated, isCatchupMode] = await Promise.all([
    AppConfig.getValue(CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED),
    AppConfig.getValue(CONFIG_KEYS.IS_CATCHUP_MODE),
  ]);
  const shouldRunEod = !isBackdated || isCatchupMode;
  const eodResults = {};

  // ── Zero-collection warning (for catch-up days) ───────────────────────────
  // If no collections were recorded for this catch-up date, missed-day tracking
  // will mark ALL active loans as missed — which is the correct banking behavior.
  // We surface this in the response so the frontend can show a confirmation prompt.
  let zeroCollectionWarning = null;
  if (isCatchupMode) {
    const collectionCount = await Collection.countDocuments({
      businessDate: { $gte: startOfDay(new Date(businessDate)), $lte: endOfDay(new Date(businessDate)) },
    });
    if (collectionCount === 0) {
      zeroCollectionWarning = {
        message: "No collections were recorded for this date. All active loan pigmy accounts will be marked as MISSED for this day — this is correct banking behavior for a day with no collections.",
        collectionsFound: 0,
      };
      logger.warn(
        `[DayClose] CATCH-UP: Zero collections on ${new Date(businessDate).toLocaleDateString("en-IN")}. ` +
        `All active loans will be marked missed.`,
      );
    }
  }

  if (!shouldRunEod) {
    logger.info(
      `[DayClose] Correction backdate — EOD skipped. ` +
      `Date: ${new Date(businessDate).toLocaleDateString("en-IN")}`,
    );
    eodResults.skipped = true;
    eodResults.reason = "correction_backdate";
  } else {
    const modeLabel = isCatchupMode ? "CATCH-UP" : "normal";
    logger.info(
      `[DayClose] Running EOD jobs (${modeLabel}) for ` +
      `${new Date(businessDate).toLocaleDateString("en-IN")}...`,
    );

    // Job 1: Missed-Day Tracking (must run FIRST — increments businessDaysElapsed)
    try {
      eodResults.missedDayTracking = await runMissedDayTrackingJob();
      logger.info("[DayClose] EOD Job 1/4: Missed-day tracking completed.");
    } catch (err) {
      logger.error(`[DayClose] EOD Job 1/4 FAILED (missedDayTracking): ${err.message}`);
      eodResults.missedDayTracking = { error: err.message };
    }

    // Job 2: Penalty & Overdue Marking
    try {
      eodResults.penaltyAndOverdue = await runPenaltyAndOverdueJob();
      logger.info("[DayClose] EOD Job 2/4: Penalty & overdue completed.");
    } catch (err) {
      logger.error(`[DayClose] EOD Job 2/4 FAILED (penaltyAndOverdue): ${err.message}`);
      eodResults.penaltyAndOverdue = { error: err.message };
    }

    // Job 3: Deficit Warning
    try {
      eodResults.deficitWarning = await runDeficitWarningJob();
      logger.info("[DayClose] EOD Job 3/4: Deficit warning completed.");
    } catch (err) {
      logger.error(`[DayClose] EOD Job 3/4 FAILED (deficitWarning): ${err.message}`);
      eodResults.deficitWarning = { error: err.message };
    }

    // Job 4: Ledger Reconciliation
    try {
      eodResults.reconcile = await runReconcileJob();
      logger.info("[DayClose] EOD Job 4/4: Reconciliation completed.");
    } catch (err) {
      logger.error(`[DayClose] EOD Job 4/4 FAILED (reconcile): ${err.message}`);
      eodResults.reconcile = { error: err.message };
    }

    logger.info(`[DayClose] All EOD jobs finished (${modeLabel}).`);
  }

  // ── Update BusinessDay record (write summary + eod results + lock) ───────
  await BusinessDay.findOneAndUpdate(
    { businessDate: startOfDay(new Date(businessDate)), status: "OPEN" },
    {
      $set: {
        status: "CLOSED",
        closedBy,
        closedAt: new Date(),
        isForceClose: forceClose,
        "summary.totalCollectionsCount": daySummary.collections.count,
        "summary.totalCollectedInPaise": daySummary.collections.totalInPaise,
        "summary.totalLoanRepaidInPaise": daySummary.collections.totalRepaidInPaise,
        "summary.newOverdueLoanCount": daySummary.loans.newOverdueTodayCount,
        "summary.totalOverdueLoanCount": daySummary.loans.totalOverdueCount,
        "summary.unsettledAgentCount": daySummary.agents.unsettledCount,
        "summary.totalUnsettledInPaise": daySummary.agents.totalUnsettledInPaise,
        "summary.ledgerIntegrity": daySummary.ledgerIntegrity,
        "summary.ledgerDifferenceInPaise": daySummary.ledgerDifferenceInPaise,
        eodStatus: shouldRunEod ? "COMPLETED" : "SKIPPED",
        eodAppliedAt: shouldRunEod ? new Date() : null,
        eodSkipReason: !shouldRunEod ? "correction_backdate" : null,
        "eodResults.missedDayTracking": eodResults.missedDayTracking || null,
        "eodResults.penaltyAndOverdue": eodResults.penaltyAndOverdue || null,
        "eodResults.deficitWarning": eodResults.deficitWarning || null,
        "eodResults.reconcile": eodResults.reconcile || null,
        isImmutable: true, // Banking compliance: locked after close
      },
    },
    { new: true }
  ).catch((err) => {
    logger.error(`[DayClose] Failed to update BusinessDay record: ${err.message}`);
  });

  // ── Reset IS_CATCHUP_MODE after every close (regardless of mode) ──────────
  await AppConfig.setValue(CONFIG_KEYS.IS_CATCHUP_MODE, false)
    .catch((e) => logger.error(`[DayClose] Failed to reset IS_CATCHUP_MODE: ${e.message}`));

  const closeMsgNormal  = "Day closed. All end-of-day processing completed.";
  const closeMsgCatchup = `Catch-up day closed for ${new Date(businessDate).toLocaleDateString("en-IN")}. Penalty and missed-day charges applied.`;
  const closeMsgCorrect = "Correction day closed. EOD jobs skipped (ledger correction only).";

  const closeMessage = !isBackdated ? closeMsgNormal
    : isCatchupMode ? closeMsgCatchup
    : closeMsgCorrect;

  return {
    message: closeMessage,
    dayStatus: DAY_STATUS.CLOSED,
    daySummary,
    eodResults,
    ...(zeroCollectionWarning ? { zeroCollectionWarning } : {}),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET DAY STATUS
// ─────────────────────────────────────────────────────────────────────────────
const getDayStatus = async () => {
  const [dayStatus, businessDate] = await Promise.all([
    AppConfig.getValue(CONFIG_KEYS.DAY_STATUS),
    AppConfig.getCurrentBusinessDate(),
  ]);

  const status = dayStatus || DAY_STATUS.CLOSED;
  const isOpen = status === DAY_STATUS.OPEN;

  // Pre-compute IST-correct YYYY-MM-DD strings — the frontend must NEVER call
  // new Date() for business date display. All dates come from here.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  let businessDateFormatted = null;
  let nextBusinessDateFormatted = null;
  let nextBusinessDisplayDate = null;

  let dayGapWarning = null;
  let serverDateStr = null;

  if (businessDate) {
    const bdMs = new Date(businessDate).getTime();
    const istDate = new Date(bdMs + IST_OFFSET_MS);
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(istDate.getUTCDate()).padStart(2, '0');
    businessDateFormatted = `${y}-${m}-${d}`;

    // nextBusinessDate = businessDate + 1 calendar day (when closed)
    // When open, it equals the current business date (already open for today)
    const nextMs = isOpen ? bdMs : bdMs + 24 * 60 * 60 * 1000;
    const nextIst = new Date(nextMs + IST_OFFSET_MS);
    const ny = nextIst.getUTCFullYear();
    const nm = String(nextIst.getUTCMonth() + 1).padStart(2, '0');
    const nd = String(nextIst.getUTCDate()).padStart(2, '0');
    nextBusinessDateFormatted = `${ny}-${nm}-${nd}`;

    // Human-readable version for the "Open Day" modal
    nextBusinessDisplayDate = new Date(nextMs).toLocaleDateString("en-IN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Kolkata",
    });

    // ── Day Gap Warning ────────────────────────────────────────────────────────
    // If the system has been closed for more than 1 calendar day, we calculate a warning
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    const serverYear = nowIst.getUTCFullYear();
    const serverMonth = String(nowIst.getUTCMonth() + 1).padStart(2, '0');
    const serverDay = String(nowIst.getUTCDate()).padStart(2, '0');
    serverDateStr = `${serverYear}-${serverMonth}-${serverDay}`;

    if (!isOpen) {
      // Compare serverDateStr (e.g. 2026-04-23) with nextBusinessDateFormatted (e.g. 2026-04-21)
      const serverDateObj = new Date(serverDateStr);
      const nextDateObj = new Date(nextBusinessDateFormatted);
      
      const gapDays = Math.floor((serverDateObj.getTime() - nextDateObj.getTime()) / (1000 * 60 * 60 * 24));
      
      if (gapDays >= 1) {
        dayGapWarning = {
          message: "The system has been closed for more than 1 day.",
          lastClosedDate: new Date(bdMs).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
          suggestedNextDate: new Date(nextMs).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
          gapDays: gapDays + 1, // Number of days missed including the next expected day
        };
      }
    }
  }

  return {
    dayStatus: status,
    isOpen,
    businessDate,
    businessDateFormatted,      // Current business date YYYY-MM-DD IST
    nextBusinessDateFormatted,  // Next business date YYYY-MM-DD IST (lastDate+1 when closed)
    nextBusinessDisplayDate,    // Human-readable next date for UI modal display
    serverDate: serverDateStr,
    dayGapWarning,
    displayDate: businessDate
      ? new Date(businessDate).toLocaleDateString("en-IN", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Kolkata",
      })
      : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET DAY HISTORY
// ─────────────────────────────────────────────────────────────────────────────
const getDayHistory = async (limit = 30) => {
  const history = await BusinessDay.getHistory(limit);
  return { history };
};

module.exports = { openDay, closeDay, getDayStatus, getDayHistory };
