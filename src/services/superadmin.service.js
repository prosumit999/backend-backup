// src/services/superadmin/superadmin.service.js
"use strict";

const User = require("../models/User.model");
const Customer = require("../models/Customer.model");
const AppConfig = require("../models/AppConfig.model");
const AuditLog = require("../models/AuditLog.model");
const LoanPlan = require("../models/LoanPlan.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const {
  generateAdminCode,
  generateLoanPlanCode,
} = require("../utils/generateCode");
const {
  ROLES,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  PAGINATION,
  CONFIG_KEYS,
  CONFIG_UPDATABLE_KEYS,
} = require("../config/constants");
const escapeRegex = require("../utils/escapeRegex");
const { startOfDay, endOfDay } = require("../utils/dateHelpers");
// A-1 / A-2 FIX: Import cache eviction helpers from authenticate middleware.
// evictUserCache — call on deactivation or role change so next request reads fresh from DB.
// evictLockCache — call on lock/unlock so the 5s cached value is cleared instantly.
const { evictUserCache, evictLockCache } = require("../middleware/authenticate");

const NORMAL_BALANCE_MAP = Object.freeze({
  asset: "debit",
  expense: "debit",
  liability: "credit",
  income: "credit",
});

const deriveNormalBalance = (type) => {
  const nb = NORMAL_BALANCE_MAP[type];
  if (!nb) throw new ApiError(400, `Unknown account type: '${type}'`);
  return nb;
};

// ─────────────────────────────────────────────────────────
// PRIVATE HELPER — strip sensitive fields before returning
// ─────────────────────────────────────────────────────────
const safeUser = (userDoc) => {
  const obj = userDoc.toObject ? userDoc.toObject() : userDoc;
  const { password, refreshToken, loginAttempts, lockUntil, ...safe } = obj;
  return safe;
};

