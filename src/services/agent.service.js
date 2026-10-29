// src/services/agent.service.js
"use strict";

const User = require("../models/User.model");
const AgentProfile = require("../models/AgentProfile.model");
const AgentOtp = require("../models/AgentOtp.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const AuditLog = require("../models/AuditLog.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const bcrypt = require("bcrypt");
const cryptoUtil = require("../utils/crypto");
const smsService = require("../utils/sms.service");
const withTransaction = require("../utils/withTransaction");
// A-1 FIX: Import cache eviction helper — call after agent deactivation/suspension/termination
// so the authenticate middleware doesn't serve stale isActive:true from its 10s TTL cache.
const { evictUserCache } = require("../middleware/authenticate");
const { generateAgentCode } = require("../utils/generateCode");
const env = require("../config/env");
const {
  ROLES,
  AGENT_KYC_STATUS,
  AGENT_STATUS,
  ACCOUNT_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  PAGINATION,
  LEDGER_ACCOUNT_TYPES,
  LEDGER_NORMAL_BALANCE,
} = require("../config/constants");
const escapeRegex = require("../utils/escapeRegex");

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPER — build safe user object for API responses
// ─────────────────────────────────────────────────────────────────────────────
const safeUser = (userDoc) => {
  const obj = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  const {
    password,
    refreshTokenHash,
    refreshTokenFamily,
    refreshTokenVersion,
    passwordChangedAt,
    loginAttempts,
    lockUntil,
    ...safe
  } = obj;
  return safe;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE AGENT
// ─────────────────────────────────────────────────────────────────────────────
const createAgent = async ({
  name,
  phone,
  password,
  email,
  fullName,
  dateOfBirth,
  gender,
  area,
  assignedPincodes,
  commissionType,
  commissionRateBps,
  joiningDate,
  createdBy,
  ipAddress,
  requestId,
}) => {
  const existing = await User.findByPhone(phone);
  if (existing)
    throw ApiError.conflict(`A user with phone ${phone} already exists.`);

  const agentCode = await generateAgentCode();
  const agentLedgerCode = `AGNT-${agentCode}`;

  let agentUser, agentProfile;

  await withTransaction(async (session) => {
    const existingInSession = await User.findOne({ phone })
      .session(session)
      .lean();
    if (existingInSession)
      throw ApiError.conflict(`A user with phone ${phone} already exists.`);

    [agentUser] = await User.create(
      [
        {
          name,
          phone,
          password,
          email: email || undefined,
          role: ROLES.AGENT,
          agentCode,
          isActive: true,
          createdBy,
        },
      ],
      { session },
    );

    [agentProfile] = await AgentProfile.create(
      [
        {
          user: agentUser._id,
          agentCode,
          fullName: fullName || name,
          dateOfBirth: dateOfBirth || null,
          gender: gender || null,
          area: area || null,
          assignedPincodes: assignedPincodes || [],
          commissionType: commissionType || "none",
          commissionRateBps: commissionRateBps || 0,
          joiningDate: joiningDate || new Date(),
          kycStatus: AGENT_KYC_STATUS.PENDING,
          status: AGENT_STATUS.ACTIVE,
          createdBy,
        },
      ],
      { session },
    );

    const [agentLedgerAccount] = await LedgerAccount.create(
      [
        {
          code: agentLedgerCode,
          name: `Agent Cash — ${agentCode}`,
          type: LEDGER_ACCOUNT_TYPES.ASSET,
          normalBalance: LEDGER_NORMAL_BALANCE.DEBIT,
          runningBalanceInPaise: 0,
          description:
            `Personal cash ledger for agent ${agentCode} (${name}). ` +
            `DR on collection, CR on deposit to office.`,
          isActive: true,
          isSystem: false,
          isAgentAccount: true,
          agentRef: agentUser._id,
          createdBy,
        },
      ],
      { session },
    );

    await User.findByIdAndUpdate(
      agentUser._id,
      { $set: { ledgerAccount: agentLedgerAccount._id } },
      { session },
    );
    agentUser.ledgerAccount = agentLedgerAccount._id;
  });

  await AuditLog.log({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.AGENT_CREATED,
    entity: "User",
    entityId: agentUser._id,
    newData: { name, agentCode, area, ledgerCode: agentLedgerCode }, // phone omitted — PII in audit log unnecessary
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  // Send OTP to agent's phone for creation phone verification
  // Fire-and-forget — failure does not abort the agent creation
  const creationOtp = await AgentOtp.generateOtp(agentUser._id, phone, "creation")
    .catch((e) => {
      logger.error(`[Agent] AgentOtp generation failed | ${agentCode} | ${e.message}`);
      return null;
    });
  if (creationOtp) {
    await smsService.sendKycOtp(phone, name, creationOtp).catch((e) => {
      logger.warn(`[Agent] Creation OTP SMS failed | ${agentCode} | ${e.message}`);
    });
    if (process.env.NODE_ENV !== "production") {
      logger.info(`[Agent][DEV] Creation OTP for ${agentCode}: ${creationOtp}`);
    }
  }

  logger.info(
    `[Agent] Created | ${agentCode} | User: ${agentUser._id} | ` +
    `Profile: ${agentProfile._id} | Ledger: ${agentLedgerCode}`,
  );
  return {
    user: safeUser(agentUser),
    profile: agentProfile,
    otpSent: !!creationOtp,
    nextStep: "Verify agent phone via POST /:id/verify-otp",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIST AGENTS
// ─────────────────────────────────────────────────────────────────────────────
const listAgents = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  area,
  isActive,
  kycStatus,
  search,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  if (kycStatus && !Object.values(AGENT_KYC_STATUS).includes(kycStatus)) {
    throw ApiError.badRequest(`Invalid kycStatus value: '${kycStatus}'`);
  }

  const userFilter = { role: ROLES.AGENT, isDeleted: false };

  if (isActive !== undefined) {
    userFilter.isActive = isActive === "true" || isActive === true;
  }

  if (search) {
    const safeSearch = escapeRegex(search.trim());
    userFilter.$or = [
      { name: { $regex: safeSearch, $options: "i" } },
      { phone: { $regex: safeSearch } },
      { agentCode: { $regex: safeSearch, $options: "i" } },
    ];
  }

  if (area || kycStatus) {
    const profFilter = {};
    if (area)
      profFilter.area = { $regex: escapeRegex(area.trim()), $options: "i" };
    if (kycStatus) profFilter.kycStatus = kycStatus;

    const matchingProfiles = await AgentProfile.find(profFilter)
      .select("user")
      .lean();
    userFilter._id = { $in: matchingProfiles.map((p) => p.user) };
  }

  const [users, total] = await Promise.all([
    User.find(userFilter)
      .select("name phone email agentCode isActive smsEnabled createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit),
    User.countDocuments(userFilter),
  ]);

  const userIds = users.map((u) => u._id);
  const profiles = await AgentProfile.find({
    user: { $in: userIds },
  }).select(
    "user agentCode area kycStatus status assignedPincodes " +
    "commissionType commissionRateBps joiningDate",
  );

  const profileMap = Object.fromEntries(
    profiles.map((p) => [p.user.toString(), p]),
  );

  const agents = users.map((u) => ({
    ...safeUser(u),
    profile: profileMap[u._id.toString()] || null,
  }));

  return {
    agents,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. UPDATE AGENT AUTH FIELDS
// ─────────────────────────────────────────────────────────────────────────────
const updateAgent = async ({
  agentId,
  updates,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const ALLOWED = ["name", "email", "smsEnabled"];
  const safeUpdates = {};
  ALLOWED.forEach((f) => {
    if (updates[f] !== undefined) safeUpdates[f] = updates[f];
  });

  if (Object.keys(safeUpdates).length === 0)
    throw ApiError.badRequest("No valid fields provided to update.");

  const user = await User.findOneAndUpdate(
    { _id: agentId, role: ROLES.AGENT, isDeleted: false },
    { $set: safeUpdates },
    { returnDocument: "after", runValidators: true },
  ).select("name phone email agentCode isActive smsEnabled createdAt");

  if (!user) throw ApiError.notFound("Agent not found.");

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_UPDATED,
    entity: "User",
    entityId: agentId,
    newData: safeUpdates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(`[Agent] Auth fields updated | ${agentId} | By: ${performedBy}`);
  return safeUser(user);
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPDATE AGENT PROFILE
// ─────────────────────────────────────────────────────────────────────────────
const updateAgentProfile = async ({
  agentId,
  updates,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const profile = await AgentProfile.findOne({ user: agentId });
  if (!profile) throw ApiError.notFound("Agent profile not found.");

  const ALLOWED_PROFILE_FIELDS = [
    "fullName",
    "dateOfBirth",
    "gender",
    "fatherOrSpouseName",
    "alternatePhone",
    "personalEmail",
    "currentAddress",
    "permanentAddress",
    "isSameAddress",
    "area",
    "assignedPincodes",
    "commissionType",
    "commissionRateBps",
    "joiningDate",
    "employeeId",
  ];

  ALLOWED_PROFILE_FIELDS.forEach((f) => {
    if (updates[f] !== undefined) profile.set(f, updates[f]);
  });

  if (updates.bankDetails) {
    if (updates.bankDetails.accountNumber) {
      const acc = updates.bankDetails.accountNumber.trim();
      profile.set("bankDetails.accountNumberEncrypted", cryptoUtil.encrypt(acc));
      profile.set("bankDetails.accountNumberLast4", acc.slice(-4));
    }
    if (updates.bankDetails.accountHolderName !== undefined) {
      profile.set("bankDetails.accountHolderName", updates.bankDetails.accountHolderName);
    }
    if (updates.bankDetails.bankName !== undefined) {
      profile.set("bankDetails.bankName", updates.bankDetails.bankName);
    }
    if (updates.bankDetails.ifscCode !== undefined) {
      profile.set("bankDetails.ifscCode", updates.bankDetails.ifscCode);
    }
    if (updates.bankDetails.branchName !== undefined) {
      profile.set("bankDetails.branchName", updates.bankDetails.branchName);
    }
  }

  if (profile.isSameAddress === true) {
    profile.set("permanentAddress", profile.currentAddress || {});
  }

  await profile.save();

  const auditData = { ...updates };
  if (auditData.bankDetails?.accountNumber) delete auditData.bankDetails.accountNumber;

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_PROFILE_UPDATED,
    entity: "AgentProfile",
    entityId: profile._id,
    newData: auditData,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(
    `[Agent] Profile updated | User: ${agentId} | By: ${performedBy}`,
  );
  return profile;
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPLOAD KYC DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────
const uploadAgentKycDocs = async ({
  agentId,
  agentCode,
  files,
  aadhaarNumber,
  panNumber,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const profile = await AgentProfile.findOne({ user: agentId });
  if (!profile) throw ApiError.notFound("Agent profile not found.");

  const ALLOWED_DOCS = [
    "aadhaarFront",
    "aadhaarBack",
    "panCard",
    "photo",
    "signedAgreement",
  ];
  const docUpdates = {};
  const uploadedKeys = [];

  for (const docKey of ALLOWED_DOCS) {
    const file = files[docKey]?.[0];
    if (!file) continue;
    docUpdates[`documents.${docKey}.url`] = file.path;
    docUpdates[`documents.${docKey}.publicId`] = file.filename;
    docUpdates[`documents.${docKey}.resourceType`] =
      file.resource_type || "image";
    docUpdates[`documents.${docKey}.uploadedAt`] = new Date();
    docUpdates[`documents.${docKey}.verified`] = false;
    uploadedKeys.push(docKey);
  }

  if (uploadedKeys.length === 0 && !aadhaarNumber && !panNumber) {
    throw ApiError.badRequest(
      "No valid document files or KYC numbers found. Check field names match: " +
      "aadhaarFront, aadhaarBack, panCard, photo, signedAgreement, aadhaarNumber, panNumber.",
    );
  }

  // Handle Aadhaar Number if provided
  if (aadhaarNumber) {
    const trimmed = aadhaarNumber.trim();
    docUpdates.aadhaarNumberEncrypted = cryptoUtil.encrypt(trimmed);
    docUpdates.aadhaarLast4 = trimmed.slice(-4);
    docUpdates.aadhaarSearchHash = cryptoUtil.hashForSearch(trimmed);
  }

  // Handle PAN Number if provided
  if (panNumber) {
    const trimmed = panNumber.trim().toUpperCase();
    docUpdates.panNumberEncrypted = cryptoUtil.encrypt(trimmed);
    docUpdates.panLast4 = trimmed.slice(-4);
    docUpdates.panSearchHash = cryptoUtil.hashForSearch(trimmed);
  }

  const { kycStatus: currentStatus } = profile;
  if (
    currentStatus === AGENT_KYC_STATUS.PENDING ||
    currentStatus === AGENT_KYC_STATUS.KYC_REJECTED
  ) {
    // Only move to DOCUMENTS_SUBMITTED if images were actually uploaded or numbers were provided
    const isNewSubmission =
      uploadedKeys.length > 0 || aadhaarNumber || panNumber;
    if (isNewSubmission) {
      docUpdates.kycStatus = AGENT_KYC_STATUS.DOCUMENTS_SUBMITTED;
      docUpdates.kycSubmittedAt = new Date();
    }
  }

  const updated = await AgentProfile.findOneAndUpdate(
    { user: agentId },
    { $set: docUpdates },
    { returnDocument: "after" },
  );

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_DOCS_UPLOADED,
    entity: "AgentProfile",
    entityId: profile._id,
    newData: {
      uploadedDocs: uploadedKeys,
      kycStatus: docUpdates.kycStatus || currentStatus,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(
    `[Agent] Docs uploaded | ${agentCode} | Docs: ${uploadedKeys.join(", ")}`,
  );
  return updated;
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. VERIFY / REJECT AGENT KYC
// ─────────────────────────────────────────────────────────────────────────────
const verifyAgentKyc = async ({
  agentId,
  action,
  note,
  performedBy,
  ipAddress,
  requestId,
}) => {
  if (!["approve", "reject", "reset"].includes(action)) {
    throw ApiError.badRequest(
      `Invalid action '${action}'. Must be 'approve', 'reject', or 'reset'.`,
    );
  }

  // Pre-fetch if attempting a reset, to gather documents for cloudinary deletion
  let existingProfile = null;
  if (action === "reset") {
    existingProfile = await AgentProfile.findOne({ user: agentId });
    if (!existingProfile) throw ApiError.notFound("Agent profile not found.");
    if (existingProfile.kycStatus === AGENT_KYC_STATUS.PENDING) {
      throw ApiError.badRequest("KYC is already pending. Nothing to reset.");
    }
  }

  const isApprove = action === "approve";
  const isReset = action === "reset";

  let kycUpdates;
  if (isReset) {
    kycUpdates = {
      kycStatus: AGENT_KYC_STATUS.PENDING,
      kycSubmittedAt: null,
      kycVerifiedAt: null,
      kycVerifiedBy: null,
      kycRejectedAt: null,
      kycRejectedBy: null,
      kycRejectionNote: note || "KYC reset by admin.",
      documents: {},
    };
  } else if (isApprove) {
    kycUpdates = {
      kycStatus: AGENT_KYC_STATUS.KYC_VERIFIED,
      kycVerifiedAt: new Date(),
      kycVerifiedBy: performedBy,
      kycRejectedAt: null,
      kycRejectedBy: null,
      kycRejectionNote: null,
    };
  } else {
    kycUpdates = {
      kycStatus: AGENT_KYC_STATUS.KYC_REJECTED,
      kycRejectedAt: new Date(),
      kycRejectedBy: performedBy,
      kycRejectionNote: note || "Documents not acceptable.",
      kycVerifiedAt: null,
      kycVerifiedBy: null,
    };
  }

  const query = isReset
    ? { user: agentId } // Reset can be called from verified or rejected states
    : { user: agentId, kycStatus: AGENT_KYC_STATUS.DOCUMENTS_SUBMITTED };

  let updated = await AgentProfile.findOneAndUpdate(
    query,
    { $set: kycUpdates },
    { returnDocument: "after" },
  ).populate("user", "name phone agentCode");

  if (!updated) {
    const exists = await AgentProfile.findOne({ user: agentId });
    if (!exists) throw ApiError.notFound("Agent profile not found.");
    throw ApiError.badRequest(
      `Cannot ${action} KYC. Current status: '${exists.kycStatus}'. ` +
      `Documents must be submitted first or it was concurrently processed.`,
    );
  }

  // Handle Cloudinary Deletion if it's a reset
  if (isReset && existingProfile) {
    const { deleteAssets } = require("../utils/cloudinary.util");
    const publicIds = [];
    const ALLOWED_DOCS = ["aadhaarFront", "aadhaarBack", "panCard", "photo", "signedAgreement"];
    for (const key of ALLOWED_DOCS) {
      if (existingProfile.documents?.[key]?.publicId) {
        publicIds.push(existingProfile.documents[key].publicId);
      }
    }
    if (publicIds.length > 0) {
      await deleteAssets(publicIds);
      logger.info(`[Agent] Deleted ${publicIds.length} cloudinary assets during KYC reset.`);
    }
  }

  const auditAction = isReset
    ? AUDIT_ACTIONS.AGENT_KYC_REJECTED // or create a specific AUDIT_ACTIONS.AGENT_KYC_RESET
    : isApprove
      ? AUDIT_ACTIONS.AGENT_KYC_APPROVED
      : AUDIT_ACTIONS.AGENT_KYC_REJECTED;

  await AuditLog.log({
    performedBy,
    action: auditAction,
    entity: "AgentProfile",
    entityId: updated._id,
    oldData: { kycStatus: isReset ? existingProfile.kycStatus : AGENT_KYC_STATUS.DOCUMENTS_SUBMITTED },
    newData: kycUpdates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(
    `[Agent] KYC ${isReset ? "RESET" : isApprove ? "APPROVED" : "REJECTED"} | ` +
    `${updated.user?.agentCode} | By: ${performedBy}`,
  );
  return {
    message: `Agent KYC ${isReset ? "reset" : isApprove ? "approved" : "rejected"} successfully.`,
    agentCode: updated.user?.agentCode,
    kycStatus: updated.kycStatus,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. CHANGE AGENT STATUS (suspend / unsuspend / terminate)
// ─────────────────────────────────────────────────────────────────────────────
const changeAgentStatus = async ({
  agentId,
  action,
  reason,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const VALID_ACTIONS = ["suspend", "unsuspend", "terminate"];
  if (!VALID_ACTIONS.includes(action)) {
    throw ApiError.badRequest(
      `Invalid action '${action}'. Must be one of: ${VALID_ACTIONS.join(", ")}.`,
    );
  }

  const [user, profile] = await Promise.all([
    User.findOne({ _id: agentId, isDeleted: false }),
    AgentProfile.findOne({ user: agentId }),
  ]);

  if (!user) throw ApiError.notFound("Agent not found.");
  if (!profile) throw ApiError.notFound("Agent profile not found.");

  if (user._id.toString() === performedBy.toString()) {
    throw ApiError.badRequest("You cannot change your own status.");
  }

  if (profile.status === AGENT_STATUS.TERMINATED) {
    throw ApiError.badRequest(
      "Agent is already terminated. No further status changes allowed.",
    );
  }

  // AGT-S-7: guard — suspend on already-suspended agent
  if (action === "suspend" && profile.status === AGENT_STATUS.SUSPENDED) {
    throw ApiError.badRequest("Agent is already suspended.");
  }

  // AGT-S-6: guard — unsuspend on non-suspended agent
  if (action === "unsuspend" && profile.status !== AGENT_STATUS.SUSPENDED) {
    throw ApiError.badRequest(
      `Cannot unsuspend agent. Current status: '${profile.status}'. Agent is not suspended.`,
    );
  }

  const AUDIT_ACTION_MAP = {
    suspend: AUDIT_ACTIONS.AGENT_SUSPENDED,
    unsuspend: AUDIT_ACTIONS.AGENT_UNSUSPENDED,
    terminate: AUDIT_ACTIONS.AGENT_TERMINATED,
  };

  const profileUpdates = {};
  const userUpdates = {};

  if (action === "suspend") {
    profileUpdates.status = AGENT_STATUS.SUSPENDED;
    profileUpdates.suspendedAt = new Date();
    profileUpdates.suspendedBy = performedBy;
    profileUpdates.suspensionReason = reason;
    userUpdates.isActive = false;
    userUpdates.refreshTokenHash = null;
    userUpdates.refreshTokenFamily = null;
    userUpdates.refreshTokenVersion = 0;
    userUpdates.refreshTokenUpdatedAt = null;
  } else if (action === "unsuspend") {
    profileUpdates.status = AGENT_STATUS.ACTIVE;
    profileUpdates.suspendedAt = null;
    profileUpdates.suspendedBy = null;
    profileUpdates.suspensionReason = null;
    userUpdates.isActive = true;
  } else if (action === "terminate") {
    profileUpdates.status = AGENT_STATUS.TERMINATED;
    profileUpdates.terminatedAt = new Date();
    profileUpdates.terminatedBy = performedBy;
    profileUpdates.terminationReason = reason;
    userUpdates.isActive = false;
    userUpdates.refreshTokenHash = null;
    userUpdates.refreshTokenFamily = null;
    userUpdates.refreshTokenVersion = 0;
    userUpdates.refreshTokenUpdatedAt = null;
  }

  // Cascade counters — populated inside transaction, used in AuditLog after
  let pigmyCascadeCount = 0;
  let customerCascadeCount = 0;

  await withTransaction(async (session) => {
    if (action === "terminate") {
      const agentLedger = await LedgerAccount.findOne(
        { agentRef: agentId, isAgentAccount: true },
        null,
        { session },
      ).lean();

      if (agentLedger?.runningBalanceInPaise > 0) {
        throw ApiError.badRequest(
          `Cannot terminate agent with outstanding cash balance of ` +
          `₹${(agentLedger.runningBalanceInPaise / 100).toFixed(2)}. ` +
          `Agent must deposit all collected cash before termination. ` +
          `If agent is unreachable, use forceClose on day close to override.`,
        );
      }
    }

    await User.findByIdAndUpdate(agentId, { $set: userUpdates }, { session });
    await AgentProfile.findOneAndUpdate(
      { user: agentId },
      { $set: profileUpdates },
      { session },
    );

    // ── Termination cascade — unassign all accounts atomically ──────────────
    if (action === "terminate") {
      const [pigmyResult, customerResult] = await Promise.all([
        PigmyAccount.updateMany(
          {
            assignedAgent: agentId,
            status: ACCOUNT_STATUS.ACTIVE,
            isDeleted: false,
          },
          {
            $set: {
              assignedAgent: null,
              requiresReassignment: true,
              reassignmentReason: "agent_terminated",
            },
          },
          { session },
        ),
        Customer.updateMany(
          { assignedAgent: agentId, isDeleted: false },
          {
            $set: {
              assignedAgent: null,
              requiresReassignment: true,
              reassignmentReason: "agent_terminated",
            },
          },
          { session },
        ),
      ]);

      await LedgerAccount.findOneAndUpdate(
        { agentRef: agentId, isAgentAccount: true },
        { $set: { isActive: false } },
        { session },
      );

      pigmyCascadeCount = pigmyResult.modifiedCount;
      customerCascadeCount = customerResult.modifiedCount;
    }
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTION_MAP[action],
    entity: "AgentProfile",
    entityId: profile._id,
    oldData: { status: profile.status, isActive: user.isActive },
    newData: {
      ...profileUpdates,
      ...userUpdates,
      reason,
      ...(action === "terminate" && {
        cascade: {
          pigmyAccountsUnassigned: pigmyCascadeCount,
          customersUnassigned: customerCascadeCount,
          ledgerDeactivated: true,
        },
      }),
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  // Second audit entry — cascade event independently queryable for RBI audit trail
  if (action === "terminate") {
    await AuditLog.log({
      performedBy,
      action: AUDIT_ACTIONS.AGENT_ACCOUNTS_UNASSIGNED,
      entity: "AgentProfile",
      entityId: profile._id,
      newData: {
        agentId,
        pigmyAccountsUnassigned: pigmyCascadeCount,
        customersUnassigned: customerCascadeCount,
        ledgerDeactivated: true,
        reason,
      },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.SUCCESS,
    }).catch((e) =>
      logger.error(`[Agent] Cascade AuditLog failed: ${e.message}`),
    );
  }

  logger.warn(
    `[Agent] ${action.toUpperCase()} | User: ${agentId} | ` +
    `Reason: ${reason} | By: ${performedBy}`,
  );

  if (action === "suspend" || action === "terminate") {
    evictUserCache(agentId);
  }

  return { agentId, action, message: `Agent ${action}ed successfully.` };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. TOGGLE AGENT ACTIVE/INACTIVE
// ─────────────────────────────────────────────────────────────────────────────
const toggleAgentStatus = async ({
  agentId,
  isActive,
  reason,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const [user, profile] = await Promise.all([
    User.findOne({ _id: agentId, isDeleted: false }),
    AgentProfile.findOne({ user: agentId }),
  ]);

  if (!user) throw ApiError.notFound("Agent not found.");
  if (!profile) throw ApiError.internal("Invariant Violation: Agent profile correctly mapped to user is missing. Please contact admin.");

  if (user._id.toString() === performedBy.toString()) {
    throw ApiError.badRequest("You cannot change your own active status.");
  }

  if (profile.status === AGENT_STATUS.TERMINATED && isActive === true) {
    throw ApiError.badRequest(
      "Cannot reactivate a terminated agent. Contact superadmin.",
    );
  }

  if (profile.status === AGENT_STATUS.SUSPENDED) {
    throw ApiError.badRequest(
      "Cannot toggle active status of a suspended agent. Use unsuspend action first.",
    );
  }

  const oldStatus = user.isActive;

  const userUpdates = { isActive };
  if (!isActive) {
    userUpdates.refreshTokenHash = null;
    userUpdates.refreshTokenFamily = null;
    userUpdates.refreshTokenVersion = 0;
    userUpdates.refreshTokenUpdatedAt = null;
  }

  await withTransaction(async (session) => {
    await User.findByIdAndUpdate(agentId, { $set: userUpdates }, { session });
    await AgentProfile.findOneAndUpdate(
      { user: agentId },
      {
        $set: {
          status: isActive ? AGENT_STATUS.ACTIVE : AGENT_STATUS.INACTIVE,
        },
      },
      { session },
    );
  });

  await AuditLog.log({
    performedBy,
    action: isActive
      ? AUDIT_ACTIONS.AGENT_ACTIVATED
      : AUDIT_ACTIONS.AGENT_DEACTIVATED,
    entity: "User",
    entityId: agentId,
    oldData: { isActive: oldStatus },
    newData: { isActive, reason: reason || null },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(
    `[Agent] ${isActive ? "Activated" : "Deactivated"} | ${agentId} | By: ${performedBy}`,
  );

  if (!isActive) evictUserCache(agentId);

  return { agentId, isActive };
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. GET KYC PENDING LIST
// ─────────────────────────────────────────────────────────────────────────────
const getKycPendingList = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [profiles, total] = await Promise.all([
    AgentProfile.findKycPending()
      .select(
        "agentCode fullName kycStatus documents area kycSubmittedAt createdAt user",
      )
      .populate("user", "name phone agentCode createdAt")
      .sort({ kycSubmittedAt: 1 })
      .skip(skip)
      .limit(safeLimit),
    AgentProfile.countDocuments({
      kycStatus: {
        $in: [AGENT_KYC_STATUS.PENDING, AGENT_KYC_STATUS.DOCUMENTS_SUBMITTED],
      },
    }),
  ]);

  return {
    profiles,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. RESEND AGENT CREATION OTP
// ─────────────────────────────────────────────────────────────────────────────
const resendAgentCreationOtp = async ({
  agentId,
  agentCode,
  phone,
  name,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  const user = await User.findOne({ _id: agentId, role: ROLES.AGENT, isDeleted: false });
  if (!user) throw ApiError.notFound("Agent not found.");
  if (user.phoneVerified) {
    throw ApiError.badRequest("Agent's phone is already verified.");
  }

  // Rate-guard — prevent spam: must wait 60s between resend attempts
  const recentOtp = await AgentOtp.findOne({
    agentUserId: agentId,
    purpose: "creation",
    isUsed: false,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  });
  if (recentOtp) {
    throw ApiError.tooManyRequests(
      "OTP already sent. Please wait 1 minute before resending.",
    );
  }

  const otp = await AgentOtp.generateOtp(agentId, phone, "creation");
  await smsService.sendKycOtp(phone, name, otp).catch((e) => {
    logger.warn(`[Agent] Resend creation OTP SMS failed | ${agentCode} | ${e.message}`);
  });
  if (process.env.NODE_ENV !== "production") {
    logger.info(`[Agent][DEV] Resent creation OTP for ${agentCode}: ${otp}`);
  }

  logger.info(`[Agent] Creation OTP resent | ${agentCode} | By: ${requestedBy}`);
  return { message: `OTP sent to ${user.phone.replace(/.(?=.{4})/g, "*")}` };
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. VERIFY AGENT CREATION OTP
// ─────────────────────────────────────────────────────────────────────────────
const verifyAgentCreationOtp = async ({
  agentId,
  otp,
  verifiedBy,
  ipAddress,
  requestId,
}) => {
  const user = await User.findOne({ _id: agentId, role: ROLES.AGENT, isDeleted: false });
  if (!user) throw ApiError.notFound("Agent not found.");
  if (user.phoneVerified) {
    throw ApiError.badRequest("Agent's phone is already verified.");
  }

  await withTransaction(async (session) => {
    const result = await AgentOtp.verifyOtp(
      agentId,
      user.phone,
      "creation",
      otp,
      session,
    );
    if (!result.valid) throw ApiError.badRequest(result.reason);

    await User.findByIdAndUpdate(
      agentId,
      { $set: { phoneVerified: true, phoneVerifiedAt: new Date() } },
      { session },
    );
  });

  await AuditLog.log({
    performedBy: verifiedBy,
    action: AUDIT_ACTIONS.PHONE_OTP_VERIFIED,
    entity: "User",
    entityId: agentId,
    newData: { phoneVerified: true },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.info(`[Agent] Phone verified | AgentId: ${agentId} | By: ${verifiedBy}`);
  return { message: "Agent phone verified successfully." };
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. ADMIN: RESET AGENT PASSWORD
// No OTP required — admin is already authenticated.
// Agent is force-logged out (all refresh tokens invalidated) after this.
// ─────────────────────────────────────────────────────────────────────────────
const changeAgentPassword = async ({
  agentId,
  newPassword,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const user = await User.findOne({ _id: agentId, role: ROLES.AGENT, isDeleted: false })
    .select("+password");
  if (!user) throw ApiError.notFound("Agent not found.");

  // Hash is done by the pre-save hook in User.model — just set and save
  user.password = newPassword;
  // Force-logout: invalidate all existing sessions so agent must re-login
  user.refreshTokenHash = null;
  user.refreshTokenFamily = null;
  user.refreshTokenVersion = 0;
  user.refreshTokenUpdatedAt = null;
  await user.save();

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_UPDATED,
    entity: "User",
    entityId: agentId,
    newData: { passwordReset: true, sessionsInvalidated: true },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.warn(
    `[Agent] PASSWORD RESET by admin | AgentId: ${agentId} | By: ${performedBy}`,
  );
  return {
    message: "Agent password reset successfully. Agent has been logged out of all devices.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 13. ADMIN: REQUEST AGENT PHONE CHANGE
// Validates new phone uniqueness, stores as pendingPhone, sends OTP to new number.
// Phone is NOT changed until OTP is verified.
// ─────────────────────────────────────────────────────────────────────────────
const requestAgentPhoneChange = async ({
  agentId,
  newPhone,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const [agent, phoneConflict] = await Promise.all([
    User.findOne({ _id: agentId, role: ROLES.AGENT, isDeleted: false }),
    User.findOne({ phone: newPhone, isDeleted: false }),
  ]);

  if (!agent) throw ApiError.notFound("Agent not found.");

  if (agent.phone === newPhone) {
    throw ApiError.badRequest("New phone number is the same as the current phone number.");
  }

  if (phoneConflict) {
    throw ApiError.conflict(
      `Phone ${newPhone.replace(/.(?=.{4})/g, "*")} is already registered with another account.`,
    );
  }

  // Rate-guard: prevent OTP spam — 60s cooldown per agent
  const recentOtp = await AgentOtp.findOne({
    agentUserId: agentId,
    purpose: "phone_change",
    isUsed: false,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  });
  if (recentOtp) {
    throw ApiError.tooManyRequests(
      "OTP already sent. Please wait 1 minute before resending.",
    );
  }

  // Store pending new phone (NOT committed until OTP verified)
  await User.findByIdAndUpdate(agentId, {
    $set: {
      pendingPhone: newPhone,
      pendingPhoneOtpExpiry: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    },
  });

  // Send OTP to the NEW phone — proves admin controls the target number
  const otp = await AgentOtp.generateOtp(agentId, newPhone, "phone_change");
  await smsService.sendKycOtp(newPhone, agent.name, otp).catch((e) => {
    logger.warn(`[Agent] Phone change OTP SMS failed | AgentId: ${agentId} | ${e.message}`);
  });
  if (process.env.NODE_ENV !== "production") {
    logger.info(`[Agent][DEV] Phone change OTP for ${agentId}: ${otp}`);
  }

  logger.info(
    `[Agent] Phone change OTP sent | AgentId: ${agentId} | NewPhone: ${newPhone.replace(/.(?=.{4})/g, "*")} | By: ${performedBy}`,
  );
  return {
    message: `OTP sent to ${newPhone.replace(/.(?=.{4})/g, "*")}. Enter OTP to confirm phone change.`,
    pendingPhone: newPhone.replace(/.(?=.{4})/g, "*"),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. ADMIN: VERIFY AGENT PHONE CHANGE OTP
// Atomically commits the phone swap and invalidates all agent sessions.
// Agent must re-login with the new phone number after this.
// ─────────────────────────────────────────────────────────────────────────────
const verifyAgentPhoneChange = async ({
  agentId,
  otp,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const agent = await User.findOne({ _id: agentId, role: ROLES.AGENT, isDeleted: false })
    .select("+pendingPhone +pendingPhoneOtpExpiry");
  if (!agent) throw ApiError.notFound("Agent not found.");

  if (!agent.pendingPhone) {
    throw ApiError.badRequest(
      "No phone change request found. Please request a phone change first.",
    );
  }

  if (agent.pendingPhoneOtpExpiry && agent.pendingPhoneOtpExpiry < new Date()) {
    // Clear stale pending data
    await User.findByIdAndUpdate(agentId, {
      $set: { pendingPhone: null, pendingPhoneOtpExpiry: null },
    });
    throw ApiError.badRequest(
      "Phone change request has expired. Please request a new phone change.",
    );
  }

  const oldPhone = agent.phone;
  const newPhone = agent.pendingPhone;

  // Double-check no conflict before commit (another user may have taken the number)
  const conflict = await User.findOne({ phone: newPhone, isDeleted: false });
  if (conflict && conflict._id.toString() !== agentId.toString()) {
    await User.findByIdAndUpdate(agentId, {
      $set: { pendingPhone: null, pendingPhoneOtpExpiry: null },
    });
    throw ApiError.conflict(
      `Phone ${newPhone.replace(/.(?=.{4})/g, "*")} was taken while OTP was pending. ` +
      `Please start over with a different number.`,
    );
  }

  await withTransaction(async (session) => {
    const result = await AgentOtp.verifyOtp(
      agentId,
      newPhone,
      "phone_change",
      otp,
      session,
    );
    if (!result.valid) throw ApiError.badRequest(result.reason);

    // Atomically: commit new phone, clear pending, force-logout all sessions
    await User.findByIdAndUpdate(
      agentId,
      {
        $set: {
          phone: newPhone,
          pendingPhone: null,
          pendingPhoneOtpExpiry: null,
          refreshTokenHash: null,
          refreshTokenFamily: null,
          refreshTokenVersion: 0,
          refreshTokenUpdatedAt: null,
        },
      },
      { session },
    );
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_UPDATED,
    entity: "User",
    entityId: agentId,
    oldData: { phone: oldPhone.replace(/.(?=.{4})/g, "*") },
    newData: { phone: newPhone.replace(/.(?=.{4})/g, "*"), sessionsInvalidated: true },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Agent] AuditLog failed: ${e.message}`));

  logger.warn(
    `[Agent] PHONE CHANGED | AgentId: ${agentId} | ` +
    `Old: ${oldPhone.replace(/.(?=.{4})/g, "*")} → New: ${newPhone.replace(/.(?=.{4})/g, "*")} | ` +
    `By: ${performedBy}`,
  );
  return {
    message: "Agent phone number changed successfully. Agent has been logged out of all devices.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STRICT PII AUDIT HELPER (mirrors customer.service.js — BLOCKING)
// If we cannot write the audit log, we DENY the PII access.
// This guarantees there is always a paper trail for every decrypt.
// ─────────────────────────────────────────────────────────────────────────────
const auditPii = async (payload) => {
  try {
    await AuditLog.log(payload);
  } catch (e) {
    logger.error(`[AuditLog] Agent PII audit write FAILED: ${e.message}`, { payload });
    throw ApiError.internal(
      "PII access denied: audit trail could not be recorded. " +
      "Contact superadmin — this may indicate a database connectivity issue.",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET DECRYPTED AGENT AADHAAR
// Requires VIEW_DECRYPTED_PII permission (admin/superadmin only).
// Audit is BLOCKING — if it fails, the decrypt is denied.
// ─────────────────────────────────────────────────────────────────────────────
const getDecryptedAgentAadhar = async ({
  agentProfile,
  requestingUserRole,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  const { ROLES: R } = require("../config/constants");
  if (![R.SUPERADMIN, R.ADMIN].includes(requestingUserRole)) {
    throw ApiError.forbidden(
      "Access denied. Only admins and superadmins can view decrypted Aadhaar.",
    );
  }

  // Re-fetch with the encrypted field explicitly selected (select: false by default)
  const freshProfile = await AgentProfile.findById(agentProfile._id).select(
    "+aadhaarNumberEncrypted",
  );
  if (!freshProfile) throw ApiError.notFound("Agent profile not found.");

  if (!freshProfile.aadhaarNumberEncrypted) {
    throw ApiError.badRequest(
      "Aadhaar number has not been submitted for this agent yet.",
    );
  }

  const decrypted = cryptoUtil.decrypt(freshProfile.aadhaarNumberEncrypted);

  // BLOCKING audit — deny access if audit write fails
  await auditPii({
    performedBy: requestedBy,
    action: AUDIT_ACTIONS.AADHAAR_VIEWED,
    entity: "AgentProfile",
    entityId: agentProfile._id,
    newData: { field: "aadhaar", agentCode: agentProfile.agentCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { aadhaar: decrypted, masked: freshProfile.maskedAadhaar };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET DECRYPTED AGENT PAN
// Requires VIEW_DECRYPTED_PII permission (admin/superadmin only).
// Audit is BLOCKING — if it fails, the decrypt is denied.
// ─────────────────────────────────────────────────────────────────────────────
const getDecryptedAgentPan = async ({
  agentProfile,
  requestingUserRole,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  const { ROLES: R } = require("../config/constants");
  if (![R.SUPERADMIN, R.ADMIN].includes(requestingUserRole)) {
    throw ApiError.forbidden(
      "Access denied. Only admins and superadmins can view decrypted PAN.",
    );
  }

  // Re-fetch with the encrypted field explicitly selected (select: false by default)
  const freshProfile = await AgentProfile.findById(agentProfile._id).select(
    "+panNumberEncrypted",
  );
  if (!freshProfile) throw ApiError.notFound("Agent profile not found.");

  if (!freshProfile.panNumberEncrypted) {
    throw ApiError.badRequest(
      "PAN number has not been submitted for this agent yet.",
    );
  }

  const decrypted = cryptoUtil.decrypt(freshProfile.panNumberEncrypted);

  // BLOCKING audit — deny access if audit write fails
  await auditPii({
    performedBy: requestedBy,
    action: AUDIT_ACTIONS.PAN_VIEWED,
    entity: "AgentProfile",
    entityId: agentProfile._id,
    newData: { field: "pan", agentCode: agentProfile.agentCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { pan: decrypted, masked: freshProfile.maskedPan };
};

module.exports = {
  createAgent,
  listAgents,
  updateAgent,
  updateAgentProfile,
  uploadAgentKycDocs,
  verifyAgentKyc,
  changeAgentStatus,
  toggleAgentStatus,
  getKycPendingList,
  // Phone OTP — creation + change
  resendAgentCreationOtp,
  verifyAgentCreationOtp,
  changeAgentPassword,
  requestAgentPhoneChange,
  verifyAgentPhoneChange,
  // PII decryption (admin/superadmin only, blocking audit)
  getDecryptedAgentAadhar,
  getDecryptedAgentPan,
};
