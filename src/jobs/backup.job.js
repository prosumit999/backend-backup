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
    logger.info(`[BackupJob] Starting ${trigger} Google Drive backup.`);
    const { fileName, buffer } = await backupService.createBackupWorkbook();
    const file = await backupService.uploadBackupToDrive({ fileName, buffer });

    logger.info(
      `[BackupJob] Completed ${trigger} backup | File: ${file.name} | ID: ${file.id}`,
    );

    return file;
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
