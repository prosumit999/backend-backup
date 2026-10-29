"use strict";

const backupService = require("../services/backup.service");
const logger = require("../utils/logger");
const { acquireLock, releaseLock, LOCK_KEYS } = require("../utils/cronLock");

const runBackupJob = async ({ trigger = "scheduled" } = {}) => {
  const locked = await acquireLock(LOCK_KEYS.BACKUP, 120);
  if (!locked) {
    logger.warn(`[BackupJob] Skipped ${trigger} backup; another instance owns the lock.`);
    return null;
  }

  try {
    logger.info(`[BackupJob] Starting ${trigger} JSON email backup.`);
    const backup = await backupService.emailJsonBackup();

    logger.info(
      `[BackupJob] Completed ${trigger} backup | File: ${backup.fileName}`,
    );

    return backup;
  } catch (err) {
    logger.error(`[BackupJob] ${trigger} backup failed: ${err.message}`);
    throw err;
  } finally {
    await releaseLock(LOCK_KEYS.BACKUP).catch((err) =>
      logger.error(`[BackupJob] Failed to release lock: ${err.message}`),
    );
  }
};

module.exports = { runBackupJob };
