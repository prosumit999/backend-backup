// src/services/devPanel.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Dev Panel Service — vendor-level configuration management.
//
// SCOPE: Institution model CRUD, AppConfig audit, Dev password management.
// ACCESS: DEV role only (enforced at route level via DEV_PANEL permission).
//
// DESIGN PRINCIPLES:
//   1. All genesis date changes require a BusinessDay count check — if
//      BusinessDay records exist before the proposed new genesis date, the
//      update is rejected to prevent orphaning historical day records.
//   2. Password change uses bcrypt.compare on the stored hash — NOT a JWT
//      claim. This is a second-factor verification for a high-privilege action.
//   3. Every mutation emits a distinct AuditLog entry for compliance querying.
//   4. getConfigAudit returns all AppConfig docs grouped by category, plus
//      a "health" flag per key (expected vs missing, used vs deprecated).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const bcrypt = require("bcrypt");
const Institution = require("../models/Institution.model");
const AppConfig = require("../models/AppConfig.model");
const BusinessDay = require("../models/BusinessDay.model");
const AuditLog = require("../models/AuditLog.model");
const User = require("../models/User.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { startOfDay } = require("../utils/dateHelpers");
const {
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  CONFIG_KEYS,
  CONFIG_UPDATABLE_KEYS,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET INSTITUTION
// Returns the Institution singleton. Includes all fields (branding, legal,
// genesis date). The `privacyPolicy`, `microfinanceRules`, and
// `termsAndConditions` fields are long text — returned in full for the
// Dev Panel. The public-facing API (system.routes.js) may truncate these.
// ─────────────────────────────────────────────────────────────────────────────
const getInstitution = async () => {
  const institution = await Institution.getInstance();
  return { institution };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. UPDATE INSTITUTION
// Partial update (PATCH semantics). Validates genesis date changes:
//   - Cannot be in the future (handled by Joi validator)
//   - Cannot be moved forward past the earliest existing BusinessDay record
//     (would orphan historical records)
//   - Cannot be moved backward beyond a reasonable date (pre-1990 rejected)
//
// Audit events:
//   - INSTITUTION_CONFIGURED: first meaningful config (name or genesisDate set)
//   - GENESIS_DATE_UPDATED: specifically when systemGenesisDate changes
//   - LEGAL_DOCS_UPDATED: when any legal document changes
//   - INSTITUTION_UPDATED: all other field changes
// ─────────────────────────────────────────────────────────────────────────────
const updateInstitution = async ({
  updates,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const existing = await Institution.getInstance();

  // ── Genesis Date validation ─────────────────────────────────────────────
  if (updates.systemGenesisDate !== undefined) {
    const proposedGenesis = startOfDay(new Date(updates.systemGenesisDate));

    // Guard: Cannot be before 1990 (sanity check for data entry errors)
    const minAllowedDate = new Date("1990-01-01");
    if (proposedGenesis < minAllowedDate) {
      throw new ApiError(
        400,
        "System genesis date cannot be before 1990-01-01. Please verify the date.",
      );
    }

    // Guard: If moving genesis date forward, ensure no BusinessDay records exist
    // before the new genesis date (would create an unresolvable audit gap).
    if (
      existing.systemGenesisDate &&
      proposedGenesis > startOfDay(existing.systemGenesisDate)
    ) {
      const orphanedDays = await BusinessDay.countDocuments({
        businessDate: {
          $gte: startOfDay(existing.systemGenesisDate),
          $lt: proposedGenesis,
        },
      });

      if (orphanedDays > 0) {
        throw new ApiError(
          422,
          `Cannot advance genesis date to ${proposedGenesis.toLocaleDateString("en-IN")}. ` +
          `${orphanedDays} historical BusinessDay record(s) exist between the current ` +
          `genesis date and the proposed new date. Moving the genesis date forward ` +
          `would orphan these records from the auditable timeline.`,
        );
      }
    }
  }

  // ── Apply update ─────────────────────────────────────────────────────────
  const updated = await Institution.updateConfig(updates, performedBy);

  // ── Audit logging (separate entries for distinct concerns) ───────────────
  const auditPromises = [];

  const isFirstConfig = !existing.isConfigured && updated.isConfigured;

  if (isFirstConfig) {
    auditPromises.push(
      AuditLog.log({
        performedBy,
        action: AUDIT_ACTIONS.INSTITUTION_CONFIGURED,
        entity: "Institution",
        entityId: updated._id,
        oldData: { isConfigured: false },
        newData: { name: updated.name, systemGenesisDate: updated.systemGenesisDate },
        ipAddress,
        requestId,
        status: AUDIT_STATUS.SUCCESS,
      }),
    );
  } else if (updates.systemGenesisDate !== undefined) {
    auditPromises.push(
      AuditLog.log({
        performedBy,
        action: AUDIT_ACTIONS.GENESIS_DATE_UPDATED,
        entity: "Institution",
        entityId: updated._id,
        oldData: { systemGenesisDate: existing.systemGenesisDate },
        newData: { systemGenesisDate: updated.systemGenesisDate },
        ipAddress,
        requestId,
        status: AUDIT_STATUS.SUCCESS,
      }),
    );
  }

  const hasLegalChange =
    updates.privacyPolicy !== undefined ||
    updates.microfinanceRules !== undefined ||
    updates.termsAndConditions !== undefined;

  if (hasLegalChange && !isFirstConfig) {
    auditPromises.push(
      AuditLog.log({
        performedBy,
        action: AUDIT_ACTIONS.LEGAL_DOCS_UPDATED,
        entity: "Institution",
        entityId: updated._id,
        newData: {
          updatedDocs: [
            updates.privacyPolicy !== undefined && "privacyPolicy",
            updates.microfinanceRules !== undefined && "microfinanceRules",
            updates.termsAndConditions !== undefined && "termsAndConditions",
          ].filter(Boolean),
        },
        ipAddress,
        requestId,
        status: AUDIT_STATUS.SUCCESS,
      }),
    );
  }

  // General update log for everything else
  if (!isFirstConfig) {
    auditPromises.push(
      AuditLog.log({
        performedBy,
        action: AUDIT_ACTIONS.INSTITUTION_UPDATED,
        entity: "Institution",
        entityId: updated._id,
        newData: { updatedFields: Object.keys(updates) },
        ipAddress,
        requestId,
        status: AUDIT_STATUS.SUCCESS,
      }),
    );
  }

  await Promise.allSettled(auditPromises);

  logger.info(
    `[DevPanel] Institution updated | Fields: ${Object.keys(updates).join(", ")} | By: ${performedBy}`,
  );

  return { institution: updated };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET CONFIG AUDIT
// Returns a comprehensive audit view of all AppConfig documents.
// Groups them by category, flags deprecated/removed keys, and shows which
// keys are user-configurable via the superadmin panel vs system-internal.
// This gives the dev user a real-time snapshot of the operational config.
// ─────────────────────────────────────────────────────────────────────────────
const getConfigAudit = async () => {
  const allConfigs = await AppConfig.find({})
    .select("key value description updatedBy updatedAt createdAt")
    .sort({ key: 1 })
    .lean();

  // Annotate each config with metadata
  const SYSTEM_INTERNAL_KEYS = new Set([
    CONFIG_KEYS.DAY_STATUS,
    CONFIG_KEYS.CURRENT_BUSINESS_DATE,
    CONFIG_KEYS.IS_CURRENT_DAY_BACKDATED,
    CONFIG_KEYS.IS_CATCHUP_MODE,
    CONFIG_KEYS.CRON_LOCK_PENALTY,
    CONFIG_KEYS.CRON_LOCK_RECONCILE,
    CONFIG_KEYS.CRON_LOCK_MISSED_DAY_TRACKING,
    CONFIG_KEYS.CRON_LOCK_DEFICIT_WARNING,
  ]);

  const DEPRECATED_KEYS = new Set([
    "SYSTEM_GENESIS_DATE", // migrated to Institution model
    "DAY_CLOSE_TIME",      // never read at runtime
    "MAX_ALLOWED_LEAVES_PER_MONTH", // never read at runtime
  ]);

  const annotated = allConfigs.map((cfg) => ({
    ...cfg,
    isUpdatable: CONFIG_UPDATABLE_KEYS.includes(cfg.key),
    isSystemInternal: SYSTEM_INTERNAL_KEYS.has(cfg.key),
    isDeprecated: DEPRECATED_KEYS.has(cfg.key),
    category: _categorizeKey(cfg.key),
  }));

  // Group by category
  const grouped = {};
  for (const cfg of annotated) {
    if (!grouped[cfg.category]) grouped[cfg.category] = [];
    grouped[cfg.category].push(cfg);
  }

  return {
    totalKeys: allConfigs.length,
    updatableKeys: annotated.filter((c) => c.isUpdatable).length,
    deprecatedKeys: annotated.filter((c) => c.isDeprecated).length,
    groups: grouped,
  };
};

const _categorizeKey = (key) => {
  if (key.startsWith("CRON_LOCK")) return "Cron Locks";
  if (["DAY_STATUS", "CURRENT_BUSINESS_DATE", "IS_CURRENT_DAY_BACKDATED", "IS_CATCHUP_MODE"].includes(key))
    return "Day Control";
  if (["SYSTEM_LOCKED", "MAX_LOGIN_ATTEMPTS", "LOCK_DURATION_MINUTES"].includes(key))
    return "Security";
  if (key.includes("BPS") || key.includes("CHARGE") || key.includes("PENALTY"))
    return "Financial Rates";
  if (key.includes("SMS")) return "SMS";
  if (["SYSTEM_GENESIS_DATE", "DAY_CLOSE_TIME", "MAX_ALLOWED_LEAVES_PER_MONTH"].includes(key))
    return "Deprecated";
  return "Other";
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPLOAD INSTITUTION LOGO
// createUploader uses .fields() so the file arrives as req.files.file[0].
// Before saving the new logo we delete the OLD public_id from Cloudinary so
// storage doesn't accumulate stale assets — true replacement behaviour.
// ─────────────────────────────────────────────────────────────────────────────
const cloudinary = require("../config/cloudinary");

const uploadLogo = async ({ files, performedBy, ipAddress, requestId }) => {
  // createUploader exposes req.files as { fieldname: [file, ...] }
  const file = files?.file?.[0];
  if (!file) throw new ApiError(400, "No file received. Please select an image.");

  // ── Delete the OLD logo from Cloudinary before saving the new one ───────────
  const existing = await Institution.getInstance();
  if (existing?.logo?.publicId) {
    await cloudinary.uploader
      .destroy(existing.logo.publicId, { resource_type: "image" })
      .catch((e) => logger.warn(`[DevPanel] Old logo deletion failed: ${e.message}`));
  }

  const logoData = {
    url: file.path,          // Cloudinary secure URL (set by multer-storage-cloudinary)
    publicId: file.filename, // Cloudinary public_id
  };

  const updated = await Institution.updateConfig({ logo: logoData }, performedBy);

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.INSTITUTION_UPDATED,
    entity: "Institution",
    entityId: updated._id,
    newData: { updatedFields: ["logo"], logoUrl: logoData.url },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[DevPanel] AuditLog failed: ${e.message}`));

  logger.info(`[DevPanel] Institution logo replaced | By: ${performedBy} | URL: ${logoData.url}`);
  return { logoUrl: logoData.url, publicId: logoData.publicId };
};

// ───────────────────────────────────────────────────────────────────────────────
// 6. RESET SUPERADMIN PASSWORD (Dev-privileged)
// The Dev user can force-reset the superadmin password without knowing the
// current one — this is an emergency / first-deployment action.
// Invalidates all superadmin sessions after reset.
// ───────────────────────────────────────────────────────────────────────────────
const resetSuperadminPassword = async ({
  newPassword,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const superadmin = await User.findOne({ role: "superadmin" })
    .select("+password")
    .setOptions({ _skipDeletedFilter: true });

  if (!superadmin) throw new ApiError(404, "Superadmin account not found.");

  // Force-set new password (pre-save hook hashes it)
  superadmin.password = newPassword;
  // Invalidate all active superadmin sessions
  superadmin.refreshTokenHash = null;
  superadmin.refreshTokenFamily = null;
  superadmin.refreshTokenVersion = 0;
  superadmin.refreshTokenUpdatedAt = null;
  await superadmin.save();

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.CHANGE_PASSWORD,
    entity: "User",
    entityId: superadmin._id,
    newData: { note: "Superadmin password reset by Dev. All sessions invalidated." },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[DevPanel] AuditLog failed: ${e.message}`));

  logger.warn(`[DevPanel] Superadmin password reset by dev:${performedBy} | All sessions invalidated`);
  return {
    message: "Superadmin password reset successfully. All active sessions have been invalidated.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHANGE DEV PASSWORD
// Second-factor verification: confirm current password before allowing change.
// Invalidates all active sessions after password change.
// ─────────────────────────────────────────────────────────────────────────────
const changeDevPassword = async ({
  userId,
  currentPassword,
  newPassword,
  ipAddress,
  requestId,
}) => {
  const user = await User.findById(userId)
    .select("+password")
    .setOptions({ _skipDeletedFilter: true });

  if (!user) throw new ApiError(404, "User account not found.");
  if (user.role !== "dev") throw new ApiError(403, "Only dev accounts can use this endpoint.");

  // Verify current password
  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) {
    await AuditLog.log({
      performedBy: userId,
      action: AUDIT_ACTIONS.CHANGE_PASSWORD,
      entity: "User",
      entityId: userId,
      newData: { note: "Dev password change failed — wrong current password" },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.FAILURE,
    }).catch((e) => logger.error(`[DevPanel] AuditLog failed: ${e.message}`));

    throw new ApiError(401, "Current password is incorrect.");
  }

  // Assign new password (pre-save hook will bcrypt-hash it)
  user.password = newPassword;
  // Invalidate all active sessions
  user.refreshTokenHash = null;
  user.refreshTokenFamily = null;
  user.refreshTokenVersion = 0;
  user.refreshTokenUpdatedAt = null;
  await user.save();

  await AuditLog.log({
    performedBy: userId,
    action: AUDIT_ACTIONS.DEV_PASSWORD_CHANGED,
    entity: "User",
    entityId: userId,
    newData: { note: "Dev account password changed. All sessions invalidated." },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[DevPanel] AuditLog failed: ${e.message}`));

  logger.warn(`[DevPanel] Dev password changed | userId: ${userId} | All sessions invalidated`);
  return {
    message: "Password changed successfully. All active sessions have been invalidated. Please log in again.",
  };
};

module.exports = {
  getInstitution,
  updateInstitution,
  getConfigAudit,
  changeDevPassword,
  uploadLogo,
  resetSuperadminPassword,
};
