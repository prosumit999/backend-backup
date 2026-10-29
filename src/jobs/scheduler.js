// src/jobs/scheduler.js
// ─────────────────────────────────────────────────────────────────────────────
// Cron schedule (IST):
// 9:30 PM  — penalty + overdue marking   (requires day CLOSED + not locked)
// 10:00 PM — missed-day tracking         (requires day CLOSED + not locked)
// 11:00 PM — ledger reconcile            (always runs — it IS the health check)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const cron = require("node-cron");
const logger = require("../utils/logger");
const env = require("../config/env");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const {
  CONFIG_KEYS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
} = require("../config/constants");
const { runPenaltyAndOverdueJob } = require("./penaltyAndOverdue.job");
const { runMissedDayTrackingJob } = require("./missedDayTracking.job");
const { runReconcileJob } = require("./reconcile.job");
const { runDeficitWarningJob } = require("./deficitWarning.job");
const { runBackupJob } = require("./backup.job");

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PERFORMER — consistent with penaltyAndOverdue.job.js
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PERFORMER_ID = new mongoose.Types.ObjectId(
  "000000000000000000000000",
);

// ── Helpers ───────────────────────────────────────────────────────────────────
const isSystemLocked = async () =>
  !!(await AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED));

const isDayClosed = async () => {
  const isOpen = await AppConfig.isDayOpen();
  return !isOpen;
};

// ── In-process concurrency guard (single-instance safety) ─────────────────────
// acquireLock handles multi-instance; this handles same-instance double-fire
const jobRunning = {
  penalty: false,
  missedDay: false,
  reconcile: false,
  backup: false,
  deficitWarning: false, // pigmy deficit warning — runs at 10:30 PM IST
};

// ── JOB 1: PENALTY + OVERDUE MARKING — 9:30 PM IST ───────────────────────────
const schedulePenaltyJob = () => {
  cron.schedule(
    "30 21 * * *",
    async () => {
      logger.info("[Scheduler] ⏰ Penalty job triggered at 21:30 IST");

      if (jobRunning.penalty) {
        logger.warn(
          "[Scheduler] Penalty job SKIPPED — previous run still in progress. " +
            "Dataset may be too large for 30-min window. Check job duration.",
        );
        return;
      }

      jobRunning.penalty = true;
      try {
        if (!(await isDayClosed())) {
          logger.error(
            "[Scheduler] Penalty job BLOCKED — business day is still OPEN. " +
              "Admin must close the day before 21:30.",
          );
          return;
        }

        if (await isSystemLocked()) {
          logger.error(
            "[Scheduler] SYSTEM LOCKED — Penalty job BLOCKED. Superadmin must unlock.",
          );
          return;
        }

        await runPenaltyAndOverdueJob();
      } catch (err) {
        logger.error(`[Scheduler] Penalty job failed: ${err.message}`);
      } finally {
        jobRunning.penalty = false;
      }
    },
    { timezone: "Asia/Kolkata" },
  );
};

// ── JOB 2: MISSED-DAY TRACKING — 10:00 PM IST ────────────────────────────────
const scheduleMissedDayTrackingJob = () => {
  cron.schedule(
    "0 22 * * *",
    async () => {
      logger.info("[Scheduler] Missed-day tracking job triggered at 22:00 IST");

      if (jobRunning.missedDay) {
        logger.warn(
          "[Scheduler] Missed-day job SKIPPED — previous run still in progress.",
        );
        return;
      }

      jobRunning.missedDay = true;
      try {
        if (!(await isDayClosed())) {
          logger.error(
            "[Scheduler] Missed-day job BLOCKED — business day is still OPEN. " +
              "Collections can still arrive. Run after day close only.",
          );
          return;
        }

        if (await isSystemLocked()) {
          logger.error(
            "[Scheduler] SYSTEM LOCKED — Missed-day tracking BLOCKED.",
          );
          return;
        }

        await runMissedDayTrackingJob();
      } catch (err) {
        logger.error(`[Scheduler] Missed-day tracking failed: ${err.message}`);
      } finally {
        jobRunning.missedDay = false;
      }
    },
    { timezone: "Asia/Kolkata" },
  );
};

// ── JOB 3: LEDGER RECONCILE — 11:00 PM IST ───────────────────────────────────
// ALWAYS runs — skipping the health check defeats its entire purpose.

