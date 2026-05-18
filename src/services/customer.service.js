// src/services/customer.service.js
"use strict";

const Customer = require("../models/Customer.model");
const CustomerOtp = require("../models/CustomerOtp.model");
const SavingAccount = require("../models/SavingAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const User = require("../models/User.model");
const bcrypt = require("bcrypt");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const smsService = require("../utils/sms.service");
const AuditLog = require("../models/AuditLog.model");

const {
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  ROLES,
  PAGINATION,
  ACCOUNT_STATUS,
  LOAN_STATUS,
  KYC_STATUS,
} = require("../config/constants");

const { generateCustomerCode } = require("../utils/generateCode");
const { maskPhone } = require("../utils/crypto");
const escapeRegex = require("../utils/escapeRegex");
const withTransaction = require("../utils/withTransaction");

// ─── FIRE-AND-FORGET AUDIT HELPER ─────────────────────────────────────────────
// For non-PII events — failure logged but never blocks the operation.
const audit = (payload) =>
  AuditLog.log(payload).catch((e) =>
    logger.error(`[AuditLog] Failed: ${e.message}`, { payload }),
  );

// ─── STRICT PII AUDIT HELPER ──────────────────────────────────────────────────

const auditPii = async (payload) => {
  try {
    await AuditLog.log(payload);
  } catch (e) {
    logger.error(`[AuditLog] PII audit write FAILED: ${e.message}`, {
      payload,
    });
    throw ApiError.internal(
      "PII access denied: audit trail could not be recorded. " +
      "Contact superadmin — this may indicate a database connectivity issue.",
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE CUSTOMER
// ─────────────────────────────────────────────────────────────────────────────
const createCustomer = async ({
  name,
  phone,
  alternatePhone,
  address,
  city,
  pincode,
  nomineeName,
  nomineeRelation,
  createdBy,
  createdByRole,
  ipAddress,
  requestId,
}) => {
  // ── Agent permission gate ──────────────────────────────────────────────────
  // Admin can disable customer creation for specific agents via AgentProfile.
  // This check only runs for agent role — admin/superadmin always allowed.
  if (createdByRole === ROLES.AGENT) {
    const AgentProfile = require("../models/AgentProfile.model");
    const agentProfile = await AgentProfile.findOne({ user: createdBy })
      .select("permissions")
      .lean();
    if (agentProfile && agentProfile.permissions?.canAddCustomer === false) {
      throw ApiError.forbidden(
        "Customer creation is disabled for your account. Contact your admin to enable this permission.",
      );
    }
  }

  const existing = await Customer.findByPhone(phone);
  if (existing) {
    throw ApiError.conflict(`Phone ${maskPhone(phone)} is already registered.`);
  }

  let customer;
  try {
    customer = await Customer.create({
      name,
      phone,
      alternatePhone: alternatePhone || undefined,
      address,
      city: city || undefined,
      pincode: pincode || undefined,
      nomineeName: nomineeName || undefined,
      nomineeRelation: nomineeRelation || undefined,
      kycStatus: KYC_STATUS.PENDING,
      phoneVerified: false,
      createdBy,
    });
  } catch (e) {
    if (e.code === 11000 && e.keyPattern?.phone) {
      throw ApiError.conflict(
        `Phone ${maskPhone(phone)} is already registered.`,
      );
    }
    throw e;
  }

  const otp = await CustomerOtp.generateOtp(customer._id, phone);
  await smsService.sendKycOtp(phone, name, otp).catch((e) => {
    logger.warn(
      `[Customer] OTP SMS failed on creation | ${customer.customerCode} | ${e.message}`,
    );
  });

  audit({
    performedBy: createdBy,
    action: AUDIT_ACTIONS.CUSTOMER_CREATED,
    entity: "Customer",
    entityId: customer._id,
    newData: { name, phone: maskPhone(phone), customerCode: customer.customerCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(`[Customer] Created | ${customer.customerCode} | by:${createdBy}`);
  return customer;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. RESEND OTP
// ─────────────────────────────────────────────────────────────────────────────
const resendPhoneOtp = async ({
  customer,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  if (customer.phoneVerified) {
    throw ApiError.badRequest("Phone is already verified.");
  }

  const recentOtp = await CustomerOtp.findOne({
    customerId: customer._id,
    isUsed: false,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  });
  if (recentOtp) {
    throw ApiError.tooManyRequests(
      "OTP already sent. Please wait 1 minute before resending.",
    );
  }

  const otp = await CustomerOtp.generateOtp(customer._id, customer.phone);
  await smsService.sendKycOtp(customer.phone, customer.name, otp).catch((e) => {
    logger.warn(
      `[Customer] OTP SMS failed on resend | ${customer.customerCode} | ${e.message}`,
    );
  });

  logger.info(
    `[Customer] OTP resent | ${customer.customerCode} | by:${requestedBy}`,
  );
  return { message: `OTP sent to ${maskPhone(customer.phone)}` };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. VERIFY PHONE OTP
// ─────────────────────────────────────────────────────────────────────────────
const verifyPhoneOtp = async ({
  customer,
  otp,
  verifiedBy,
  ipAddress,
  requestId,
}) => {
  if (customer.phoneVerified) {
    throw ApiError.badRequest("Phone is already verified.");
  }

  const withTransaction = require("../utils/withTransaction");

  await withTransaction(async (session) => {
    const result = await CustomerOtp.verifyOtp(
      customer._id,
      customer.phone,
      otp,
      session
    );
    if (!result.valid) throw ApiError.badRequest(result.reason);

    customer.phoneVerified = true;
    customer.phoneVerifiedAt = new Date();
    customer.kycStatus = KYC_STATUS.PHONE_VERIFIED;
    await customer.save({ validateBeforeSave: false, session });
  });

  audit({
    performedBy: verifiedBy,
    action: AUDIT_ACTIONS.PHONE_OTP_VERIFIED,
    entity: "Customer",
    entityId: customer._id,
    newData: { kycStatus: KYC_STATUS.PHONE_VERIFIED },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(`[Customer] Phone verified | ${customer.customerCode}`);
  return {
    message: "Phone verified successfully.",
    kycStatus: customer.kycStatus,
    nextStep: "Submit Aadhaar and PAN documents for KYC verification.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. SUBMIT KYC DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────
const submitKycDocuments = async ({
  customer,
  aadharRaw,
  panRaw,
  kycDocuments,
  submittedBy,
  ipAddress,
  requestId,
}) => {
  if (!customer.phoneVerified) {
    throw ApiError.badRequest(
      "Phone must be verified before submitting KYC documents.",
    );
  }

  if (customer.kycStatus === KYC_STATUS.KYC_VERIFIED) {
    throw ApiError.badRequest(
      "KYC is already verified. No resubmission needed.",
    );
  }

  if (aadharRaw) {
    const clash = await Customer.findByAadhar(aadharRaw);
    if (clash && clash._id.toString() !== customer._id.toString()) {
      throw ApiError.conflict(
        "Aadhaar number already registered with another customer.",
      );
    }
    customer.aadharRaw = aadharRaw;
  }

  if (panRaw) {
    const clash = await Customer.findByPan(panRaw);
    if (clash && clash._id.toString() !== customer._id.toString()) {
      throw ApiError.conflict(
        "PAN number already registered with another customer.",
      );
    }
    customer.panRaw = panRaw;
  }

  if (kycDocuments) {
    const existing = customer.kycDocuments || {};
    customer.kycDocuments = {
      aadhaarFront: kycDocuments.aadhaarFront ?? existing.aadhaarFront ?? null,
      aadhaarBack: kycDocuments.aadhaarBack ?? existing.aadhaarBack ?? null,
      panCard: kycDocuments.panCard ?? existing.panCard ?? null,
      photo: kycDocuments.photo ?? existing.photo ?? null,
      signature: kycDocuments.signature ?? existing.signature ?? null,
    };
  }

  customer.kycStatus = KYC_STATUS.DOCUMENTS_SUBMITTED;
  customer.kycSubmittedAt = new Date();

  try {
    await customer.save();
  } catch (e) {
    if (e.code === 11000) {
      if (e.keyPattern?.aadharSearchHash) {
        throw ApiError.conflict(
          "Aadhaar number already registered with another customer.",
        );
      }
      if (e.keyPattern?.panSearchHash) {
        throw ApiError.conflict(
          "PAN number already registered with another customer.",
        );
      }
      throw ApiError.conflict(
        "A unique constraint was violated during KYC submission.",
      );
    }
    throw e;
  }

  audit({
    performedBy: submittedBy,
    action: AUDIT_ACTIONS.KYC_DOCUMENTS_SUBMITTED,
    entity: "Customer",
    entityId: customer._id,
    newData: {
      kycStatus: KYC_STATUS.DOCUMENTS_SUBMITTED,
      aadharMasked: customer.aadharMasked,
      panMasked: customer.panMasked,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(
    `[Customer] KYC docs submitted | ${customer.customerCode} | pending review`,
  );
  return {
    message: "KYC documents submitted. Pending admin verification.",
    kycStatus: customer.kycStatus,
    nextStep: "Admin will review and verify your KYC within 24 hours.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. ADMIN — VERIFY KYC
// ─────────────────────────────────────────────────────────────────────────────
const verifyKyc = async ({ customer, verifiedBy, ipAddress, requestId }) => {
  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: customer._id, kycStatus: KYC_STATUS.DOCUMENTS_SUBMITTED },
    {
      $set: {
        kycStatus: KYC_STATUS.KYC_VERIFIED,
        kycVerifiedBy: verifiedBy,
        kycVerifiedAt: new Date(),
        kycRejectedReason: null,
      }
    },
    { returnDocument: "after" }
  );

  if (!updatedCustomer) {
    throw ApiError.badRequest(
      `Cannot verify KYC. Current status is '${customer.kycStatus}'. ` +
      `Documents must be submitted first or it was concurrently processed.`,
    );
  }

  await smsService.sendKycApproved(updatedCustomer.phone, updatedCustomer.name).catch((e) => {
    logger.warn(
      `[Customer] KYC approved SMS failed | ${updatedCustomer.customerCode} | ${e.message}`,
    );
  });

  audit({
    performedBy: verifiedBy,
    action: AUDIT_ACTIONS.KYC_VERIFIED,
    entity: "Customer",
    entityId: updatedCustomer._id,
    newData: {
      kycStatus: KYC_STATUS.KYC_VERIFIED,
      verifiedAt: updatedCustomer.kycVerifiedAt,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(
    `[Customer] KYC verified | ${updatedCustomer.customerCode} | by:${verifiedBy}`,
  );
  return {
    message: "KYC verified. Customer can now open savings accounts.",
    kycStatus: updatedCustomer.kycStatus,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADMIN — REJECT KYC
// ─────────────────────────────────────────────────────────────────────────────
const rejectKyc = async ({
  customer,
  reason,
  rejectedBy,
  ipAddress,
  requestId,
}) => {
  const withTransaction = require("../utils/withTransaction");

  let updatedCustomer;

  await withTransaction(async (session) => {
    updatedCustomer = await Customer.findOneAndUpdate(
      {
        _id: customer._id,
        kycStatus: { $in: [KYC_STATUS.DOCUMENTS_SUBMITTED, KYC_STATUS.KYC_VERIFIED] }
      },
      {
        $set: {
          kycStatus: KYC_STATUS.KYC_REJECTED,
          kycRejectedReason: reason,
          kycVerifiedBy: null,
          kycVerifiedAt: null,
        }
      },
      { returnDocument: "after", session }
    );

    if (!updatedCustomer) {
      throw ApiError.badRequest(
        `Cannot reject KYC. Current status is '${customer.kycStatus}'. ` +
        `Only submitted or previously verified KYC can be rejected.`,
      );
    }

    await SavingAccount.updateMany(
      { customer: updatedCustomer._id, status: ACCOUNT_STATUS.ACTIVE },
      { $set: { status: ACCOUNT_STATUS.FROZEN } },
      { session }
    );

    await PigmyAccount.updateMany(
      { customer: updatedCustomer._id, status: ACCOUNT_STATUS.ACTIVE },
      { $set: { status: ACCOUNT_STATUS.FROZEN } },
      { session }
    );
  });

  await smsService
    .sendKycRejected(updatedCustomer.phone, updatedCustomer.name, reason)
    .catch((e) => {
      logger.warn(
        `[Customer] KYC rejection SMS failed | ${updatedCustomer.customerCode} | ${e.message}`,
      );
    });

  audit({
    performedBy: rejectedBy,
    action: AUDIT_ACTIONS.KYC_REJECTED,
    entity: "Customer",
    entityId: updatedCustomer._id,
    newData: { kycStatus: KYC_STATUS.KYC_REJECTED, reason },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(
    `[Customer] KYC rejected | ${updatedCustomer.customerCode} | reason: ${reason}`,
  );
  return {
    message: "KYC rejected. Customer notified to resubmit. Active accounts frozen.",
    kycStatus: updatedCustomer.kycStatus,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. KYC GATE
// ─────────────────────────────────────────────────────────────────────────────
const assertKycVerified = async (customerId) => {
  const customer = await Customer.findOne({
    _id: customerId,
    isDeleted: false,
  }).select("kycStatus name customerCode");

  if (!customer) {
    throw ApiError.notFound(
      "Customer not found or has been deleted. " +
      "Restore or recreate the customer record before proceeding.",
    );
  }

  if (customer.kycStatus !== KYC_STATUS.KYC_VERIFIED) {
    const messages = {
      [KYC_STATUS.PENDING]:
        "Customer must complete phone OTP verification first.",
      [KYC_STATUS.PHONE_VERIFIED]:
        "Customer must submit Aadhaar and PAN documents.",
      [KYC_STATUS.DOCUMENTS_SUBMITTED]:
        "KYC documents are under admin review. Awaiting approval.",
      [KYC_STATUS.KYC_REJECTED]:
        "KYC was rejected. Customer must resubmit correct documents.",
    };
    throw ApiError.forbidden(
      messages[customer.kycStatus] ??
      "KYC verification is incomplete. Cannot proceed.",
    );
  }

  return customer;
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. GET SINGLE CUSTOMER
// ─────────────────────────────────────────────────────────────────────────────
const getCustomer = async ({ customer, requestingUserRole }) => {
  await customer.populate([
    { path: "assignedAgent", select: "name phone agentCode area" },
    { path: "createdBy", select: "name role" },
    { path: "kycVerifiedBy", select: "name role" },
  ]);

  const result = customer.toObject();

  if (![ROLES.SUPERADMIN, ROLES.ADMIN].includes(requestingUserRole)) {
    delete result.kycDocuments;
    // Agents should not see Aadhaar/PAN — even masked values
    delete result.aadharMasked;
    delete result.panMasked;
    delete result.aadharEncrypted;
    delete result.panEncrypted;
  }

  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. LIST CUSTOMERS
// ─────────────────────────────────────────────────────────────────────────────
const listCustomers = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  search,
  kycStatus,
  assignedAgent,
  isActive,
  isDeleted,       // pass 'true' to view deleted customer archive, or 'all' for both
  requestingUserRole,
  requestingUserId,
}) => {
  // Admins can view anything. Agents can view their own deleted if explicitly requested ('all').
  const showDeleted = isDeleted === 'true' || isDeleted === true;
  const showAll = isDeleted === 'all';

  // Build filter
  const filter = {};
  if (showAll) {
    // no isDeleted filter, return both live and soft-deleted records.
  } else if (showDeleted) {
    filter.isDeleted = true;
  } else {
    filter.isDeleted = false;
  }

  if (requestingUserRole === ROLES.AGENT) {
    // Agent only sees their assigned customers (or ones they created)
    filter.$or = [
      { assignedAgent: requestingUserId },
      { createdBy: requestingUserId }
    ];
  } else if (assignedAgent) {
    filter.assignedAgent = assignedAgent;
  }

  if (kycStatus) filter.kycStatus = kycStatus;
  if (isActive !== undefined && !showDeleted && !showAll) {
    filter.isActive = isActive === "true" || isActive === true;
  }

  if (search) {
    const safeSearch = escapeRegex(search.trim());
    if (filter.$or) {
       filter.$and = [
         { $or: filter.$or },
         { $or: [
           { name: { $regex: safeSearch, $options: "i" } },
           { phone: { $regex: safeSearch } },
           { customerCode: { $regex: safeSearch, $options: "i" } },
         ]}
       ];
       delete filter.$or;
    } else {
       filter.$or = [
         { name: { $regex: safeSearch, $options: "i" } },
         { phone: { $regex: safeSearch } },
         { customerCode: { $regex: safeSearch, $options: "i" } },
       ];
    }
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  // When showDeleted=true or showAll=true, we MUST bypass the pre-find `isDeleted: false` hook
  const buildQuery = (base) =>
    (showDeleted || showAll)
      ? base.setOptions({ _skipDeletedFilter: true })
      : base;

  const [customers, total] = await Promise.all([
    buildQuery(
      Customer.find(filter)
        .select(
          "customerCode name phone aadharMasked panMasked " +
          "kycStatus kycRejectedReason phoneVerified isActive isDeleted deletedReason deletedAt assignedAgent createdBy createdAt",
        )
        .populate("assignedAgent", "name agentCode")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
    ),
    buildQuery(
      Customer.countDocuments(filter)
    ),
  ]);

  // ── Strip PII for agents ─────────────────────────────────────────────────
  const sanitized = requestingUserRole === ROLES.AGENT
    ? customers.map((c) => {
        const obj = c.toObject ? c.toObject() : { ...c };
        delete obj.aadharMasked;
        delete obj.panMasked;
        return obj;
      })
    : customers;

  return {
    customers: sanitized,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. UPDATE CUSTOMER
// ─────────────────────────────────────────────────────────────────────────────
const SAFE_UPDATE_FIELDS = [
  "name",
  "alternatePhone",
  "address",
  "city",
  "pincode",
  "nomineeName",
  "nomineeRelation",
  "smsEnabled",
];

// Optional string fields that have Mongoose match validators.
// Joi allows "" on these (to clear the value), but Mongoose's match
// validator DOES run on empty strings and rejects them — causing a 500
// instead of the intended field clear.
// Fix: coerce "" → undefined so Mongoose unsets the field cleanly.
const OPTIONAL_CLEARABLE_FIELDS = new Set([
  "alternatePhone",
  "city",
  "pincode",
  "nomineeName",
  "nomineeRelation",
]);

const updateCustomer = async ({
  customer,
  updates,
  updatedBy,
  ipAddress,
  requestId,
}) => {
  const safeUpdates = {};
  for (const field of SAFE_UPDATE_FIELDS) {
    if (updates[field] !== undefined) {
      safeUpdates[field] =
        updates[field] === "" && OPTIONAL_CLEARABLE_FIELDS.has(field)
          ? undefined
          : updates[field];
    }
  }

  if (Object.keys(safeUpdates).length === 0) {
    throw ApiError.badRequest("No valid fields provided for update.");
  }

  Object.assign(customer, safeUpdates);
  await customer.save();

  audit({
    performedBy: updatedBy,
    action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    entity: "Customer",
    entityId: customer._id,
    newData: safeUpdates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return customer;
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. ASSIGN / CHANGE AGENT
// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: When the agent on a customer changes, ALL active Pigmy Accounts for
// that customer must be updated atomically. If not, the collection agent and the
// customer record agent would diverge, causing report and reconciliation errors.
// ─────────────────────────────────────────────────────────────────────────────
const assignAgent = async ({
  customer,
  agentId,
  assignedBy,
  ipAddress,
  requestId,
}) => {
  const agent = await User.findOne({
    _id: agentId,
    role: ROLES.AGENT,
    isActive: true,
    isDeleted: false,
  }).select("_id name agentCode");

  if (!agent) {
    throw ApiError.notFound(
      "Agent not found. Ensure the agent exists, is active, and has the AGENT role.",
    );
  }

  // Prevent no-op reassignment
  if (customer.assignedAgent?.toString() === agentId.toString()) {
    throw ApiError.badRequest(
      `Customer ${customer.customerCode} is already assigned to agent ${agent.agentCode}.`,
    );
  }

  const oldAgentId = customer.assignedAgent;
  let pigmyUpdatedCount = 0;

  await withTransaction(async (session) => {
    // 1. Update customer's assigned agent
    customer.assignedAgent = agentId;
    await customer.save({ validateBeforeSave: false, session });

    // 2. Cascade: update ALL active pigmy accounts for this customer
    //    so the collection agent stays in sync with the customer record.
    const pigmyResult = await PigmyAccount.updateMany(
      {
        customer: customer._id,
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      },
      { $set: { assignedAgent: agentId } },
      { session },
    );
    pigmyUpdatedCount = pigmyResult.modifiedCount;
  });

  audit({
    performedBy: assignedBy,
    action: AUDIT_ACTIONS.CUSTOMER_AGENT_CHANGED,
    entity: "Customer",
    entityId: customer._id,
    oldData: { assignedAgent: oldAgentId },
    newData: {
      assignedAgent: agentId,
      newAgentCode: agent.agentCode,
      pigmyAccountsCascaded: pigmyUpdatedCount,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(
    `[Customer] Agent changed | ${customer.customerCode} | ` +
    `Old: ${oldAgentId} | New: ${agent.agentCode} | Pigmy cascaded: ${pigmyUpdatedCount}`,
  );

  await customer.populate("assignedAgent", "name phone agentCode");
  return customer;
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. SOFT DELETE (password-protected)
// CRITICAL: Even with soft-delete, customerId is a foreign key in Transactions,
// Collections, SavingAccounts, PigmyAccounts, LoanAccounts.
// Admin must re-authenticate with their own password before this proceeds.
// This ensures accidental or unauthorized deletions are impossible.
// ─────────────────────────────────────────────────────────────────────────────
const deleteCustomer = async ({
  customer,
  deletedBy,
  adminId,
  adminPassword,
  deletedReason,
  ipAddress,
  requestId,
}) => {
  // ── Step 1: Re-authenticate the admin ─────────────────────────────────────────────
  const admin = await User.findById(adminId).select("+password");
  if (!admin) {
    throw ApiError.unauthorized("Admin account not found. Cannot authorize delete.");
  }
  const isValidPassword = await bcrypt.compare(adminPassword, admin.password);
  if (!isValidPassword) {
    // Audit failed sensitive operation attempts
    audit({
      performedBy: deletedBy,
      action: AUDIT_ACTIONS.CUSTOMER_DELETED,
      entity: "Customer",
      entityId: customer._id,
      newData: { attempt: "FAILED — wrong admin password", customerCode: customer.customerCode },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.FAILURE,
    });
    throw ApiError.unauthorized(
      "Incorrect password. Customer deletion requires correct admin password authentication.",
    );
  }

  // ── Step 2: Block if active accounts exist ──────────────────────────────────────
  const [activeSavingAccounts, activePigmyAccounts, activeLoans] =
    await Promise.all([
      SavingAccount.countDocuments({
        customer: customer._id,
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      }),
      PigmyAccount.countDocuments({
        customer: customer._id,
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      }),
      LoanAccount.countDocuments({
        customer: customer._id,
        status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
        isDeleted: false,
      }),
    ]);

  if (activeSavingAccounts > 0)
    throw ApiError.badRequest(
      `Cannot delete. Customer has ${activeSavingAccounts} active saving account(s). Close them first.`,
    );
  if (activePigmyAccounts > 0)
    throw ApiError.badRequest(
      `Cannot delete. Customer has ${activePigmyAccounts} active pigmy account(s). Close them first.`,
    );
  if (activeLoans > 0)
    throw ApiError.badRequest(
      `Cannot delete. Customer has ${activeLoans} active/overdue loan(s). Close them first.`,
    );

  await customer.softDelete(deletedBy, deletedReason);

  audit({
    performedBy: deletedBy,
    action: AUDIT_ACTIONS.CUSTOMER_DELETED,
    entity: "Customer",
    entityId: customer._id,
    oldData: { name: customer.name, phone: maskPhone(customer.phone) },
    newData: { deletedReason },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(
    `[Customer] Soft deleted | ${customer.customerCode} | by:${deletedBy}`,
  );
  return { message: "Customer deleted successfully." };
};

// ───────────────────────────────────────────────────────────────────────────────
// 12b. RESTORE CUSTOMER (password-protected, admin only)
// Industry standard: a soft-deleted record must be recoverable.
// Phone uniqueness conflict: if the same phone has been re-registered on a NEW
// active customer, we CANNOT restore. Admin must change the phone first.
// Aadhaar/PAN conflicts are handled the same way.
// ───────────────────────────────────────────────────────────────────────────────
const restoreCustomer = async ({
  customerId,
  restoredBy,
  adminId,
  adminPassword,
  ipAddress,
  requestId,
}) => {
  // Step 1: Admin re-authentication (same pattern as delete)
  const admin = await User.findById(adminId).select("+password");
  if (!admin) throw ApiError.unauthorized("Admin account not found.");
  const isValid = await bcrypt.compare(adminPassword, admin.password);
  if (!isValid) {
    audit({
      performedBy: restoredBy,
      action: AUDIT_ACTIONS.CUSTOMER_RESTORED,
      entity: "Customer",
      entityId: customerId,
      newData: { attempt: "FAILED — wrong admin password" },
      ipAddress,
      requestId,
      status: AUDIT_STATUS.FAILURE,
    });
    throw ApiError.unauthorized("Incorrect password. Restore requires admin re-authentication.");
  }

  // Step 2: Load the deleted customer (must bypass the pre-find soft-delete filter)
  const customer = await Customer.findOne({ _id: customerId, isDeleted: true }).setOptions({
    _skipDeletedFilter: true,
  });
  if (!customer) throw ApiError.notFound("Deleted customer not found.");

  // Step 3: Conflict check — phone uniqueness
  // The phone field has a unique index. If another ACTIVE customer now owns this phone,
  // we cannot restore without first changing this customer's phone.
  const phoneConflict = await Customer.findOne({
    phone: customer.phone,
    _id: { $ne: customer._id },
    isDeleted: false,
  });
  if (phoneConflict) {
    throw ApiError.conflict(
      `Cannot restore: phone ${maskPhone(customer.phone)} is now registered to ` +
      `another active customer (${phoneConflict.customerCode}). ` +
      `Edit the phone number on this archived record first, then restore.`,
    );
  }

  // Step 4: Conflict check — Aadhaar uniqueness
  if (customer.aadharSearchHash) {
    const aadharConflict = await Customer.findOne({
      aadharSearchHash: customer.aadharSearchHash,
      _id: { $ne: customer._id },
      isDeleted: false,
    }).setOptions({ _skipDeletedFilter: true });
    if (aadharConflict) {
      throw ApiError.conflict(
        `Cannot restore: Aadhaar is now linked to another active customer (${aadharConflict.customerCode}). ` +
        `This may indicate a data integrity issue. Contact superadmin.`,
      );
    }
  }

  // Step 5: Conflict check — PAN uniqueness
  if (customer.panSearchHash) {
    const panConflict = await Customer.findOne({
      panSearchHash: customer.panSearchHash,
      _id: { $ne: customer._id },
      isDeleted: false,
    }).setOptions({ _skipDeletedFilter: true });
    if (panConflict) {
      throw ApiError.conflict(
        `Cannot restore: PAN is now linked to another active customer (${panConflict.customerCode}). ` +
        `Contact superadmin.`,
      );
    }
  }

  // Step 6: Restore
  await customer.restore(restoredBy);

  audit({
    performedBy: restoredBy,
    action: AUDIT_ACTIONS.CUSTOMER_RESTORED,
    entity: "Customer",
    entityId: customer._id,
    newData: { name: customer.name, customerCode: customer.customerCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.info(`[Customer] Restored | ${customer.customerCode} | by:${restoredBy}`);
  return { message: `Customer ${customer.customerCode} restored successfully.`, customer };
};

// ─────────────────────────────────────────────────────────────────────────────
// 13. KYC PENDING LIST (with agent attribution)
// ─────────────────────────────────────────────────────────────────────────────
const getKycPendingList = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
} = {}) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [customers, total] = await Promise.all([
    Customer.find({ kycStatus: KYC_STATUS.DOCUMENTS_SUBMITTED })
      .select(
        "customerCode name phone aadharMasked panMasked " +
        "kycSubmittedAt assignedAgent createdBy",
      )
      .populate("assignedAgent", "name agentCode")
      .populate("createdBy", "name agentCode role") // ← Agent attribution for KYC reviewers
      .sort({ kycSubmittedAt: 1 })
      .skip(skip)
      .limit(safeLimit),
    Customer.countDocuments({ kycStatus: KYC_STATUS.DOCUMENTS_SUBMITTED }),
  ]);

  return {
    customers,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. ADMIN: REQUEST CUSTOMER PHONE CHANGE (Step 1)
// Validates new phone uniqueness, stores as pendingPhone, sends OTP to new number.
// Phone is NOT changed until OTP is verified (Step 2).
// Mirrors the agent phone-change flow for consistency.
// ─────────────────────────────────────────────────────────────────────────────
const requestCustomerPhoneChange = async ({
  customer,
  newPhone,
  performedBy,
  ipAddress,
  requestId,
}) => {
  // Check the new phone is not the same
  if (customer.phone === newPhone) {
    throw ApiError.badRequest("New phone number is the same as the current phone number.");
  }

  // Uniqueness check — across the entire Customer collection
  const conflict = await Customer.findOne({ phone: newPhone }).setOptions({ _skipDeletedFilter: true });
  if (conflict && conflict._id.toString() !== customer._id.toString()) {
    throw ApiError.conflict(
      `Phone ${maskPhone(newPhone)} is already registered with another customer.`,
    );
  }

  // Rate-guard: prevent OTP spam — 60s cooldown
  const recentOtp = await CustomerOtp.findOne({
    customerId: customer._id,
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
  await Customer.findByIdAndUpdate(customer._id, {
    $set: {
      pendingPhone: newPhone,
      pendingPhoneOtpExpiry: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    },
  });

  // Send OTP to the NEW phone number — proves the target number is reachable
  const otp = await CustomerOtp.generateOtp(customer._id, newPhone, "phone_change");
  await smsService.sendKycOtp(newPhone, customer.name, otp).catch((e) => {
    logger.warn(`[Customer] Phone change OTP SMS failed | ${customer.customerCode} | ${e.message}`);
  });

  if (process.env.NODE_ENV !== "production") {
    logger.info(`[Customer][DEV] Phone change OTP for ${customer.customerCode}: ${otp}`);
  }

  logger.info(
    `[Customer] Phone change OTP sent | ${customer.customerCode} | ` +
    `NewPhone: ${maskPhone(newPhone)} | By: ${performedBy}`,
  );

  audit({
    performedBy,
    action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    entity: "Customer",
    entityId: customer._id,
    newData: { action: "phone_change_otp_requested", pendingPhone: maskPhone(newPhone) },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return {
    message: `OTP sent to ${maskPhone(newPhone)}. Enter OTP to confirm phone change.`,
    pendingPhone: maskPhone(newPhone),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. ADMIN: VERIFY CUSTOMER PHONE CHANGE OTP (Step 2)
// Atomically commits the new phone number after OTP verification.
// Old OTPs for this customer are implicitly invalidated by the purpose + customerId index.
// ─────────────────────────────────────────────────────────────────────────────
const verifyCustomerPhoneChange = async ({
  customer,
  otp,
  performedBy,
  ipAddress,
  requestId,
}) => {
  // Re-fetch with pendingPhone fields (not included in resolveCustomer by default)
  const freshCustomer = await Customer.findById(customer._id)
    .select("+pendingPhone +pendingPhoneOtpExpiry");
  if (!freshCustomer) throw ApiError.notFound("Customer not found.");

  if (!freshCustomer.pendingPhone) {
    throw ApiError.badRequest(
      "No phone change request is pending. Please request a phone change first.",
    );
  }

  if (freshCustomer.pendingPhoneOtpExpiry && freshCustomer.pendingPhoneOtpExpiry < new Date()) {
    // Clear stale pending data
    await Customer.findByIdAndUpdate(customer._id, {
      $set: { pendingPhone: null, pendingPhoneOtpExpiry: null },
    });
    throw ApiError.badRequest(
      "Phone change request has expired. Please request a new phone change.",
    );
  }

  const oldPhone = freshCustomer.phone;
  const newPhone = freshCustomer.pendingPhone;

  // Race-condition guard: verify no other customer grabbed the number while OTP was pending
  const conflict = await Customer.findOne({ phone: newPhone })
    .setOptions({ _skipDeletedFilter: true });
  if (conflict && conflict._id.toString() !== customer._id.toString()) {
    await Customer.findByIdAndUpdate(customer._id, {
      $set: { pendingPhone: null, pendingPhoneOtpExpiry: null },
    });
    throw ApiError.conflict(
      `Phone ${maskPhone(newPhone)} was registered by another customer while OTP was pending. ` +
      `Please start over with a different number.`,
    );
  }

  await withTransaction(async (session) => {
    const result = await CustomerOtp.verifyOtp(
      customer._id,
      newPhone,
      otp,
      session,
      "phone_change",
    );
    if (!result.valid) throw ApiError.badRequest(result.reason);

    // Atomically commit: new phone live, pending fields cleared
    await Customer.findByIdAndUpdate(
      customer._id,
      {
        $set: {
          phone: newPhone,
          pendingPhone: null,
          pendingPhoneOtpExpiry: null,
        },
      },
      { session },
    );
  });

  audit({
    performedBy,
    action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
    entity: "Customer",
    entityId: customer._id,
    oldData: { phone: maskPhone(oldPhone) },
    newData: { phone: maskPhone(newPhone), action: "phone_changed" },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  logger.warn(
    `[Customer] PHONE CHANGED | ${customer.customerCode} | ` +
    `Old: ${maskPhone(oldPhone)} → New: ${maskPhone(newPhone)} | By: ${performedBy}`,
  );
  return {
    message: "Customer phone number changed successfully.",
    newPhone: maskPhone(newPhone),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. GET DECRYPTED AADHAAR
// ─────────────────────────────────────────────────────────────────────────────
const getDecryptedAadhar = async ({
  customer,
  requestingUserRole,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  if (![ROLES.SUPERADMIN, ROLES.ADMIN].includes(requestingUserRole)) {
    throw ApiError.forbidden(
      "Access denied. Only admins and superadmins can view decrypted Aadhaar.",
    );
  }

  const freshCustomer = await Customer.findById(customer._id).select(
    "+aadharEncrypted",
  );
  if (!freshCustomer) throw ApiError.notFound("Customer not found.");

  const decrypted = freshCustomer.getDecryptedAadhar();

  await auditPii({
    performedBy: requestedBy,
    action: AUDIT_ACTIONS.AADHAAR_VIEWED,
    entity: "Customer",
    entityId: customer._id,
    newData: { field: "aadhaar", customerCode: customer.customerCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { aadhaar: decrypted, masked: customer.aadharMasked };
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. GET DECRYPTED PAN
// ─────────────────────────────────────────────────────────────────────────────
const getDecryptedPanCard = async ({
  customer,
  requestingUserRole,
  requestedBy,
  ipAddress,
  requestId,
}) => {
  if (![ROLES.SUPERADMIN, ROLES.ADMIN].includes(requestingUserRole)) {
    throw ApiError.forbidden(
      "Access denied. Only admins and superadmins can view decrypted PAN.",
    );
  }

  const freshCustomer = await Customer.findById(customer._id).select(
    "+panEncrypted",
  );
  if (!freshCustomer) throw ApiError.notFound("Customer not found.");

  const decrypted = freshCustomer.getDecryptedPan();

  await auditPii({
    performedBy: requestedBy,
    action: AUDIT_ACTIONS.PAN_VIEWED,
    entity: "Customer",
    entityId: customer._id,
    newData: { field: "pan", customerCode: customer.customerCode },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  });

  return { pan: decrypted, masked: customer.panMasked };
};

// ─────────────────────────────────────────────────────────────────────────────
// 16. UNIFIED LOOKUP (BY ACCOUNT NUMBER, PHONE, OR NAME)
// ─────────────────────────────────────────────────────────────────────────────
const lookupCustomerAndAccounts = async ({ search }) => {
  if (!search) throw ApiError.badRequest("Search query is required.");

  const safeSearch = escapeRegex(search.trim());
  const exactSearch = search.trim();
  let customerId = null;

  // 1. Try finding by exactly matching an account number first
  const saving = await SavingAccount.findOne({ accountNumber: exactSearch }).lean();
  if (saving) customerId = saving.customer;

  if (!customerId) {
    const pigmy = await PigmyAccount.findOne({ accountNumber: exactSearch }).lean();
    if (pigmy) customerId = pigmy.customer;
  }

  if (!customerId) {
    const loan = await LoanAccount.findOne({ loanAccountNumber: exactSearch }).lean();
    if (loan) customerId = loan.customer;
  }

  // 2. If no account match, search customer by name, phone, or code
  if (!customerId) {
    const customer = await Customer.findOne({
      isDeleted: false,
      $or: [
        { name: { $regex: safeSearch, $options: "i" } },
        { phone: exactSearch },
        { customerCode: exactSearch.toUpperCase() },
      ],
    }).select("_id");
    if (customer) customerId = customer._id;
  }

  if (!customerId) {
    throw ApiError.notFound(`No customer or account found matching "${exactSearch}".`);
  }

  // 3. Fetch full profile and active accounts
  // Include only photo + signature from kycDocuments for identity verification at the counter.
  // Sensitive docs (aadhaar, pan) are deliberately excluded.
  const customerDoc = await Customer.findById(customerId)
    .select("customerCode name phone city address kycStatus kycDocuments.photo kycDocuments.signature")
    .lean();

  const [savingAccounts, pigmyAccounts, loanAccounts] = await Promise.all([
    SavingAccount.find({ customer: customerId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false }).lean(),
    PigmyAccount.find({ customer: customerId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false }).lean(),
    LoanAccount.find({ customer: customerId, status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] }, isDeleted: false }).lean(),
  ]);

  return {
    customer: customerDoc,
    accounts: {
      savings: savingAccounts,
      pigmys: pigmyAccounts,
      loans: loanAccounts,
    },
  };
};

module.exports = {
  createCustomer,
  resendPhoneOtp,
  verifyPhoneOtp,
  submitKycDocuments,
  verifyKyc,
  rejectKyc,
  assertKycVerified,
  getCustomer,
  listCustomers,
  updateCustomer,
  assignAgent,
  deleteCustomer,
  restoreCustomer,
  getKycPendingList,
  requestCustomerPhoneChange,
  verifyCustomerPhoneChange,
  getDecryptedAadhar,
  getDecryptedPanCard,
  lookupCustomerAndAccounts,
};