// ══════════════════════════════════════════════════════════
// SECTION 1 — ADMIN MANAGEMENT
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 1a. CREATE ADMIN
// ─────────────────────────────────────────────────────────
const createAdmin = async ({
  name,
  phone,
  password,
  email,
  createdBy,
  ipAddress,
  requestId,
}) => {
  const existing = await User.findByPhone(phone);
  if (existing)
    throw new ApiError(409, `A user with phone ${phone} already exists`);

  const normalizedEmail = email?.trim().toLowerCase();
  const customerWithEmail = normalizedEmail
    ? await Customer.findOne({ email: normalizedEmail })
      .setOptions({ _skipDeletedFilter: true })
      .select("_id")
      .lean()
    : null;
  if (customerWithEmail) {
    throw new ApiError(409, "This email address is already registered");
  }

  const adminCode = await generateAdminCode();

  let admin;
  try {
    admin = await User.create({
      name,
      phone,
      password,
      email: normalizedEmail || undefined,
      role: ROLES.ADMIN,
      adminCode,
      isActive: true,
      createdBy,
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.email) {
      throw new ApiError(409, "This email address is already registered");
    }
    if (err.code === 11000) {
      throw new ApiError(409, `A user with phone ${phone} already exists`);
    }
    throw err;
  }

  await AuditLog.log({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.ADMIN_CREATED,
    entity: "User",
    entityId: admin._id,
    newData: { name, phone, adminCode, email: email || null },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(`[Superadmin] Admin created | ${adminCode} | By: ${createdBy}`);
  return { admin: safeUser(admin) };
};

// ─────────────────────────────────────────────────────────
// 1b. LIST ADMINS
// ─────────────────────────────────────────────────────────
const listAdmins = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  search,
  isActive,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const filter = { role: ROLES.ADMIN, isDeleted: false };

  if (isActive !== undefined) {
    filter.isActive = isActive === "true" || isActive === true;
  }

  if (search) {
    const safeSearch = escapeRegex(search.trim());
    filter.$or = [
      { name: { $regex: safeSearch, $options: "i" } },
      { phone: { $regex: safeSearch } },
      { adminCode: { $regex: safeSearch, $options: "i" } },
    ];
  }

  const [admins, total] = await Promise.all([
    User.find(filter)
      .select("name phone email adminCode isActive createdAt createdBy")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit),
    User.countDocuments(filter),
  ]);

  return {
    admins: admins.map(safeUser),
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────
// 1c. GET SINGLE ADMIN
// ─────────────────────────────────────────────────────────
const getAdmin = async (adminId) => {
  const admin = await User.findOne({
    _id: adminId,
    role: ROLES.ADMIN,
    isDeleted: false,
  }).select(
    "name phone email adminCode isActive smsEnabled createdAt createdBy",
  );

  if (!admin) throw new ApiError(404, "Admin not found");
  return { admin: safeUser(admin) };
};

// ─────────────────────────────────────────────────────────
// 1d. RESET ADMIN PASSWORD
// ─────────────────────────────────────────────────────────
const resetAdminPassword = async ({
  adminId,
  newPassword,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const admin = await User.findOne({
    _id: adminId,
    role: ROLES.ADMIN,
    isDeleted: false,
  }).select("+password +refreshToken");

  if (!admin) throw new ApiError(404, "Admin not found");

  admin.password = newPassword;
  admin.refreshToken = null;
  await admin.save();

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
    entity: "User",
    entityId: adminId,
    newData: { note: "Password reset by superadmin" },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.warn(
    `[Superadmin] Admin password reset | Admin: ${adminId} | By: ${performedBy}`,
  );
  return {
    message: "Admin password reset successfully. All sessions invalidated.",
  };
};

// ─────────────────────────────────────────────────────────
// 1e. TOGGLE ADMIN STATUS
// ─────────────────────────────────────────────────────────
const toggleAdminStatus = async ({
  adminId,
  isActive,
  reason,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const admin = await User.findOne({
    _id: adminId,
    role: ROLES.ADMIN,
    isDeleted: false,
  });

  if (!admin) throw new ApiError(404, "Admin not found");

  if (admin._id.toString() === performedBy.toString()) {
    throw new ApiError(400, "You cannot change your own status");
  }

  const oldStatus = admin.isActive;

  admin.isActive = isActive;
  if (!isActive) admin.refreshToken = null;
  await admin.save({ validateBeforeSave: false });

  evictUserCache(adminId);

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.ADMIN_STATUS_CHANGED,
    entity: "User",
    entityId: adminId,
    oldData: { isActive: oldStatus },
    newData: { isActive, reason: reason || null },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Admin ${isActive ? "activated" : "deactivated"} | ${adminId} | By: ${performedBy}`,
  );
  return {
    adminId,
    isActive,
    message: `Admin ${isActive ? "activated" : "deactivated"} successfully`,
  };
};

// ══════════════════════════════════════════════════════════
// SECTION 2 — SYSTEM CONTROL
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 2a. LOCK SYSTEM
// ─────────────────────────────────────────────────────────
const lockSystem = async ({ performedBy, ipAddress, requestId }) => {
  const result = await AppConfig.findOneAndUpdate(
    { key: CONFIG_KEYS.SYSTEM_LOCKED, value: false },
    { $set: { value: true, updatedBy: performedBy } },
    { returnDocument: "after" },
  );
  if (!result) throw new ApiError(400, "System is already locked");


  evictLockCache();

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.SYSTEM_LOCKED,
    entity: "AppConfig",
    newData: { SYSTEM_LOCKED: true },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.warn(`[Superadmin] SYSTEM LOCKED | By: ${performedBy}`);
  return {
    message: "System locked successfully. All admin operations are blocked.",
  };
};

// ─────────────────────────────────────────────────────────
// 2b. UNLOCK SYSTEM
// ─────────────────────────────────────────────────────────
const unlockSystem = async ({ performedBy, ipAddress, requestId }) => {
  const result = await AppConfig.findOneAndUpdate(
    { key: CONFIG_KEYS.SYSTEM_LOCKED, value: true },
    { $set: { value: false, updatedBy: performedBy } },
    { returnDocument: "after" },
  );
  if (!result) throw new ApiError(400, "System is already unlocked");

  evictLockCache();

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.SYSTEM_UNLOCKED,
    entity: "AppConfig",
    newData: { SYSTEM_LOCKED: false },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(`[Superadmin] SYSTEM UNLOCKED | By: ${performedBy}`);
  return { message: "System unlocked. Operations resumed." };
};

// ─────────────────────────────────────────────────────────
// 2c. TOGGLE SMS GLOBALLY
// ─────────────────────────────────────────────────────────
const toggleSms = async ({ enabled, performedBy, ipAddress, requestId }) => {
  await AppConfig.setValue(
    CONFIG_KEYS.SMS_ENABLED_GLOBAL,
    enabled,
    performedBy,
  );

  await AuditLog.log({
    performedBy,
    action: enabled ? AUDIT_ACTIONS.SMS_ENABLED : AUDIT_ACTIONS.SMS_DISABLED,
    entity: "AppConfig",
    newData: { SMS_ENABLED_GLOBAL: enabled },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] SMS ${enabled ? "ENABLED" : "DISABLED"} globally | By: ${performedBy}`,
  );
  return { message: `SMS ${enabled ? "enabled" : "disabled"} globally.` };
};

// ══════════════════════════════════════════════════════════
// SECTION 3 — SYSTEM CONFIG
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 3a. GET ALL CONFIG
// ─────────────────────────────────────────────────────────
const getAllConfig = async () => {
  const configs = await AppConfig.find({})
    .select("key value description updatedBy updatedAt")
    .sort({ key: 1 })
    .lean();

  const filtered = configs.filter((c) => CONFIG_UPDATABLE_KEYS.includes(c.key));

  return { configs: filtered };
};

// ─────────────────────────────────────────────────────────
// 3b. UPDATE ONE CONFIG KEY
// ─────────────────────────────────────────────────────────
const updateConfig = async ({
  key,
  value,
  performedBy,
  ipAddress,
  requestId,
}) => {
  if (!CONFIG_UPDATABLE_KEYS.includes(key)) {
    throw new ApiError(
      400,
      `Config key '${key}' cannot be updated via this API. ` +
      `Use the dedicated system endpoints for lock/unlock and SMS toggle.`,
    );
  }

  const oldConfig = await AppConfig.findOne({ key }).lean();
  await AppConfig.setValue(key, value, performedBy);

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.CONFIG_UPDATED,
    entity: "AppConfig",
    oldData: { key, value: oldConfig?.value ?? null },
    newData: { key, value },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Config updated | ${key} → ${value} | By: ${performedBy}`,
  );
  return { message: `Config '${key}' updated successfully.`, key, value };
};

// ══════════════════════════════════════════════════════════
// SECTION 4 — LOAN PLANS
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 4a. CREATE LOAN PLAN
// ─────────────────────────────────────────────────────────
const createLoanPlan = async ({
  planName,
  description,
  durationMonths,
  baseInterestRateBps,
  processingFeeBps,
  minLoanAmountInPaise,
  maxLoanAmountInPaise,
  createdBy,
  ipAddress,
  requestId,
}) => {
  const planCode = await generateLoanPlanCode();

  const plan = await LoanPlan.create({
    planCode,
    planName,
    description: description || "",
    durationMonths,
    baseInterestRateBps,
    processingFeeBps: processingFeeBps ?? 200,
    minLoanAmountInPaise: minLoanAmountInPaise ?? 100000,
    maxLoanAmountInPaise,
    isActive: true,
    createdBy,
  });

  await AuditLog.log({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.LOAN_PLAN_CREATED,
    entity: "LoanPlan",
    entityId: plan._id,
    newData: { planCode, planName, durationMonths, baseInterestRateBps },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Loan plan created | ${planCode} | By: ${createdBy}`,
  );
  return { plan };
};

// ─────────────────────────────────────────────────────────
// 4b. LIST LOAN PLANS
// ─────────────────────────────────────────────────────────
const listLoanPlans = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  isActive,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const filter = { isDeleted: false };
  if (isActive !== undefined) {
    filter.isActive = isActive === "true" || isActive === true;
  }

  const [plans, total] = await Promise.all([
    LoanPlan.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit),
    LoanPlan.countDocuments(filter),
  ]);

  return {
    plans,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────
// 4c. GET SINGLE LOAN PLAN
// ─────────────────────────────────────────────────────────
const getLoanPlan = async (planId) => {
  let loanPlan;

  if (/^LP-\d{4}-\d{3,}$/i.test(planId)) {
    loanPlan = await LoanPlan.findOne({
      planCode: planId.toUpperCase(),
      isDeleted: false,
    });
  } else if (/^[0-9a-fA-F]{24}$/.test(planId)) {
    loanPlan = await LoanPlan.findOne({ _id: planId, isDeleted: false });
  } else {
    throw new ApiError(400, `Invalid loan plan identifier: '${planId}'`);
  }

  if (!loanPlan) throw new ApiError(404, "Loan plan not found");
  return { loanPlan };
};

// ─────────────────────────────────────────────────────────
// 4d. UPDATE LOAN PLAN
// ─────────────────────────────────────────────────────────
const updateLoanPlan = async ({
  planId,
  updates,
  performedBy,
  ipAddress,
  requestId,
}) => {
  let loanPlan;
  if (/^LP-\d{4}-\d{3,}$/i.test(planId)) {
    loanPlan = await LoanPlan.findOne({
      planCode: planId.toUpperCase(),
      isDeleted: false,
    });
  } else if (/^[0-9a-fA-F]{24}$/.test(planId)) {
    loanPlan = await LoanPlan.findOne({ _id: planId, isDeleted: false });
  } else {
    throw new ApiError(400, `Invalid loan plan identifier: '${planId}'`);
  }

  if (!loanPlan) {
    throw new ApiError(404, `Loan plan not found: '${planId}'`);
  }

  // durationMonths is intentionally EXCLUDED — changing the duration of a plan
  // that has existing active loans would silently invalidate their maturity dates.
  // To change duration, create a new plan and close the old one.
  const ALLOWED = [
    "planName",
    "description",
    "baseInterestRateBps",
    "processingFeeBps",
    "minLoanAmountInPaise",
    "maxLoanAmountInPaise",
    "isActive",
  ];

  const safeUpdates = {};
  ALLOWED.forEach((f) => {
    if (updates[f] !== undefined) safeUpdates[f] = updates[f];
  });

  if (Object.keys(safeUpdates).length === 0) {
    throw new ApiError(400, "No valid fields provided to update");
  }

  LoanPlan.validateAmountLimits(safeUpdates, loanPlan);

  safeUpdates.updatedBy = performedBy;

  const updated = await LoanPlan.findByIdAndUpdate(
    loanPlan._id,
    { $set: safeUpdates },
    { returnDocument: "after", runValidators: true },
  );

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.LOAN_PLAN_UPDATED,
    entity: "LoanPlan",
    entityId: loanPlan._id,
    oldData: {
      planName: loanPlan.planName,
      baseInterestRateBps: loanPlan.baseInterestRateBps,
      isActive: loanPlan.isActive,
    },
    newData: safeUpdates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Loan plan updated | ${loanPlan.planCode} | Fields: ${Object.keys(safeUpdates).join(", ")} | By: ${performedBy}`,
  );
  return { plan: updated };
};

// ══════════════════════════════════════════════════════════
// SECTION 5 — LEDGER ACCOUNTS
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 5a. CREATE LEDGER ACCOUNT
// ─────────────────────────────────────────────────────────
const createLedgerAccount = async ({
  code,
  name,
  type,
  description,
  createdBy,
  ipAddress,
  requestId,
}) => {
  const normalBalance = deriveNormalBalance(type);

  let account;
  try {
    account = await LedgerAccount.create({
      code: code.trim().toUpperCase(),
      name,
      type,
      normalBalance,
      description: description || "",
      isSystem: false,
      isActive: true,
      createdBy,
    });
  } catch (err) {
    if (err.code === 11000) {
      throw new ApiError(
        409,
        `Ledger account with code '${code}' already exists`,
      );
    }
    throw err;
  }

  await AuditLog.log({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.LEDGER_ACCOUNT_CREATED,
    entity: "LedgerAccount",
    entityId: account._id,
    newData: { code, name, type, normalBalance },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Ledger account created | ${code} (${type}/${normalBalance}) | By: ${createdBy}`,
  );
  return { account };
};

// ─────────────────────────────────────────────────────────
// 5b. LIST LEDGER ACCOUNTS
// ─────────────────────────────────────────────────────────
const listLedgerAccounts = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  type,
  isActive,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const filter = {};
  if (type) filter.type = type;
  if (isActive !== undefined) {
    filter.isActive = isActive === "true" || isActive === true;
  }

  const [accounts, total] = await Promise.all([
    LedgerAccount.find(filter)
      .select(
        "code name type normalBalance runningBalanceInPaise isActive isSystem description createdAt",
      )
      .sort({ code: 1 })
      .skip(skip)
      .limit(safeLimit),
    LedgerAccount.countDocuments(filter),
  ]);

  return {
    accounts,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────
// 5c. GET SINGLE LEDGER ACCOUNT
// ─────────────────────────────────────────────────────────
const getLedgerAccount = async (accountId) => {
  const account = await LedgerAccount.findById(accountId);
  if (!account) throw new ApiError(404, "Ledger account not found");
  return { account };
};

// ─────────────────────────────────────────────────────────
// 5d. UPDATE LEDGER ACCOUNT
// ─────────────────────────────────────────────────────────
const updateLedgerAccount = async ({
  accountId,
  updates,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const account = await LedgerAccount.findById(accountId);
  if (!account) throw new ApiError(404, "Ledger account not found");

  const ALLOWED = account.isSystem
    ? ["description", "isActive"]
    : ["name", "description", "isActive"];

  const safeUpdates = {};
  ALLOWED.forEach((f) => {
    if (updates[f] !== undefined) safeUpdates[f] = updates[f];
  });

  if (Object.keys(safeUpdates).length === 0) {
    throw new ApiError(
      400,
      account.isSystem
        ? "System accounts can only have description and isActive updated"
        : "No valid fields provided",
    );
  }

  const updated = await LedgerAccount.findByIdAndUpdate(
    accountId,
    { $set: safeUpdates },
    { returnDocument: "after", runValidators: true },
  );

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.LEDGER_ACCOUNT_UPDATED,
    entity: "LedgerAccount",
    entityId: accountId,
    oldData: {
      name: account.name,
      description: account.description,
      isActive: account.isActive,
    },
    newData: safeUpdates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Superadmin] AuditLog failed: ${e.message}`));

  logger.info(
    `[Superadmin] Ledger account updated | ${account.code} | By: ${performedBy}`,
  );
  return { account: updated };
};

// ══════════════════════════════════════════════════════════
// SECTION 6 — READ-ONLY VIEWS
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// 6a. VIEW AUDIT LOGS
// ─────────────────────────────────────────────────────────
const getAuditLogs = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  action,
  entity,
  entityId,
  performedBy,
  status,
  from,
  to,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const filter = {};
  if (action) filter.action = action.toUpperCase();
  if (entity) filter.entity = entity;
  if (entityId) filter.entityId = entityId;
  if (performedBy) filter.performedBy = performedBy;
  if (status) filter.status = status;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfDay(new Date(from));
    if (to) filter.createdAt.$lte = endOfDay(new Date(to));
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("performedBy", "name phone role adminCode agentCode")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    logs,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────
// 6b. SYSTEM DASHBOARD
// ─────────────────────────────────────────────────────────
const getDashboard = async () => {
  const [
    systemLocked,
    smsEnabled,
    dayStatus,
    businessDate,
    totalAdmins,
    activeAdmins,
    totalAgents,
    activeAgents,
  ] = await Promise.all([
    AppConfig.getValue(CONFIG_KEYS.SYSTEM_LOCKED),
    AppConfig.getValue(CONFIG_KEYS.SMS_ENABLED_GLOBAL),
    AppConfig.getValue(CONFIG_KEYS.DAY_STATUS),
    AppConfig.getValue(CONFIG_KEYS.CURRENT_BUSINESS_DATE),
    User.countDocuments({ role: ROLES.ADMIN, isDeleted: false }),
    User.countDocuments({
      role: ROLES.ADMIN,
      isDeleted: false,
      isActive: true,
    }),
    User.countDocuments({ role: ROLES.AGENT, isDeleted: false }),
    User.countDocuments({
      role: ROLES.AGENT,
      isDeleted: false,
      isActive: true,
    }),
  ]);

  return {
    system: {
      isLocked: systemLocked ?? false,
      smsEnabled: smsEnabled ?? false,
      dayStatus: dayStatus ?? "closed",
      currentBusinessDate: businessDate ?? null,
    },
    counts: {
      admins: { total: totalAdmins, active: activeAdmins },
      agents: { total: totalAgents, active: activeAgents },
    },
  };
};

module.exports = {
  createAdmin,
  listAdmins,
  getAdmin,
  resetAdminPassword,
  toggleAdminStatus,
  lockSystem,
  unlockSystem,
  toggleSms,
  getAllConfig,
  updateConfig,
  createLoanPlan,
  listLoanPlans,
  getLoanPlan,
  updateLoanPlan,
  createLedgerAccount,
  listLedgerAccounts,
  getLedgerAccount,
  updateLedgerAccount,
  getAuditLogs,
  getDashboard,
};
