// src/services/reassignment.service.js
// Owns the reassignment queue lifecycle — runs AFTER agent termination cascade.
// agent.service.js fires the event (sets requiresReassignment: true).
// This service handles the aftermath: queue visibility + bulk reassign.
"use strict";

const PigmyAccount = require("../models/PigmyAccount.model");
const Customer = require("../models/Customer.model");
const User = require("../models/User.model");
const AgentProfile = require("../models/AgentProfile.model");
const AuditLog = require("../models/AuditLog.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const withTransaction = require("../utils/withTransaction");
const {
  ROLES,
  AGENT_KYC_STATUS,
  AGENT_STATUS,
  ACCOUNT_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  PAGINATION,
} = require("../config/constants");

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET REASSIGNMENT QUEUE
// Returns paginated list of pigmy accounts / customers needing a new agent.
// type: "pigmy" | "customers" | "all"
// ─────────────────────────────────────────────────────────────────────────────
const getReassignmentQueue = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  type = "all",
} = {}) => {
  const VALID_TYPES = ["pigmy", "customers", "all"];
  if (!VALID_TYPES.includes(type)) {
    throw ApiError.badRequest(
      `Invalid type '${type}'. Must be one of: ${VALID_TYPES.join(", ")}.`,
    );
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  // ── Pigmy accounts needing reassignment ───────────────────────────────────
  if (type === "pigmy") {
    const filter = {
      requiresReassignment: true,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    };
    const [accounts, total] = await Promise.all([
      PigmyAccount.find(filter)
        .select(
          "accountNumber customer reassignmentReason dailyDepositAmountInPaise " +
          "balanceInPaise lastCollectionDate createdAt",
        )
        .populate("customer", "name phone customerCode")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PigmyAccount.countDocuments(filter),
    ]);
    return {
      type: "pigmy",
      items: accounts,
      pagination: _buildPagination(total, page, safeLimit),
    };
  }

  // ── Customers needing reassignment ────────────────────────────────────────
  if (type === "customers") {
    const filter = {
      requiresReassignment: true,
      isDeleted: false,
    };
    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select(
          "customerCode name phone city pincode reassignmentReason " +
          "kycStatus createdAt",
        )
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Customer.countDocuments(filter),
    ]);
    return {
      type: "customers",
      items: customers,
      pagination: _buildPagination(total, page, safeLimit),
    };
  }

  // ── All — both collections, split counts, shared limit ───────────────────
  // When type === "all", return both with their own counts.
  // Pagination applies to pigmy first, then customers.
  const [pigmyAccounts, pigmyTotal, customers, customerTotal] =
    await Promise.all([
      PigmyAccount.find({
        requiresReassignment: true,
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      })
        .select(
          "accountNumber customer reassignmentReason " +
          "dailyDepositAmountInPaise balanceInPaise createdAt",
        )
        .populate("customer", "name phone customerCode")
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PigmyAccount.countDocuments({
        requiresReassignment: true,
        status: ACCOUNT_STATUS.ACTIVE,
        isDeleted: false,
      }),
      Customer.find({ requiresReassignment: true, isDeleted: false })
        .select(
          "customerCode name phone city reassignmentReason kycStatus createdAt",
        )
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      Customer.countDocuments({
        requiresReassignment: true,
        isDeleted: false,
      }),
    ]);

  return {
    type: "all",
    pigmy: {
      items: pigmyAccounts,
      pagination: _buildPagination(pigmyTotal, page, safeLimit),
    },
    customers: {
      items: customers,
      pagination: _buildPagination(customerTotal, page, safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. REASSIGN AGENTS
// Bulk reassign a list of pigmy accounts OR customers to a new active agent.
// entityType: "pigmy" | "customers"
// entityIds:  array of ObjectId strings (max 50 per call)
// ─────────────────────────────────────────────────────────────────────────────
const reassignAgents = async ({
  entityType,
  entityIds,
  newAgentId,
  performedBy,
  ipAddress,
  requestId,
}) => {
  const VALID_TYPES = ["pigmy", "customers"];
  if (!VALID_TYPES.includes(entityType)) {
    throw ApiError.badRequest(
      `Invalid entityType '${entityType}'. Must be 'pigmy' or 'customers'.`,
    );
  }

  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    throw ApiError.badRequest("entityIds must be a non-empty array.");
  }

  if (entityIds.length > 50) {
    throw ApiError.badRequest(
      `Maximum 50 entities can be reassigned per request. Received: ${entityIds.length}.`,
    );
  }

  // ── Validate new agent — must be ACTIVE + KYC_VERIFIED ───────────────────
  const [newAgentUser, newAgentProfile] = await Promise.all([
    User.findOne({ _id: newAgentId, role: ROLES.AGENT, isDeleted: false }),
    AgentProfile.findOne({ user: newAgentId }),
  ]);

  if (!newAgentUser) {
    throw ApiError.notFound("New agent not found.");
  }
  if (!newAgentUser.isActive) {
    throw ApiError.badRequest(
      `Agent ${newAgentUser.agentCode} is not active. Only active agents can be assigned accounts.`,
    );
  }
  if (!newAgentProfile) {
    throw ApiError.notFound("New agent profile not found.");
  }
  if (newAgentProfile.status === AGENT_STATUS.SUSPENDED) {
    throw ApiError.badRequest(
      `Agent ${newAgentUser.agentCode} is suspended. Cannot assign accounts to a suspended agent.`,
    );
  }
  if (newAgentProfile.status === AGENT_STATUS.TERMINATED) {
    throw ApiError.badRequest(
      `Agent ${newAgentUser.agentCode} is terminated. Cannot assign accounts to a terminated agent.`,
    );
  }
  if (newAgentProfile.kycStatus !== AGENT_KYC_STATUS.KYC_VERIFIED) {
    throw ApiError.badRequest(
      `Agent ${newAgentUser.agentCode} KYC is not verified (current: ${newAgentProfile.kycStatus}). ` +
      `Only KYC-verified agents can be assigned accounts.`,
    );
  }

  let modifiedCount = 0;

  await withTransaction(async (session) => {
    if (entityType === "pigmy") {
      const result = await PigmyAccount.updateMany(
        {
          _id: { $in: entityIds },
          requiresReassignment: true,
          isDeleted: false,
        },
        {
          $set: {
            assignedAgent: newAgentId,
            requiresReassignment: false,
            reassignmentReason: null,
          },
        },
        { session },
      );
      modifiedCount = result.modifiedCount;
    } else {
      const result = await Customer.updateMany(
        {
          _id: { $in: entityIds },
          requiresReassignment: true,
          isDeleted: false,
        },
        {
          $set: {
            assignedAgent: newAgentId,
            requiresReassignment: false,
            reassignmentReason: null,
          },
        },
        { session },
      );
      modifiedCount = result.modifiedCount;
    }
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_REASSIGNED,
    entity: entityType === "pigmy" ? "PigmyAccount" : "Customer",
    entityId: newAgentId,
    newData: {
      newAgentId,
      newAgentCode: newAgentUser.agentCode,
      entityType,
      entityIds,
      modifiedCount,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Reassignment] AuditLog failed: ${e.message}`));

  logger.info(
    `[Reassignment] ${modifiedCount} ${entityType} reassigned to ` +
    `${newAgentUser.agentCode} | By: ${performedBy}`,
  );

  return {
    entityType,
    newAgentCode: newAgentUser.agentCode,
    requestedCount: entityIds.length,
    modifiedCount,
    message: `${modifiedCount} ${entityType} successfully reassigned to agent ${newAgentUser.agentCode}.`,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET REASSIGNMENT STATS
// Returns pending counts for ops dashboard KPI.
// ─────────────────────────────────────────────────────────────────────────────
const getReassignmentStats = async () => {
  const [pendingPigmyAccounts, pendingCustomers] = await Promise.all([
    PigmyAccount.countDocuments({
      requiresReassignment: true,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    }),
    Customer.countDocuments({
      requiresReassignment: true,
      isDeleted: false,
    }),
  ]);

  return {
    pendingPigmyAccounts,
    pendingCustomers,
    total: pendingPigmyAccounts + pendingCustomers,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET AGENT PORTFOLIO
// Fetch all active assigned customers and pigmy accounts for an agent.
// ─────────────────────────────────────────────────────────────────────────────
const getAgentPortfolio = async (
  agentId,
  cPage = PAGINATION.DEFAULT_PAGE,
  pPage = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
) => {
  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);

  const customerQuery = {
    assignedAgent: agentId,
    isDeleted: false,
    // Note: intentionally NOT filtering by isActive here.
    // KYC-rejected customers also get isActive=false but must still
    // appear in the portfolio so they can be handed over to another agent.
  };
  const pigmyQuery = {
    assignedAgent: agentId,
    status: ACCOUNT_STATUS.ACTIVE,
    isDeleted: false,
  };

  const [customers, totalCustomers, pigmyAccounts, totalPigmys] =
    await Promise.all([
      Customer.find(customerQuery)
        .select("customerCode name phone city kycStatus createdAt")
        .skip((Number(cPage) - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      Customer.countDocuments(customerQuery),
      PigmyAccount.find(pigmyQuery)
        .select(
          "accountNumber customer balanceInPaise dailyDepositAmountInPaise createdAt",
        )
        .populate("customer", "name phone customerCode")
        .skip((Number(pPage) - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      PigmyAccount.countDocuments(pigmyQuery),
    ]);

  return {
    customers,
    pigmyAccounts,
    cPagination: _buildPagination(totalCustomers, cPage, safeLimit),
    pPagination: _buildPagination(totalPigmys, pPage, safeLimit),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. HANDOVER PORTFOLIO
// Manual transfer of selected or all portfolio parts to another agent.
// ─────────────────────────────────────────────────────────────────────────────
const handoverPortfolio = async ({
  sourceAgentId,
  targetAgentId,
  transferAll,
  customerIds = [],
  pigmyIds = [],
  performedBy,
  ipAddress,
  requestId,
}) => {
  if (sourceAgentId.toString() === targetAgentId.toString()) {
    throw ApiError.badRequest("Source and target agents cannot be the same.");
  }

  // ── Validate Target Agent ───────────────────────────────────────────────
  const [targetAgentUser, targetAgentProfile] = await Promise.all([
    User.findOne({ _id: targetAgentId, role: ROLES.AGENT, isDeleted: false }),
    AgentProfile.findOne({ user: targetAgentId }),
  ]);

  if (!targetAgentUser || !targetAgentUser.isActive) {
    throw ApiError.badRequest("Target agent must exist and be active.");
  }
  if (!targetAgentProfile || targetAgentProfile.status !== AGENT_STATUS.ACTIVE) {
    throw ApiError.badRequest("Target agent profile must be active.");
  }
  if (targetAgentProfile.kycStatus !== AGENT_KYC_STATUS.KYC_VERIFIED) {
    throw ApiError.badRequest("Target agent must be KYC verified.");
  }

  // ── Prepare queries ──────────────────────────────────────────────────────
  let customerQuery = { assignedAgent: sourceAgentId, isDeleted: false };
  let pigmyQuery = { assignedAgent: sourceAgentId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false };

  if (!transferAll) {
    if (customerIds.length === 0 && pigmyIds.length === 0) {
      throw ApiError.badRequest("Must select entities to transfer or set transferAll to true.");
    }
    // P2-HIGH-2: Only add $in filter for non-empty arrays.
    // Previous code deleted assignedAgent from the query when the array was empty,
    // which broadened it to match ALL records — not just the source agent's.
    if (customerIds.length > 0) customerQuery._id = { $in: customerIds };
    if (pigmyIds.length > 0) pigmyQuery._id = { $in: pigmyIds };
  }

  let customersUpdated = 0;
  let pigmyUpdated = 0;

  await withTransaction(async (session) => {
    if (transferAll || customerIds.length > 0) {
      const cRes = await Customer.updateMany(
        customerQuery,
        {
          $set: {
            assignedAgent: targetAgentId,
            requiresReassignment: false,
            reassignmentReason: null,
          },
        },
        { session }
      );
      customersUpdated = cRes.modifiedCount;
    }

    if (transferAll || pigmyIds.length > 0) {
      const pRes = await PigmyAccount.updateMany(
        pigmyQuery,
        {
          $set: {
            assignedAgent: targetAgentId,
            requiresReassignment: false,
            reassignmentReason: null,
          },
        },
        { session }
      );
      pigmyUpdated = pRes.modifiedCount;
    }

    // Safety cascade: If we transferred ALL customers, OR specific customers, we should ensure
    // all their related ACTIVE pigmy accounts are also moved to avoid divergence.
    if (customersUpdated > 0) {
      // All customers that are now targeted to the new agent...
      // we should ensure their pigmy accounts follow them if not already targeted.
      let cascadeQuery = { status: ACCOUNT_STATUS.ACTIVE, isDeleted: false };
      if (transferAll) {
        cascadeQuery.assignedAgent = sourceAgentId;
      } else {
        cascadeQuery.customer = { $in: customerIds };
      }

      const cascadeRes = await PigmyAccount.updateMany(
        cascadeQuery,
        {
          $set: {
            assignedAgent: targetAgentId,
            requiresReassignment: false,
            reassignmentReason: null,
          },
        },
        { session }
      );
      // we only count the explicitly selected pigmys in the API response or total moved.
    }
  });

  const message = `Successfully handed over ${customersUpdated} customers and ${pigmyUpdated} pigmy accounts to agent ${targetAgentUser.agentCode}.`;

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.AGENT_PORTFOLIO_TRANSFERRED,
    entity: "AgentProfile",
    entityId: sourceAgentId, // the agent losing the accounts
    newData: {
      targetAgentId,
      targetAgentCode: targetAgentUser.agentCode,
      customersTransferred: customersUpdated,
      pigmyTransferred: pigmyUpdated,
      transferAll,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Reassignment] AuditLog portfolio handover failed: ${e.message}`));

  logger.info(`[Reassignment] Portfolio Handover | Source: ${sourceAgentId} | Target: ${targetAgentUser.agentCode} | By: ${performedBy}`);

  return {
    sourceAgentId,
    targetAgentCode: targetAgentUser.agentCode,
    customersUpdated,
    pigmyUpdated,
    message,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPER
// ─────────────────────────────────────────────────────────────────────────────
const _buildPagination = (total, page, limit) => ({
  total,
  page: Number(page),
  limit,
  totalPages: Math.ceil(total / limit),
});

module.exports = {
  getReassignmentQueue,
  reassignAgents,
  getReassignmentStats,
  getAgentPortfolio,
  handoverPortfolio,
};
