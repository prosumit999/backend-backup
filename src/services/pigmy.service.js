// src/services/pigmy.service.js
// PigmyAccount lifecycle ONLY.
// Daily collection logic → collection.service.js
// Loan repayment → loan.service.js → applyPigmyToLoan()
"use strict";

const PigmyAccount = require("../models/PigmyAccount.model");
const SavingAccount = require("../models/SavingAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const Customer = require("../models/Customer.model");
const AgentProfile = require("../models/AgentProfile.model");
const Transaction = require("../models/Transaction.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const smsService = require("../utils/sms.service");
const escapeRegex = require("../utils/escapeRegex");
const {
  ACCOUNT_STATUS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  COLLECTION_FREQUENCY,
  PAGINATION,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  ROLES,
  KYC_STATUS,
  LOAN_STATUS,
  AGENT_STATUS,
  AGENT_KYC_STATUS,
} = require("../config/constants");
const {
  generatePigmyAccountNumber: generateAccountNumber,
  generateTransactionId,
} = require("../utils/generateCode");
const { startOfDay, endOfDay, toObjId, toIndianDate } = require("../utils/dateHelpers");

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Fetch open business date from AppConfig
// ─────────────────────────────────────────────────────────────────────────────
const getBusinessDate = async () => {
  // P-2 FIX: Two sequential awaits → one parallel Promise.all
  // isDayOpen() and getCurrentBusinessDate() each cost a MongoDB round-trip.
  // Running them in parallel halves the latency on every write path.
  const [isDayOpen, date] = await Promise.all([
    AppConfig.isDayOpen(),
    AppConfig.getCurrentBusinessDate(),
  ]);
  if (!isDayOpen) {
    throw ApiError.serviceUnavailable(
      "Business day is not open. Admin must open the day before creating accounts or recording transactions.",
    );
  }
  if (!date) {
    throw ApiError.serviceUnavailable(
      "Current business date is not configured. Contact superadmin.",
    );
  }
  return startOfDay(new Date(date));
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Assert KYC verified
// ─────────────────────────────────────────────────────────────────────────────
const assertKycVerified = async (customerId) => {
  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.notFound("Customer not found.");

  if (customer.kycStatus !== KYC_STATUS.KYC_VERIFIED) {
    const statusMessages = {
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
      `Customer ${customer.customerCode} KYC is not verified. ` +
      (statusMessages[customer.kycStatus] ??
        `Current status: ${customer.kycStatus}.`),
    );
  }
  return customer;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE PIGMY ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const createPigmyAccount = async ({
  customerId,
  dailyDepositAmountInPaise,
  collectionFrequency = COLLECTION_FREQUENCY.DAILY,
  assignedAgent,
  openedBy,
  ipAddress,
  requestId,
}) => {
  // ── OBS-5 FIX: Enforce daily-only until weekly logic is implemented ──────────
  // collection.service.js only sends collections to daily pigmy accounts.
  // Allowing weekly accounts would silently create accounts that are NEVER
  // collected from — agent apps would skip them, balances would never grow.
  //
  // TODO: When weekly collection scheduling is implemented in collection.service.js,
  //       remove this guard and update the schedule enforcement logic.
  // ─────────────────────────────────────────────────────────────────────────────
  if (collectionFrequency !== COLLECTION_FREQUENCY.DAILY) {
    throw ApiError.badRequest(
      `collectionFrequency "${collectionFrequency}" is not yet supported. ` +
      `Only "${COLLECTION_FREQUENCY.DAILY}" pigmy accounts are currently accepted. ` +
      `Weekly collection scheduling is planned for a future release.`,
    );
  }

  const customer = await assertKycVerified(customerId);

  // Soft pre-check — fast-fail before session opens
  const existing = await PigmyAccount.findActiveByCustomer(customerId);
  if (existing) {
    throw ApiError.conflict(
      `Customer ${customer.customerCode} already has an active pigmy account: ${existing.accountNumber}.`,
    );
  }

  // Active saving account must exist first
  const savingAccount = await SavingAccount.findActiveByCustomer(customerId);
  if (!savingAccount) {
    throw ApiError.badRequest(
      `Customer ${customer.customerCode} does not have an active saving account. ` +
      `Open a saving account first before opening a pigmy account.`,
    );
  }

  if (
    !dailyDepositAmountInPaise ||
    typeof dailyDepositAmountInPaise !== "number"
  ) {
    throw ApiError.badRequest(
      "Daily deposit amount is required and must be a number.",
    );
  }
  if (dailyDepositAmountInPaise < 100) {
    throw ApiError.badRequest(
      "Minimum daily deposit amount is ₹1 (100 paise).",
    );
  }

  const effectiveDate = await getBusinessDate();
  const effectiveAgent = assignedAgent || customer.assignedAgent || null;
  if (!effectiveAgent) {
    throw ApiError.badRequest(
      "No agent assigned. Either pass assignedAgent in request body or assign an agent to the customer first.",
    );
  }

  const agentProfileDoc = await AgentProfile.findOne({ user: effectiveAgent });
  if (!agentProfileDoc) {
    throw ApiError.notFound("Assigned agent's profile not found.");
  }
  if (agentProfileDoc.status !== AGENT_STATUS.ACTIVE) {
    throw ApiError.forbidden(
      `Assigned agent is not active. Current status: ${agentProfileDoc.status}. Cannot assign to Pigmy account.`
    );
  }
  if (agentProfileDoc.kycStatus !== AGENT_KYC_STATUS.KYC_VERIFIED) {
    throw ApiError.forbidden(
      `Assigned agent has incomplete KYC. Current status: ${agentProfileDoc.kycStatus}. Cannot assign to Pigmy account.`
    );
  }

  const accountNumber = await generateAccountNumber();
  let account;

  await withTransaction(async (session) => {
    // Session-locked duplicate guard — definitive check inside transaction
    const existingInSession = await PigmyAccount.findOne({
      customer: customerId,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    }).session(session);

    if (existingInSession) {
      throw ApiError.conflict(
        `Customer ${customer.customerCode} already has an active pigmy account: ` +
        `${existingInSession.accountNumber}. Concurrent request may have just created it.`,
      );
    }

    [account] = await PigmyAccount.create(
      [
        {
          accountNumber,
          customer: customerId,
          savingAccount: savingAccount._id,
          assignedAgent: effectiveAgent,
          dailyDepositAmountInPaise,
          collectionFrequency,
          balanceInPaise: 0,
          totalCollectedInPaise: 0,
          totalCollectionDays: 0,
          lastCollectionDate: null,
          activeLoan: null,
          status: ACCOUNT_STATUS.ACTIVE,
          openedBy,
          openedAt: effectiveDate,
          businessDate: effectiveDate,
          isDeleted: false,
        },
      ],
      { session },
    );
    // No ledger entry — pigmy account starts at ₹0.
    // First ledger entry happens at first collection (collection.service.js).
  });

  await smsService
    .sendPigmyAccountOpened(
      customer.phone,
      customer.name,
      accountNumber,
      (dailyDepositAmountInPaise / 100).toFixed(0),
      collectionFrequency,                          // P-1 FIX: was missing — caused "Frequency: undefined" in SMS
    )
    .catch((e) => logger.warn(`[Pigmy] SMS failed: ${e.message}`));

  await AuditLog.log({
    performedBy: openedBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_CREATED,
    entity: "PigmyAccount",
    entityId: account._id,
    newData: {
      accountNumber,
      customerId,
      savingAccountId: savingAccount._id,
      dailyDepositAmountInPaise,
      collectionFrequency,
      openedAt: effectiveDate,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Pigmy] AuditLog failed: ${e.message}`));

  logger.info(
    `[Pigmy] Created | ${accountNumber} | Customer: ${customer.customerCode} | ` +
    `Daily: ₹${(dailyDepositAmountInPaise / 100).toFixed(0)} | ` +
    `Freq: ${collectionFrequency} | By: ${openedBy}`,
  );

  return account.populate([
    { path: "customer", select: "name phone customerCode" },
    { path: "savingAccount", select: "accountNumber balanceInPaise status" },
    { path: "assignedAgent", select: "name phone agentCode" },
    { path: "openedBy", select: "name role" },
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET SINGLE PIGMY ACCOUNT (with live collection stats)
// ─────────────────────────────────────────────────────────────────────────────
const getPigmyAccount = async (accountId) => {
  const account = await PigmyAccount.findById(accountId)
    .populate("customer", "name phone customerCode kycStatus")
    .populate("savingAccount", "accountNumber balanceInPaise status")
    .populate("assignedAgent", "name phone agentCode")
    .populate("openedBy", "name role")
    .populate("closedBy", "name role")
    .populate("frozenBy", "name role")
    .populate(
      "activeLoan",
      "loanAccountNumber outstandingBalanceInPaise status maturityDate",
    );

  if (!account) throw ApiError.notFound("Pigmy account not found.");

  const stats = await Transaction.aggregate([
    {
      $match: {
        $or: [
          { toPigmyAccount: account._id },
          { fromPigmyAccount: account._id },
        ],
        status: "completed",
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalCollected: {
          $sum: {
            $cond: [
              { $eq: ["$type", TRANSACTION_TYPES.PIGMY_COLLECTION] },
              "$amountInPaise",
              0,
            ],
          },
        },
        totalAppliedToLoan: {
          $sum: {
            $cond: [
              { $eq: ["$type", TRANSACTION_TYPES.LOAN_REPAYMENT] },
              "$amountInPaise",
              0,
            ],
          },
        },
        totalCollections: {
          $sum: {
            $cond: [
              { $eq: ["$type", TRANSACTION_TYPES.PIGMY_COLLECTION] },
              1,
              0,
            ],
          },
        },
        lastCollectionAt: { $max: "$createdAt" },
      },
    },
  ]);

  const result = account.toObject();
  result.stats = {
    totalCollectedInPaise: stats[0]?.totalCollected || 0,
    totalCollectedInRupees: ((stats[0]?.totalCollected || 0) / 100).toFixed(2),
    totalAppliedToLoanInPaise: stats[0]?.totalAppliedToLoan || 0,
    totalAppliedInRupees: ((stats[0]?.totalAppliedToLoan || 0) / 100).toFixed(
      2,
    ),
    pendingBalanceInRupees: (account.balanceInPaise / 100).toFixed(2),
    totalCollections: stats[0]?.totalCollections || 0,
    lastCollectionAt: stats[0]?.lastCollectionAt || null,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. LIST PIGMY ACCOUNTS (paginated, agent-filtered)
// ─────────────────────────────────────────────────────────────────────────────
const listPigmyAccounts = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  status,
  search,
  assignedAgent,
  isDeleted = false,
  requestingUserRole,
  requestingUserId,
}) => {
  const filter = { isDeleted: isDeleted === 'true' || isDeleted === true };

  if (requestingUserRole === ROLES.AGENT) {
    filter.assignedAgent = requestingUserId;
  } else if (assignedAgent) {
    filter.assignedAgent = assignedAgent;
  }

  if (status) filter.status = status;

  if (search) {
    const cleanSearch = escapeRegex(search.trim());
    logger.debug(`[listPigmyAccounts] search term: ${cleanSearch}`);

    // First find any matching customers
    const matchingCustomers = await Customer.find({
      $or: [
        { name: { $regex: cleanSearch, $options: "i" } },
        { customerCode: { $regex: cleanSearch, $options: "i" } },
        { phone: { $regex: cleanSearch, $options: "i" } },
      ],
      isDeleted: false
    }).select("_id");

    const customerIds = matchingCustomers.map((c) => c._id);

    filter.$or = [
      { accountNumber: { $regex: cleanSearch, $options: "i" } }
    ];

    if (customerIds.length > 0) {
      logger.debug(`[listPigmyAccounts] found ${customerIds.length} customerIds`);
      filter.$or.push({ customer: { $in: customerIds } });
    } else {
      logger.debug(`[listPigmyAccounts] no matching customers found`);
    }
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [accounts, total] = await Promise.all([
    PigmyAccount.find(filter, null, { _skipDeletedFilter: filter.isDeleted })
      .select(
        "accountNumber customer assignedAgent savingAccount activeLoan " +
        "balanceInPaise dailyDepositAmountInPaise collectionFrequency " +
        "totalCollectedInPaise totalCollectionDays lastCollectionDate status openedAt closedAt",
      )
      .populate("customer", "name phone customerCode")
      .populate("assignedAgent", "name agentCode")
      .populate(
        "activeLoan",
        "loanAccountNumber outstandingBalanceInPaise status",
      )
      .skip(skip)
      .limit(safeLimit)
      .sort({ createdAt: -1 }),
    PigmyAccount.countDocuments(filter),
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

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET PIGMY ACCOUNTS BY CUSTOMER
// ─────────────────────────────────────────────────────────────────────────────
const getPigmyAccountsByCustomer = async (customerId) => {
  const safeId = toObjId(customerId, "customerId");

  return PigmyAccount.find({ customer: safeId, isDeleted: false })
    .select(
      "accountNumber balanceInPaise dailyDepositAmountInPaise " +
      "collectionFrequency totalCollectedInPaise totalCollectionDays " +
      "status activeLoan openedAt closedAt closureReason",
    )
    .populate("assignedAgent", "name agentCode")
    .populate(
      "activeLoan",
      "loanAccountNumber outstandingBalanceInPaise status",
    )
    .sort({ createdAt: -1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET PIGMY ACCOUNT STATEMENT (collection + repayment history)
// ─────────────────────────────────────────────────────────────────────────────
const getStatement = async ({
  accountId,
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  fromDate,
  toDate,
}) => {
  const account = await PigmyAccount.findById(accountId).lean();
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  const txFilter = {
    $or: [{ toPigmyAccount: account._id }, { fromPigmyAccount: account._id }],
    isDeleted: false,
  };

  if (fromDate || toDate) {
    txFilter.businessDate = {};
    if (fromDate) txFilter.businessDate.$gte = startOfDay(new Date(fromDate));
    if (toDate) txFilter.businessDate.$lte = endOfDay(new Date(toDate));
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [transactions, total] = await Promise.all([
    Transaction.find(txFilter)
      .select(
        "transactionId type amountInPaise netAmountInPaise feeInPaise " +
        "balanceAfterInPaise secondaryBalanceAfterInPaise toPigmyAccount fromPigmyAccount note status businessDate createdAt performedBy reversalOf",
      )
      .populate("performedBy", "name role")
      .lean()
      .skip(skip)
      .limit(safeLimit)
      .sort({ createdAt: -1 }),
    Transaction.countDocuments(txFilter),
  ]);

  const mappedTransactions = transactions.map((tx) => {
    // If this pigmy account is the receiver of an internal transfer (saving -> pigmy),
    // the main balanceAfterInPaise holds the saving balance. We must swap it with secondary.
    if (
      tx.type === TRANSACTION_TYPES.SAVING_TO_PIGMY_TRANSFER &&
      tx.toPigmyAccount?.toString() === account._id.toString()
    ) {
      if (tx.secondaryBalanceAfterInPaise !== undefined && tx.secondaryBalanceAfterInPaise !== null) {
        tx.balanceAfterInPaise = tx.secondaryBalanceAfterInPaise;
      } else {
        tx.balanceAfterInPaise = null; // Hide the irrelevant saving balance if null/old tx
      }
    }
    // Mirror case: pigmy → saving transfer — pigmy is the sender.
    // The main balanceAfterInPaise holds the saving (receiver) balance.
    // We must swap it with secondaryBalanceAfterInPaise (pigmy sender balance).
    if (
      tx.type === TRANSACTION_TYPES.PIGMY_TO_SAVING_TRANSFER &&
      tx.fromPigmyAccount?.toString() === account._id.toString()
    ) {
      if (tx.secondaryBalanceAfterInPaise !== undefined && tx.secondaryBalanceAfterInPaise !== null) {
        tx.balanceAfterInPaise = tx.secondaryBalanceAfterInPaise;
      } else {
        tx.balanceAfterInPaise = null;
      }
    }
    return tx;
  });

  return {
    accountNumber: account.accountNumber,
    balanceInRupees: (account.balanceInPaise / 100).toFixed(2),
    transactions: mappedTransactions,
    pagination: {
      total,
      page: Number(page),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLOSE PIGMY ACCOUNT
// Gate 1: Not already CLOSED
// Gate 2: Not FROZEN — unfreeze first
// Gate 3: No active / overdue loan on customer
// On close: remaining pigmy balance returned as cash
// DR Pigmy Deposits (−liability) | CR Cash in Hand (−asset)
// ─────────────────────────────────────────────────────────────────────────────
const closePigmyAccount = async ({
  accountId,
  closureReason,
  closedBy,
  ipAddress,
  requestId,
}) => {
  const account = await PigmyAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  if (account.status === ACCOUNT_STATUS.CLOSED) {
    throw ApiError.badRequest(
      `Pigmy account ${account.accountNumber} is already closed.`,
    );
  }
  if (account.status === ACCOUNT_STATUS.FROZEN) {
    throw ApiError.badRequest(
      `Pigmy account ${account.accountNumber} is frozen. Unfreeze it before closing.`,
    );
  }


  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);
  let returnBalancePaise;

  await withTransaction(async (session) => {
    const blockingLoan = await LoanAccount.findOne({
      customer: account.customer._id,
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
    }).session(session).lean();

    if (blockingLoan) {
      throw ApiError.badRequest(
        `Cannot close pigmy account — customer has an active/overdue loan: ` +
        `${blockingLoan.loanAccountNumber}. Daily pigmy collections repay the loan. Close the loan first.`,
      );
    }

    const closedAccount = await PigmyAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false },
      {
        $set: {
          status: ACCOUNT_STATUS.CLOSED,
          closedAt: effectiveDate,
          closedBy,
          closureReason,
          balanceInPaise: 0,
          activeLoan: null,
          frozenAt: null,
          frozenBy: null,
          freezeReason: null,
        },
      },
      { returnDocument: "before", session },
    );

    if (!closedAccount) {
      throw new ApiError(
        409,
        `Account ${account.accountNumber} status changed concurrently ` +
        `(may have been frozen or closed by another request). Refresh and retry.`,
      );
    }

    returnBalancePaise = closedAccount.balanceInPaise;

    if (returnBalancePaise > 0) {
      const [txn] = await Transaction.create(
        [
          {
            transactionId: transactionRef,
            requestId,
            type: TRANSACTION_TYPES.PIGMY_WITHDRAWAL,
            fromPigmyAccount: accountId,
            customer: account.customer._id,
            performedBy: closedBy,
            amountInPaise: returnBalancePaise,
            feeInPaise: 0,
            netAmountInPaise: returnBalancePaise,
            balanceAfterInPaise: 0,
            reference: account.accountNumber,
            note: `Pigmy balance returned on account closure — ${account.accountNumber}`,
            status: TRANSACTION_STATUS.COMPLETED,
            businessDate: effectiveDate,
          },
        ],
        { session },
      );

      await ledger.recordPigmyWithdrawal({
        transactionId: txn._id,
        transactionRef,
        amountInPaise: returnBalancePaise,
        customer: account.customer._id,
        performedBy: closedBy,
        businessDate: effectiveDate,
        session,
      });
    }
  });

  await smsService
    .sendPigmyAccountClosed(
      account.customer.phone,
      account.customer.name,
      account.accountNumber,
      (returnBalancePaise / 100).toFixed(0),
    )
    .catch((e) => logger.warn(`[Pigmy] SMS failed: ${e.message}`));

  await AuditLog.log({
    performedBy: closedBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_CLOSED,
    entity: "PigmyAccount",
    entityId: accountId,
    oldData: {
      status: account.status,
      balanceInPaise: returnBalancePaise,
    },
    newData: {
      status: ACCOUNT_STATUS.CLOSED,
      closureReason,
      returnedBalancePaise: returnBalancePaise,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Pigmy] AuditLog failed: ${e.message}`));

  logger.info(
    `[Pigmy] 🔒 Closed | ${account.accountNumber} | ` +
    `Returned: ₹${(returnBalancePaise / 100).toFixed(2)} | By: ${closedBy}`,
  );

  return {
    message: "Pigmy account closed successfully.",
    accountNumber: account.accountNumber,
    returnedBalanceInRupees: (returnBalancePaise / 100).toFixed(2),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. FREEZE PIGMY ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const freezePigmyAccount = async ({
  accountId,
  freezeReason,
  frozenBy,
  ipAddress,
  requestId,
}) => {
  const account = await PigmyAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.badRequest(
      `Only active accounts can be frozen. Account ${account.accountNumber} status: ${account.status}.`,
    );
  }

  const effectiveDate = await getBusinessDate();

  await withTransaction(async (session) => {
    const frozenAccount = await PigmyAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE },
      {
        $set: {
          status: ACCOUNT_STATUS.FROZEN,
          frozenAt: effectiveDate,
          frozenBy,
          freezeReason,
        },
      },
      { returnDocument: "after", session },
    );

    if (!frozenAccount) {
      throw new ApiError(
        409,
        `Account ${account.accountNumber} is no longer active ` +
        `(may have been frozen or closed by a concurrent request). Refresh and retry.`,
      );
    }
  });

  await AuditLog.log({
    performedBy: frozenBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_FROZEN,
    entity: "PigmyAccount",
    entityId: accountId,
    oldData: { status: account.status },
    newData: {
      status: ACCOUNT_STATUS.FROZEN,
      freezeReason,
      frozenAt: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Pigmy] AuditLog failed: ${e.message}`));

  logger.info(
    `[Pigmy]  Frozen | ${account.accountNumber} | Reason: ${freezeReason} | By: ${frozenBy}`,
  );
  return {
    message: "Pigmy account frozen successfully.",
    accountNumber: account.accountNumber,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. UNFREEZE PIGMY ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const unfreezePigmyAccount = async ({
  accountId,
  unfreezeReason,
  unfrozenBy,
  ipAddress,
  requestId,
}) => {
  const account = await PigmyAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  if (account.status !== ACCOUNT_STATUS.FROZEN) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is not frozen. Current status: ${account.status}.`,
    );
  }

  const effectiveDate = await getBusinessDate();

  await withTransaction(async (session) => {
    const unfrozenAccount = await PigmyAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.FROZEN },
      {
        $set: {
          status: ACCOUNT_STATUS.ACTIVE,
          // P-3 FIX: Use $set: null instead of $unset to preserve schema field definitions.
          // $unset removes the key entirely from the MongoDB document.
          // Sparse indexes and schema virtuals that reference these fields can behave
          // unexpectedly when the key is absent vs present-but-null.
          frozenAt: null,
          frozenBy: null,
          freezeReason: null,
        },
      },
      { returnDocument: "after", session },
    );

    if (!unfrozenAccount) {
      throw new ApiError(
        409,
        `Account ${account.accountNumber} is no longer frozen ` +
        `(may have been unfrozen or closed by a concurrent request). Refresh and retry.`,
      );
    }
  });

  await AuditLog.log({
    performedBy: unfrozenBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_UNFROZEN,
    entity: "PigmyAccount",
    entityId: accountId,
    oldData: {
      status: ACCOUNT_STATUS.FROZEN,
      freezeReason: account.freezeReason,
    },
    newData: {
      status: ACCOUNT_STATUS.ACTIVE,
      unfreezeReason: unfreezeReason || null,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Pigmy] AuditLog failed: ${e.message}`));

  logger.info(
    `[Pigmy] → Unfrozen | ${account.accountNumber} | By: ${unfrozenBy}`,
  );
  return {
    message: "Pigmy account unfrozen successfully.",
    accountNumber: account.accountNumber,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL ASSERTION — used by collection.service.js
// ─────────────────────────────────────────────────────────────────────────────
const assertPigmyAccountActive = (account) => {
  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.forbidden(
      `Pigmy account ${account.accountNumber} is ${account.status}. No collections allowed.`,
    );
  }
  return account;
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. TRANSFER PIGMY → SAVING
// ─────────────────────────────────────────────────────────────────────────────
const transferPigmyToSaving = async ({ accountId, savingAccountId, amountInPaise, note, performedBy, ipAddress, requestId }) => {
  const account = await PigmyAccount.assertOperable(accountId);
  const savingAccount = await SavingAccount.findById(savingAccountId);
  
  if (!savingAccount) throw ApiError.notFound("Saving account not found");
  if (savingAccount.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.badRequest(`Saving account is ${savingAccount.status}. Disallowed.`);
  }

  if (account.balanceInPaise < amountInPaise) {
    throw ApiError.badRequest("Insufficient pigmy balance for transfer.");
  }

  if (requestId) {
    const duplicate = await Transaction.findOne({
      requestId,
      type: TRANSACTION_TYPES.PIGMY_TO_SAVING_TRANSFER,
      isDeleted: false,
    }).lean();
    if (duplicate) {
      throw new ApiError(409, `Duplicate request [${requestId}]. Transfer may already have been recorded.`);
    }
  }

  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let newPigmyBalance, newSavingBalance;

  await withTransaction(async (session) => {
    const updatedPigmy = await PigmyAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, balanceInPaise: { $gte: amountInPaise }, isDeleted: false },
      { $inc: { balanceInPaise: -amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedPigmy) {
      throw ApiError.badRequest("Transfer failed: Insufficient pigmy balance.");
    }
    newPigmyBalance = updatedPigmy.balanceInPaise;

    const updatedSaving = await SavingAccount.findOneAndUpdate(
      { _id: savingAccountId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false },
      { $inc: { balanceInPaise: amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedSaving) {
      throw ApiError.badRequest(
        "Transfer failed: Saving account is no longer active (may have been frozen or closed by a concurrent request). Refresh and retry."
      );
    }
    newSavingBalance = updatedSaving.balanceInPaise;

    const [txn] = await Transaction.create(
      [{
        transactionId: transactionRef,
        requestId: requestId || null,
        type: TRANSACTION_TYPES.PIGMY_TO_SAVING_TRANSFER,
        fromPigmyAccount: accountId,
        toSavingAccount: savingAccountId,
        customer: account.customer,
        performedBy,
        amountInPaise,
        feeInPaise: 0,
        netAmountInPaise: amountInPaise,
        balanceAfterInPaise: newPigmyBalance,
        secondaryBalanceAfterInPaise: newSavingBalance,
        reference: savingAccount.accountNumber,
        note: note || "Internal transfer: Pigmy to Saving",
        status: TRANSACTION_STATUS.COMPLETED,
        businessDate: effectiveDate,
        isDeleted: false,
      }],
      { session }
    );

    await ledger.recordPigmyToSavingTransfer({
      transaction: txn._id,
      transactionRef,
      amountInPaise,
      customer: account.customer,
      performedBy,
      businessDate: effectiveDate,
      session,
    });
  });

  // ── SMS: Internal transfer notification (non-critical) ──────────────────
  try {
    const customer = await Customer.findById(account.customer).select("name phone").lean();
    if (customer && customer.phone) {
      await smsService
        .sendInternalTransfer(
          customer.phone,
          customer.name,
          (amountInPaise / 100).toFixed(0),
          "Pigmy " + account.accountNumber,
          "Saving " + savingAccount.accountNumber,
          toIndianDate(effectiveDate),
        )
        .catch((e) => logger.warn(`[Pigmy] Transfer SMS failed: ${e.message}`));
    }
  } catch (smsErr) {
    logger.warn(`[Pigmy] Transfer SMS customer lookup failed: ${smsErr.message}`);
  }

  return { transactionRef, newPigmyBalanceInRupees: (newPigmyBalance / 100).toFixed(2), newSavingBalanceInRupees: (newSavingBalance / 100).toFixed(2) };
};


// ─────────────────────────────────────────────────────────────────────────────
// 11. SOFT DELETE PIGMY ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const deletePigmyAccount = async ({ accountId, deletedBy, ipAddress }) => {
  const account = await PigmyAccount.findById(accountId);
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  if (account.isDeleted) {
    throw ApiError.badRequest("Account is already deleted.");
  }

  // P2-HIGH-1: Use getBusinessDate() — enforces day-open guard and IST normalization.
  // Previous code used getCurrentBusinessDate() || new Date() which silently fell back
  // to wall-clock when day was closed, producing audit-invisible timestamps.
  const deleteDate = await getBusinessDate();

  // P2-MED-1: Wrap in transaction — the balance/loan checks must be atomic with the
  // soft-delete write. Without a session, a concurrent deposit could arrive between
  // the ₹0 balance check and the save, creating an orphaned positive-balance deleted account.
  await withTransaction(async (session) => {
    const freshAccount = await PigmyAccount.findOne({
      _id: accountId,
      isDeleted: false,
    }).session(session);

    if (!freshAccount) {
      throw ApiError.badRequest("Account was already deleted by another request.");
    }

    if (freshAccount.balanceInPaise > 0) {
      throw ApiError.badRequest(
        "Cannot delete account with a positive balance. Close or withdraw first.",
      );
    }

    if (freshAccount.activeLoan) {
      throw ApiError.badRequest(
        `Cannot delete pigmy account ${freshAccount.accountNumber} — it is still linked to an active loan. ` +
        `Detach or close the loan before deleting this account.`,
      );
    }

    await PigmyAccount.findOneAndUpdate(
      { _id: accountId, isDeleted: false },
      {
        $set: {
          isDeleted: true,
          deletedAt: deleteDate,
          deletedBy,
        },
      },
      { session },
    );
  });

  await AuditLog.log({
    performedBy: deletedBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_DELETED,
    entity: "PigmyAccount",
    entityId: accountId,
    newData: { isDeleted: true, deletedAt: deleteDate },
    ipAddress,
    status: "success",
  }).catch((e) => logger.error(`[Pigmy] Delete AuditLog failed: ${e.message}`));

  logger.info(`[Pigmy] DELETED | ${account.accountNumber} | By: ${deletedBy}`);

  return { message: "Pigmy account successfully deleted." };
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. RESTORE PIGMY ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const restorePigmyAccount = async ({ accountId, restoredBy, ipAddress }) => {
  // Query bypassing soft-delete schema hook
  const account = await PigmyAccount.findOne({ _id: accountId, isDeleted: true }, null, { _skipDeletedFilter: true });
  if (!account) throw ApiError.notFound("Deleted Pigmy account not found.");

  account.isDeleted = false;
  account.deletedAt = null;
  account.deletedBy = null;

  // If the restored account has a stale activeLoan reference
  // (loan was CLOSED/WRITTEN_OFF/deleted since the account was soft-deleted),
  // clear it so getLoan() and getPigmyAccount() populates return correct data.
  if (account.activeLoan) {
    const linkedLoan = await LoanAccount.findById(account.activeLoan)
      .select("status isDeleted")
      .lean();
    const isLoanActive = linkedLoan &&
      !linkedLoan.isDeleted &&
      [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(linkedLoan.status);
    if (!isLoanActive) {
      account.activeLoan = null;
      logger.warn(
        `[Pigmy] RESTORE | ${account.accountNumber} | Cleared stale activeLoan ref — loan no longer active.`
      );
    }
  }

  await account.save();

  await AuditLog.log({
    performedBy: restoredBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_RESTORED,
    entity: "PigmyAccount",
    entityId: accountId,
    newData: { isDeleted: false },
    ipAddress,
    status: "success",
  }).catch((e) => logger.error(`[Pigmy] Restore AuditLog failed: ${e.message}`));

  logger.info(`[Pigmy] RESTORED | ${account.accountNumber} | By: ${restoredBy}`);

  return { message: "Pigmy account successfully restored." };
};

// ───────────────────────────────────────────────────────────────────────────────
// 13. UPDATE PIGMY ACCOUNT SETTINGS
// Allows admin/superadmin to update:
//   • dailyDepositAmountInPaise (changes future expected collection amount)
//   • collectionFrequency
// Only allowed on active or frozen accounts (not closed/deleted).
// No financial effect — past collections are unaffected.
// ───────────────────────────────────────────────────────────────────────────────
const updatePigmyAccount = async ({
  accountId,
  dailyDepositAmountInPaise,
  collectionFrequency,
  updatedBy,
  ipAddress,
  requestId,
}) => {
  const account = await PigmyAccount.findById(accountId).populate("customer", "name customerCode");
  if (!account) throw ApiError.notFound("Pigmy account not found.");

  if (account.isDeleted) {
    throw ApiError.badRequest("Cannot update a deleted pigmy account.");
  }
  if (account.status === ACCOUNT_STATUS.CLOSED) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is closed. Cannot update settings on a closed account.`
    );
  }

  const oldData = {
    dailyDepositAmountInPaise: account.dailyDepositAmountInPaise,
    collectionFrequency: account.collectionFrequency,
  };

  const updates = {};
  if (dailyDepositAmountInPaise !== undefined) {
    updates.dailyDepositAmountInPaise = dailyDepositAmountInPaise;
  }
  if (collectionFrequency !== undefined) {
    updates.collectionFrequency = collectionFrequency;
  }

  const updated = await PigmyAccount.findByIdAndUpdate(
    accountId,
    { $set: updates },
    { new: true, runValidators: true }
  ).populate("customer", "name customerCode");

  await AuditLog.log({
    performedBy: updatedBy,
    action: AUDIT_ACTIONS.PIGMY_ACCOUNT_UPDATED,
    entity: "PigmyAccount",
    entityId: accountId,
    oldData,
    newData: updates,
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Pigmy] AuditLog failed: ${e.message}`));

  logger.info(
    `[Pigmy] UPDATED | ${account.accountNumber} | ` +
    `Changes: ${JSON.stringify(updates)} | By: ${updatedBy}`
  );

  return {
    message: "Pigmy account settings updated successfully.",
    account: updated,
  };
};

module.exports = {
  createPigmyAccount,
  getPigmyAccount,
  listPigmyAccounts,
  getPigmyAccountsByCustomer,
  getStatement,
  updatePigmyAccount,
  closePigmyAccount,
  freezePigmyAccount,
  unfreezePigmyAccount,
  assertPigmyAccountActive,
  transferPigmyToSaving,
  deletePigmyAccount,
  restorePigmyAccount,
};