// -- JOB 3: PIGMY DEFICIT WARNING -- 10:30 PM IST
// Runs AFTER missedDayTracking (22:00). Calculates expected vs actual
// pigmy collection and manages the lifeline warning lifecycle.
const scheduleDeficitWarningJob = () => {
  cron.schedule(
    '30 22 * * *',
    async () => {
      logger.info('[Scheduler] Deficit warning job triggered at 22:30 IST');
      if (jobRunning.deficitWarning) {
        logger.warn('[Scheduler] Deficit warning job SKIPPED -- previous run still in progress.');
        return;
      }
      jobRunning.deficitWarning = true;
      try {
        if (!(await isDayClosed())) {
          logger.error('[Scheduler] Deficit warning job BLOCKED -- business day is still OPEN.');
          return;
        }
        if (await isSystemLocked()) {
          logger.error('[Scheduler] SYSTEM LOCKED -- Deficit warning job BLOCKED.');
          return;
        }
        await runDeficitWarningJob();
      } catch (err) {
        logger.error('[Scheduler] Deficit warning job failed: ' + err.message);
      } finally {
        jobRunning.deficitWarning = false;
      }
    },
    { timezone: 'Asia/Kolkata' },
  );
};
const scheduleReconcileJob = () => {
  cron.schedule(
    "0 23 * * *",
    async () => {
      logger.info("[Scheduler] Reconcile job triggered at 23:00 IST");

      if (jobRunning.reconcile) {
        logger.warn(
          "[Scheduler] Reconcile job SKIPPED — previous run still in progress. " +
            "Investigate immediately — reconcile taking >1 hour is abnormal.",
        );
        return;
      }

      jobRunning.reconcile = true;
      try {
        await runReconcileJob();
      } catch (err) {
        logger.error(`[Scheduler] Reconcile job failed: ${err.message}`);
      } finally {
        jobRunning.reconcile = false;
      }
    },
    { timezone: "Asia/Kolkata" },
  );
};

// ── START — called once from server.js after DB connection is ready ────────────
// JOB 5: JSON EMAIL BACKUP -- 1:00 AM IST
const scheduleBackupJob = () => {
  if (!env.BACKUP_DAILY_ENABLED) {
    logger.info("[Scheduler] Daily JSON email backup disabled.");
    return;
  }

  cron.schedule(
    "0 1 * * *",
    async () => {
      logger.info("[Scheduler] JSON email backup job triggered at 01:00 IST");

      if (jobRunning.backup) {
        logger.warn("[Scheduler] Backup job SKIPPED -- previous run still in progress.");
        return;
      }

      jobRunning.backup = true;
      try {
        await runBackupJob({ trigger: "scheduled" });
      } catch (err) {
        logger.error(`[Scheduler] Backup job failed: ${err.message}`);
      } finally {
        jobRunning.backup = false;
      }
    },
    { timezone: "Asia/Kolkata" },
  );
};

const runStartupBackup = () => {
  if (!env.BACKUP_ON_STARTUP) return;

  logger.info(`[Scheduler] Startup JSON backup email scheduled in ${env.BACKUP_STARTUP_DELAY_MS}ms.`);

  setTimeout(async () => {
    if (jobRunning.backup) {
      logger.warn("[Scheduler] Startup backup SKIPPED -- backup already running.");
      return;
    }

    jobRunning.backup = true;
    try {
      await runBackupJob({ trigger: "startup" });
    } catch (err) {
      logger.error(`[Scheduler] Startup backup failed: ${err.message}`);
    } finally {
      jobRunning.backup = false;
    }
  }, env.BACKUP_STARTUP_DELAY_MS).unref();
};

const startScheduler = () => {
  schedulePenaltyJob();
  scheduleMissedDayTrackingJob();
  scheduleDeficitWarningJob();
  scheduleReconcileJob();
  scheduleBackupJob();
  runStartupBackup();

  AuditLog.log({
    performedBy: SYSTEM_PERFORMER_ID,
    action: AUDIT_ACTIONS.SCHEDULER_STARTED,
    entity: "System",
    entityId: null,
    newData: {
      pid: process.pid,
      jobs: [
        "PENALTY_21:30_IST",
        "MISSED_DAY_22:00_IST",
        "DEFICIT_WARNING_22:30_IST",
        "RECONCILE_23:00_IST",
        "BACKUP_01:00_IST",
      ],
      backupOnStartup: env.BACKUP_ON_STARTUP,
    },
    startedAt: new Date(),
    status: AUDIT_STATUS.SUCCESS, // ← use constant not raw string
  }).catch((e) => logger.error(`[Scheduler] Audit failed: ${e.message}`));

  logger.info(`[Scheduler] All jobs initialized | PID: ${process.pid}`);
};

module.exports = { startScheduler };
