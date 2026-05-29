// src/services/saving.service.js
// SavingAccount lifecycle ONLY.
// PigmyAccount → pigmy.service.js | Loan → loan.service.js
"use strict";

const SavingAccount = require("../models/SavingAccount.model");
const LoanAccount = require("../models/LoanAccount.model");
const PigmyAccount = require("../models/PigmyAccount.model");
const Customer = require("../models/Customer.model");
const Transaction = require("../models/Transaction.model");
const AuditLog = require("../models/AuditLog.model");
const AppConfig = require("../models/AppConfig.model");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ledger = require("../utils/ledger");
const withTransaction = require("../utils/withTransaction");
const smsService = require("../utils/sms.service");
const {
  ACCOUNT_STATUS,
  CONFIG_KEYS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  PAGINATION,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  ROLES,
  KYC_STATUS,
  LOAN_STATUS,
} = require("../config/constants");
const escapeRegex = require("../utils/escapeRegex");
const {
  generateSavingAccountNumber: generateAccountNumber,
  generateTransactionId,
} = require("../utils/generateCode");
const { startOfDay, endOfDay, toObjId, toIndianDate } = require("../utils/dateHelpers");

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Fetch open business date from AppConfig
// ─────────────────────────────────────────────────────────────────────────────
const getBusinessDate = async () => {
  const isDayOpen = await AppConfig.isDayOpen();
  if (!isDayOpen) {
    throw ApiError.serviceUnavailable(
      "Business day is not open. " +
      "Admin must open the day before creating accounts or recording transactions.",
    );
  }
  const date = await AppConfig.getCurrentBusinessDate();
  if (!date) {
    throw ApiError.serviceUnavailable(
      "Current business date is not configured. Contact superadmin.",
    );
  }
  return startOfDay(new Date(date));
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: assertKycVerified
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
// INTERNAL ASSERTION — used by loan.service.js + depositToSaving
// ─────────────────────────────────────────────────────────────────────────────
const assertSavingAccountActive = (account) => {
  const blockedMessages = {
    [ACCOUNT_STATUS.CLOSED]: `Account ${account.accountNumber} is closed. No transactions allowed.`,
    [ACCOUNT_STATUS.FROZEN]: `Account ${account.accountNumber} is frozen. Contact admin.`,
    [ACCOUNT_STATUS.INACTIVE]: `Account ${account.accountNumber} is inactive.`,
  };
  const msg = blockedMessages[account.status];
  if (msg) throw ApiError.forbidden(msg);
  return account;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE SAVING ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const createSavingAccount = async ({
  customerId,
  openedBy,
  ipAddress,
  requestId,
}) => {
  const customer = await assertKycVerified(customerId);

  const existing = await SavingAccount.findActiveByCustomer(customerId);
  if (existing) {
    throw ApiError.conflict(
      `Customer ${customer.customerCode} already has an active saving account: ${existing.accountNumber}.`,
    );
  }

  const effectiveDate = await getBusinessDate();

  const openingChargeInPaise =
    Number(await AppConfig.getValue(CONFIG_KEYS.SAVINGS_OPENING_CHARGE)) || 0;

  const accountNumber = await generateAccountNumber(effectiveDate);

  // Pre-generate both refs outside the session — generateTransactionId has no
  // DB side-effects that need to participate in the atomic session.
  const depositRef = openingChargeInPaise > 0
    ? await generateTransactionId(effectiveDate)
    : null;
  const chargeRef = openingChargeInPaise > 0
    ? await generateTransactionId(effectiveDate)
    : null;

  let account;

  await withTransaction(async (session) => {
    // Double-check inside the session to prevent a race between the
    // pre-check above (line 109) and the SavingAccount.create below.
    const existingInSession = await SavingAccount.findOne({
      customer: customerId,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    }).session(session);

    if (existingInSession) {
      throw ApiError.conflict(
        `Customer ${customer.customerCode} already has an active saving account: ` +
        `${existingInSession.accountNumber}. Concurrent request may have just created it.`,
      );
    }

    [account] = await SavingAccount.create(
      [
        {
          accountNumber,
          customer: customerId,
          balanceInPaise: 0,
          openingChargeInPaise,
          openingChargeDeducted: openingChargeInPaise > 0,
          openingChargeDeductedAt:
            openingChargeInPaise > 0 ? effectiveDate : null,
          status: ACCOUNT_STATUS.ACTIVE,
          openedBy,
          openedAt: effectiveDate,
          businessDate: effectiveDate,
          isDeleted: false,
        },
      ],
      { session },
    );

    if (openingChargeInPaise > 0) {
      // ── STEP A: Record cash received from customer ─────────────────────────
      // Balance moves:  0  →  openingChargeInPaise
      // Ledger:         DR Cash in Hand  →  CR Customer Saving Deposits
      await SavingAccount.findByIdAndUpdate(
        account._id,
        { $inc: { balanceInPaise: openingChargeInPaise } },
        { session },
      );

      const [depositTxn] = await Transaction.create(
        [
          {
            transactionId: depositRef,
            requestId,
            type: TRANSACTION_TYPES.SAVING_DEPOSIT,
            toSavingAccount: account._id,
            customer: customerId,
            performedBy: openedBy,
            amountInPaise: openingChargeInPaise,
            feeInPaise: 0,
            netAmountInPaise: openingChargeInPaise,
            balanceAfterInPaise: openingChargeInPaise,
            reference: accountNumber,
            note: `Opening charge cash received from customer — ${accountNumber}`,
            status: TRANSACTION_STATUS.COMPLETED,
            businessDate: effectiveDate,
          },
        ],
        { session },
      );

      await ledger.recordOpeningChargeDeposit({
        transaction: depositTxn._id,
        transactionRef: depositRef,
        amountInPaise: openingChargeInPaise,
        customer: customerId,
        performedBy: openedBy,
        businessDate: effectiveDate,
        session,
      });

      // ── STEP B: Deduct opening charge, recognise as company income ─────────
      // Balance moves:  openingChargeInPaise  →  0
      // Ledger:         DR Customer Saving Deposits  →  CR Opening Charge Income
      await SavingAccount.findByIdAndUpdate(
        account._id,
        { $inc: { balanceInPaise: -openingChargeInPaise } },
        { session },
      );

      const [chargeTxn] = await Transaction.create(
        [
          {
            transactionId: chargeRef,
            requestId,
            type: TRANSACTION_TYPES.SAVING_OPENING_CHARGE,
            fromSavingAccount: account._id,
            customer: customerId,
            performedBy: openedBy,
            amountInPaise: openingChargeInPaise,
            feeInPaise: 0,
            netAmountInPaise: openingChargeInPaise,
            balanceAfterInPaise: 0,
            reference: accountNumber,
            note: `Saving account opening charge deducted — ${accountNumber}`,
            status: TRANSACTION_STATUS.COMPLETED,
            businessDate: effectiveDate,
          },
        ],
        { session },
      );

      await ledger.recordOpeningCharge({
        transaction: chargeTxn._id,
        transactionRef: chargeRef,
        amountInPaise: openingChargeInPaise,
        customer: customerId,
        performedBy: openedBy,
        businessDate: effectiveDate,
        session,
      });
    }
  });

  await smsService
    .sendSavingAccountOpened(
      customer.phone,
      customer.name,
      accountNumber,
      (openingChargeInPaise / 100).toFixed(0),
    )
    .catch((e) => logger.warn(`[Saving] SMS failed: ${e.message}`));

  await AuditLog.log({
    performedBy: openedBy,
    action: AUDIT_ACTIONS.SAVING_ACCOUNT_CREATED,
    entity: "SavingAccount",
    entityId: account._id,
    newData: {
      accountNumber,
      customerId,
      openingChargeInPaise,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  logger.info(
    `[Saving] Created | ${accountNumber} | Customer: ${customer.customerCode} | ` +
    `Opening Charge: ₹${(openingChargeInPaise / 100).toFixed(0)} | By: ${openedBy}`,
  );

  return account.populate([
    { path: "customer", select: "name phone customerCode" },
    { path: "openedBy", select: "name role" },
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET SINGLE SAVING ACCOUNT (with live deposit stats)
// ─────────────────────────────────────────────────────────────────────────────
const getSavingAccount = async (accountId) => {
  const account = await SavingAccount.findById(accountId)
    .populate("customer", "name phone customerCode kycStatus")
    .populate("openedBy", "name role")
    .populate("closedBy", "name role")
    .populate("frozenBy", "name role");

  if (!account) throw ApiError.notFound("Saving account not found.");

  const stats = await Transaction.aggregate([
    {
      $match: {
        toSavingAccount: account._id,
        type: TRANSACTION_TYPES.SAVING_DEPOSIT,
        status: TRANSACTION_STATUS.COMPLETED,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalDeposited: { $sum: "$netAmountInPaise" },
        totalDeposits: { $sum: 1 },
        lastDepositAt: { $max: "$createdAt" },
      },
    },
  ]);

  const result = account.toObject();
  result.stats = {
    totalDepositedInPaise: stats[0]?.totalDeposited || 0,
    totalDepositedInRupees: ((stats[0]?.totalDeposited || 0) / 100).toFixed(2),
    totalDeposits: stats[0]?.totalDeposits || 0,
    lastDepositAt: stats[0]?.lastDepositAt || null,
    currentBalanceInRupees: (account.balanceInPaise / 100).toFixed(2),
  };
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. LIST SAVING ACCOUNTS (paginated, role-filtered)
// ─────────────────────────────────────────────────────────────────────────────
const listSavingAccounts = async ({
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  status,
  search,
  assignedAgent,
  requestingUserRole,
  requestingUserId,
}) => {
  const filter = { isDeleted: false };

  if (requestingUserRole === ROLES.AGENT) {
    const agentCustomers = await Customer.find(
      { assignedAgent: requestingUserId, isDeleted: false },
      "_id",
    ).lean();
    filter.customer = { $in: agentCustomers.map((c) => c._id) };
  }

  if (status) filter.status = status;
  if (assignedAgent) filter.assignedAgent = assignedAgent;

  if (search) {
    filter.$or = [
      { accountNumber: { $regex: escapeRegex(search.trim()), $options: "i" } },
    ];
  }

  const safeLimit = Math.min(Number(limit), PAGINATION.MAX_LIMIT);
  const skip = (Number(page) - 1) * safeLimit;

  const [accounts, total] = await Promise.all([
    SavingAccount.find(filter)
      .select(
        "accountNumber customer assignedAgent balanceInPaise status openedAt closedAt",
      )
      .populate("customer", "name phone customerCode")
      .populate("assignedAgent", "name agentCode")
      .skip(skip)
      .limit(safeLimit)
      .sort({ createdAt: -1 }),
    SavingAccount.countDocuments(filter),
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
// 4. GET SAVING ACCOUNTS BY CUSTOMER
// ─────────────────────────────────────────────────────────────────────────────
const getSavingAccountsByCustomer = async (customerId) => {
  const safeId = toObjId(customerId, "customerId");

  return SavingAccount.find({ customer: safeId, isDeleted: false })
    .select(
      "accountNumber balanceInPaise openingChargeInPaise status openedAt closedAt closureReason",
    )
    .sort({ createdAt: -1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET SAVING ACCOUNT STATEMENT (transaction history, paginated)
// ─────────────────────────────────────────────────────────────────────────────
const getSavingStatement = async ({
  accountId,
  page = PAGINATION.DEFAULT_PAGE,
  limit = PAGINATION.DEFAULT_LIMIT,
  fromDate,
  toDate,
}) => {
  const account = await SavingAccount.findById(accountId).lean();
  if (!account) throw ApiError.notFound("Saving account not found.");

  const txFilter = {
    $or: [{ fromSavingAccount: account._id }, { toSavingAccount: account._id }],
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
        "balanceAfterInPaise secondaryBalanceAfterInPaise toSavingAccount fromSavingAccount note status businessDate createdAt performedBy reversalOf " +
        "paymentMode chequeNumber utrNumber bankLedgerCode",
      )
      .populate("performedBy", "name role")
      .lean()
      .skip(skip)
      .limit(safeLimit)
      .sort({ createdAt: -1 }),
    Transaction.countDocuments(txFilter),
  ]);

  const mappedTransactions = transactions.map((tx) => {
    // If this saving account is the receiver of an internal transfer (pigmy -> saving),
    // the main balanceAfterInPaise holds the pigmy balance. We must swap it with secondary.
    if (
      tx.type === TRANSACTION_TYPES.PIGMY_TO_SAVING_TRANSFER &&
      tx.toSavingAccount?.toString() === account._id.toString()
    ) {
      if (tx.secondaryBalanceAfterInPaise !== undefined && tx.secondaryBalanceAfterInPaise !== null) {
        tx.balanceAfterInPaise = tx.secondaryBalanceAfterInPaise;
      } else {
        tx.balanceAfterInPaise = null; // Hide the irrelevant pigmy balance if null/old tx
      }
    }
    // Mirror case: saving → pigmy transfer — saving is the sender.
    // The main balanceAfterInPaise holds the pigmy (receiver) balance.
    // We must swap it with secondaryBalanceAfterInPaise (saving sender balance).
    if (
      tx.type === TRANSACTION_TYPES.SAVING_TO_PIGMY_TRANSFER &&
      tx.fromSavingAccount?.toString() === account._id.toString()
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
// 6. MANUAL DEPOSIT TO SAVING ACCOUNT (admin/agent)
// DR Cash/Bank (+asset) | CR Customer Saving Deposits (+liability)
// ─────────────────────────────────────────────────────────────────────────────
const depositToSaving = async ({
  accountId,
  amountInPaise,
  note,
  paymentMode = "cash",
  utrNumber,
  chequeNumber,
  chequeDate,
  bankLedgerCode,
  performedBy,
  ipAddress,
  requestId,
  idempotencyKey,
}) => {
  if (amountInPaise < 100) {
    throw ApiError.badRequest("Minimum deposit amount is ₹1 (100 paise).");
  }

  const account = await SavingAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Saving account not found.");

  assertSavingAccountActive(account);

  if (idempotencyKey) {
    const duplicate = await Transaction.findOne({ idempotencyKey }).lean();
    if (duplicate) {
      throw new ApiError(
        409,
        `Duplicate request. Transaction already recorded as ${duplicate.transactionId}.`,
      );
    }
  }

  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let newBalance;

  await withTransaction(async (session) => {
    const updated = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE },
      { $inc: { balanceInPaise: amountInPaise } },
      { returnDocument: "after", session },
    );

    if (!updated) {
      throw ApiError.forbidden(
        `Account ${account.accountNumber} is no longer active ` +
        `(may have been frozen or closed during this request). Refresh and retry.`,
      );
    }

    newBalance = updated.balanceInPaise;

    const [txn] = await Transaction.create(
      [
        {
          transactionId: transactionRef,
          requestId,
          idempotencyKey: idempotencyKey || null,
          type: TRANSACTION_TYPES.SAVING_DEPOSIT,
          toSavingAccount: accountId,
          customer: account.customer._id,
          performedBy,
          amountInPaise,
          feeInPaise: 0,
          netAmountInPaise: amountInPaise,
          balanceAfterInPaise: newBalance,
          reference: account.accountNumber,
          note:
            note?.trim() || `Manual saving deposit — ${account.accountNumber}`,
          paymentMode,
          utrNumber,
          chequeNumber,
          chequeDate,
          bankLedgerCode,
          status: TRANSACTION_STATUS.COMPLETED,
          businessDate: effectiveDate,
        },
      ],
      { session },
    );

    const resolvedDepositLedgerCode = bankLedgerCode || (paymentMode === "cash" ? "1001" : null);

    await ledger.recordSavingsDeposit({
      transaction: txn._id,
      transactionRef,
      amountInPaise,
      customer: account.customer._id,
      performedBy,
      businessDate: effectiveDate,
      session,
      paymentMode,
      bankLedgerCode: resolvedDepositLedgerCode,
    });
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.SAVING_DEPOSITED,
    entity: "SavingAccount",
    entityId: accountId,
    newData: {
      accountNumber: account.accountNumber,
      amountInPaise,
      balanceAfterInPaise: newBalance,
      transactionRef,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  await smsService
    .sendSavingDepositReceipt(
      account.customer.phone,
      account.customer.name,
      account.accountNumber,
      (amountInPaise / 100).toFixed(0),
      toIndianDate(effectiveDate),
      (newBalance / 100).toFixed(0)
    )
    .catch((e) => logger.warn(`[Saving] Deposit SMS failed: ${e.message}`));

  logger.info(
    `[Saving]  Deposit | ${account.accountNumber} | ` +
    `₹${(amountInPaise / 100).toFixed(2)} | ` +
    `Balance: ₹${(newBalance / 100).toFixed(2)} | By: ${performedBy}`,
  );

  return {
    accountNumber: account.accountNumber,
    transactionRef,
    amountInRupees: (amountInPaise / 100).toFixed(2),
    newBalanceInRupees: (newBalance / 100).toFixed(2),
    message: "Deposit recorded successfully.",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. CLOSE SAVING ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const closeSavingAccount = async ({
  accountId,
  closureReason,
  closedBy,
  paymentMode = "cash",
  bankLedgerCode,
  ipAddress,
  requestId,
}) => {
  const account = await SavingAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Saving account not found.");

  if (account.status === ACCOUNT_STATUS.CLOSED) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is already closed.`,
    );
  }

  if (account.status === ACCOUNT_STATUS.FROZEN) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is frozen. Unfreeze the account before closing it.`,
    );
  }


  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let definitiveReturnBalance;

  await withTransaction(async (session) => {
    const blockingLoan = await LoanAccount.findOne({
      customer: account.customer._id,
      status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
      isDeleted: false,
    }).session(session).lean();

    if (blockingLoan) {
      throw ApiError.badRequest(
        `Cannot close saving account — customer has an active/overdue loan: ` +
        `${blockingLoan.loanAccountNumber}. Repay it fully before closing this account.`,
      );
    }

    const blockingPigmy = await PigmyAccount.findOne({
      savingAccount: accountId,
      status: ACCOUNT_STATUS.ACTIVE,
      isDeleted: false,
    }).session(session).lean();

    if (blockingPigmy) {
      throw ApiError.badRequest(
        `Cannot close saving account — active pigmy account ` +
        `${blockingPigmy.accountNumber} is linked to it. ` +
        `Close the pigmy account first before closing this saving account.`,
      );
    }

    const closedAccount = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false },
      {
        $set: {
          status: ACCOUNT_STATUS.CLOSED,
          closedAt: effectiveDate,
          closedBy,
          closureReason,
          balanceInPaise: 0,
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

    definitiveReturnBalance = closedAccount.balanceInPaise;

    if (definitiveReturnBalance > 0) {
      const [txn] = await Transaction.create(
        [
          {
            transactionId: transactionRef,
            requestId,
            type: TRANSACTION_TYPES.SAVING_WITHDRAWAL,
            fromSavingAccount: accountId,
            customer: account.customer._id,
            performedBy: closedBy,
            amountInPaise: definitiveReturnBalance,
            feeInPaise: 0,
            netAmountInPaise: definitiveReturnBalance,
            balanceAfterInPaise: 0,
            reference: account.accountNumber,
            note: `Balance returned on account closure — ${account.accountNumber}`,
            status: TRANSACTION_STATUS.COMPLETED,
            businessDate: effectiveDate,
          },
        ],
        { session },
      );

      await ledger.recordSavingWithdrawal({
        transaction: txn._id,
        transactionRef,
        amountInPaise: definitiveReturnBalance,
        customer: account.customer._id,
        performedBy: closedBy,
        businessDate: effectiveDate,
        session,
        paymentMode,
        bankLedgerCode: bankLedgerCode || (paymentMode === "cash" ? "1001" : null),
      });
    }
  });

  await smsService
    .sendSavingAccountClosed(
      account.customer.phone,
      account.customer.name,
      account.accountNumber,
      (definitiveReturnBalance / 100).toFixed(2),
    )
    .catch((e) => logger.warn(`[Saving] Closure SMS failed: ${e.message}`));

  await AuditLog.log({
    performedBy: closedBy,
    action: AUDIT_ACTIONS.SAVING_ACCOUNT_CLOSED,
    entity: "SavingAccount",
    entityId: accountId,
    oldData: {
      status: account.status,
      balanceInPaise: definitiveReturnBalance,
    },
    newData: {
      status: ACCOUNT_STATUS.CLOSED,
      closureReason,
      returnedBalancePaise: definitiveReturnBalance,
      businessDate: effectiveDate,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  logger.info(
    `[Saving]  Closed | ${account.accountNumber} | ` +
    `Returned: ₹${(definitiveReturnBalance / 100).toFixed(2)} | By: ${closedBy}`,
  );

  return {
    message: "Saving account closed successfully.",
    accountNumber: account.accountNumber,
    returnedBalanceInRupees: (definitiveReturnBalance / 100).toFixed(2),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. FREEZE SAVING ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const freezeSavingAccount = async ({
  accountId,
  freezeReason,
  frozenBy,
  ipAddress,
  requestId,
}) => {
  const account = await SavingAccount.findById(accountId);
  if (!account) throw ApiError.notFound("Saving account not found.");

  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is ${account.status}. Only active accounts can be frozen.`,
    );
  }

  const effectiveDate = await getBusinessDate();

  await withTransaction(async (session) => {
    const frozenAccount = await SavingAccount.findOneAndUpdate(
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
    action: AUDIT_ACTIONS.SAVING_ACCOUNT_FROZEN,
    entity: "SavingAccount",
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
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  logger.warn(`[Saving] Frozen | ${account.accountNumber} | By: ${frozenBy}`);
  return {
    message: "Account frozen successfully.",
    accountNumber: account.accountNumber,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. UNFREEZE SAVING ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────
const unfreezeSavingAccount = async ({
  accountId,
  unfreezeReason,
  unfrozenBy,
  ipAddress,
  requestId,
}) => {
  const account = await SavingAccount.findById(accountId);
  if (!account) throw ApiError.notFound("Saving account not found.");

  if (account.status !== ACCOUNT_STATUS.FROZEN) {
    throw ApiError.badRequest(
      `Account ${account.accountNumber} is not frozen. Current status: ${account.status}.`,
    );
  }

  await withTransaction(async (session) => {
    const unfrozenAccount = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.FROZEN },
      {
        $set: {
          status: ACCOUNT_STATUS.ACTIVE,
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
    action: AUDIT_ACTIONS.SAVING_ACCOUNT_UNFROZEN,
    entity: "SavingAccount",
    entityId: accountId,
    oldData: { status: account.status, freezeReason: account.freezeReason },
    newData: {
      status: ACCOUNT_STATUS.ACTIVE,
      unfreezeReason: unfreezeReason || null,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  logger.info(
    `[Saving] → Unfrozen | ${account.accountNumber} | By: ${unfrozenBy}`,
  );
  return {
    message: "Account unfrozen successfully.",
    accountNumber: account.accountNumber,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. WITHDRAW FROM SAVING
// ─────────────────────────────────────────────────────────────────────────────
const withdrawFromSaving = async ({
  accountId,
  amountInPaise,
  note,
  paymentMode = "cash",
  utrNumber,
  chequeNumber,
  chequeDate,
  bankLedgerCode,
  performedBy,
  ipAddress,
  requestId,
  idempotencyKey
}) => {
  const account = await SavingAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Saving account not found.");
  assertSavingAccountActive(account);

  if (!amountInPaise || typeof amountInPaise !== "number" || amountInPaise <= 0) {
    throw ApiError.badRequest("Valid withdrawal amount is required.");
  }

  if (account.balanceInPaise < amountInPaise) {
    throw ApiError.badRequest(`Insufficient balance. Current balance is ₹${(account.balanceInPaise / 100).toFixed(2)}.`);
  }

  if (idempotencyKey) {
    const duplicate = await Transaction.findOne({ idempotencyKey }).lean();
    if (duplicate) {
      throw new ApiError(
        409,
        `Duplicate request. Transaction already recorded as ${duplicate.transactionId}.`,
      );
    }
  }

  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let newBalance;

  await withTransaction(async (session) => {
    const updatedAccount = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, balanceInPaise: { $gte: amountInPaise }, isDeleted: false },
      { $inc: { balanceInPaise: -amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedAccount) {
      throw ApiError.badRequest("Withdrawal failed due to insufficient balance or account status change.");
    }
    newBalance = updatedAccount.balanceInPaise;

    const [txn] = await Transaction.create(
      [{
        transactionId: transactionRef,
        requestId: requestId || null,
        idempotencyKey: idempotencyKey || null,
        type: TRANSACTION_TYPES.SAVING_WITHDRAWAL,
        fromSavingAccount: accountId,
        customer: account.customer,
        performedBy,
        amountInPaise,
        feeInPaise: 0,
        netAmountInPaise: amountInPaise,
        balanceAfterInPaise: newBalance,
        reference: account.accountNumber,
        note: note || "Saving account withdrawal",
        paymentMode,
        utrNumber,
        chequeNumber,
        chequeDate,
        bankLedgerCode,
        status: TRANSACTION_STATUS.COMPLETED,
        businessDate: effectiveDate,
        isDeleted: false,
      }],
      { session }
    );

    // Default to Cash in Hand (1001) for cash paymentMode
    const resolvedWithdrawLedgerCode = bankLedgerCode || (paymentMode === "cash" ? "1001" : null);

    await ledger.recordSavingWithdrawal({
      transaction: txn._id,
      transactionRef: transactionRef,
      amountInPaise,
      customer: account.customer,
      performedBy,
      businessDate: effectiveDate,
      session,
      paymentMode,
      bankLedgerCode: resolvedWithdrawLedgerCode,
    });
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.SAVING_WITHDRAWN,
    entity: "SavingAccount",
    entityId: accountId,
    oldData: { balanceInPaise: account.balanceInPaise },
    newData: { balanceInPaise: newBalance, withdrawalAmountInPaise: amountInPaise },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] AuditLog failed: ${e.message}`));

  await smsService
    .sendSavingWithdrawalReceipt(
      account.customer.phone,
      account.customer.name,
      account.accountNumber,
      (amountInPaise / 100).toFixed(0),
      toIndianDate(effectiveDate),
      (newBalance / 100).toFixed(0)
    )
    .catch((e) => logger.warn(`[Saving] Withdrawal SMS failed: ${e.message}`));

  return { transactionRef, amountInRupees: (amountInPaise / 100).toFixed(2), newBalanceInRupees: (newBalance / 100).toFixed(2) };
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. REPAY LOAN FROM SAVING
// ─────────────────────────────────────────────────────────────────────────────
const repayLoanFromSaving = async ({ accountId, loanAccountId, amountInPaise, note, performedBy, ipAddress, requestId }) => {
  const account = await SavingAccount.findById(accountId).populate(
    "customer",
    "name phone customerCode",
  );
  if (!account) throw ApiError.notFound("Saving account not found.");
  assertSavingAccountActive(account);
  const loanAccount = await LoanAccount.findById(loanAccountId);

  if (!loanAccount) throw ApiError.notFound("Loan account not found");
  if (![LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE].includes(loanAccount.status)) {
    throw ApiError.badRequest(`Loan account is ${loanAccount.status}. Disallowed.`);
  }

  if (amountInPaise > loanAccount.outstandingBalanceInPaise) {
    throw ApiError.badRequest(`Repayment amount exceeds outstanding balance of ₹${(loanAccount.outstandingBalanceInPaise / 100).toFixed(2)}`);
  }

  if (account.balanceInPaise < amountInPaise) {
    throw ApiError.badRequest("Insufficient saving balance for repayment.");
  }

  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let newSavingBalance, newLoanBalance, loanClosed = false;

  await withTransaction(async (session) => {
    const updatedSaving = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, balanceInPaise: { $gte: amountInPaise }, isDeleted: false },
      { $inc: { balanceInPaise: -amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedSaving) {
      throw ApiError.badRequest("Repayment failed: Insufficient saving balance.");
    }
    newSavingBalance = updatedSaving.balanceInPaise;

    // CRITICAL: Atomic $gte guard on the loan side prevents outstanding going
    // negative if two concurrent repayments race each other. Both the pre-check
    // above (stale-read) AND this session-locked filter must pass.
    const updatedLoan = await LoanAccount.findOneAndUpdate(
      {
        _id: loanAccountId,
        outstandingBalanceInPaise: { $gte: amountInPaise }, // ← session-locked overdraft guard
        status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
        isDeleted: false,
      },
      { $inc: { outstandingBalanceInPaise: -amountInPaise, totalPaidInPaise: amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedLoan) {
      // Concurrent repayment raced us — saving deduction must roll back too.
      throw ApiError.badRequest(
        "Repayment failed: Loan outstanding was modified by a concurrent request. " +
        "Refresh the loan balance and retry.",
      );
    }

    newLoanBalance = updatedLoan.outstandingBalanceInPaise;

    const [txn] = await Transaction.create(
      [{
        transactionId: transactionRef,
        requestId: requestId || null,
        type: TRANSACTION_TYPES.LOAN_REPAYMENT,
        fromSavingAccount: accountId,
        toLoanAccount: loanAccountId,
        customer: account.customer,
        performedBy,
        amountInPaise,
        feeInPaise: 0,
        netAmountInPaise: amountInPaise,
        balanceAfterInPaise: newLoanBalance,
        reference: loanAccount.loanAccountNumber,
        note: note || "Loan repayment directly from saving account",
        status: TRANSACTION_STATUS.COMPLETED,
        businessDate: effectiveDate,
        isDeleted: false,
      }],
      { session }
    );

    await ledger.recordLoanRepayment({
      transaction: txn._id,
      transactionRef,
      amountInPaise,
      customer: account.customer,
      performedBy,
      businessDate: effectiveDate,
      session,
    }, "2001");

    if (newLoanBalance === 0) {
      loanClosed = true;

      await LoanAccount.findByIdAndUpdate(
        loanAccountId,
        {
          $set: {
            status: LOAN_STATUS.CLOSED,
            closedAt: effectiveDate,
            closedBy: performedBy,
            closeNote: "Fully repaid via saving account transfer",
          },
        },
        { session },
      );

      // Unlink pigmy → loan reference so pigmy is free for future loans
      await PigmyAccount.findOneAndUpdate(
        { activeLoan: loanAccountId },
        { $unset: { activeLoan: "" } },
        { session },
      );
    }
  });

  await AuditLog.log({
    performedBy,
    action: AUDIT_ACTIONS.SAVING_WITHDRAWN,
    entity: "SavingAccount",
    entityId: accountId,
    oldData: {
      savingBalanceInPaise: account.balanceInPaise,
      loanOutstandingInPaise: loanAccount.outstandingBalanceInPaise,
    },
    newData: {
      savingBalanceAfterInPaise: newSavingBalance,
      loanOutstandingAfterInPaise: newLoanBalance,
      repaymentAmountInPaise: amountInPaise,
      loanClosed,
      transactionRef,
    },
    ipAddress,
    requestId,
    status: AUDIT_STATUS.SUCCESS,
  }).catch((e) => logger.error(`[Saving] repayLoanFromSaving AuditLog failed: ${e.message}`));

  // ── SMS: Loan repayment notification (non-critical) ──────────────────────
  await smsService
    .sendLoanRepayment(
      account.customer.phone,
      account.customer.name,
      (amountInPaise / 100).toFixed(0),
      loanAccount.loanAccountNumber,
      (newLoanBalance / 100).toFixed(0),
    )
    .catch((e) => logger.warn(`[Saving] Loan repayment SMS failed: ${e.message}`));

  // If loan fully closed via this repayment, send closure SMS too
  if (loanClosed) {
    await smsService
      .sendLoanClosed(
        account.customer.phone,
        account.customer.name,
        loanAccount.loanAccountNumber,
      )
      .catch((e) => logger.warn(`[Saving] Loan closure SMS failed: ${e.message}`));
  }

  return { transactionRef, loanClosed, remainingLoanBalanceInRupees: (newLoanBalance / 100).toFixed(2), newSavingBalanceInRupees: (newSavingBalance / 100).toFixed(2) };
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. TRANSFER SAVING → PIGMY
// ─────────────────────────────────────────────────────────────────────────────
const transferSavingToPigmy = async ({ accountId, pigmyAccountId, amountInPaise, note, performedBy, ipAddress, requestId }) => {
  const account = await SavingAccount.assertOperable(accountId);
  const pigmyAccount = await PigmyAccount.findById(pigmyAccountId);

  if (!pigmyAccount) throw ApiError.notFound("Pigmy account not found");
  if (pigmyAccount.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.badRequest(`Pigmy account is ${pigmyAccount.status}. Disallowed.`);
  }

  if (account.balanceInPaise < amountInPaise) {
    throw ApiError.badRequest("Insufficient saving balance for transfer.");
  }

  const effectiveDate = await getBusinessDate();
  const transactionRef = await generateTransactionId(effectiveDate);

  let newSavingBalance, newPigmyBalance;

  await withTransaction(async (session) => {
    const updatedSaving = await SavingAccount.findOneAndUpdate(
      { _id: accountId, status: ACCOUNT_STATUS.ACTIVE, balanceInPaise: { $gte: amountInPaise }, isDeleted: false },
      { $inc: { balanceInPaise: -amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedSaving) {
      throw ApiError.badRequest("Transfer failed: Insufficient saving balance.");
    }
    newSavingBalance = updatedSaving.balanceInPaise;

    const updatedPigmy = await PigmyAccount.findOneAndUpdate(
      { _id: pigmyAccountId, status: ACCOUNT_STATUS.ACTIVE, isDeleted: false },
      { $inc: { balanceInPaise: amountInPaise } },
      { returnDocument: "after", session }
    );

    if (!updatedPigmy) {
      // Pigmy account status may have changed concurrently (closed/frozen).
      throw ApiError.badRequest(
        "Transfer failed: Pigmy account is no longer active. " +
        "It may have been frozen or closed during this request. Refresh and retry.",
      );
    }

    newPigmyBalance = updatedPigmy.balanceInPaise;

    const [txn] = await Transaction.create(
      [{
        transactionId: transactionRef,
        requestId: requestId || null,
        type: TRANSACTION_TYPES.SAVING_TO_PIGMY_TRANSFER,
        fromSavingAccount: accountId,
        toPigmyAccount: pigmyAccountId,
        customer: account.customer,
        performedBy,
        amountInPaise,
        feeInPaise: 0,
        netAmountInPaise: amountInPaise,
        balanceAfterInPaise: newSavingBalance,
        secondaryBalanceAfterInPaise: newPigmyBalance,
        reference: pigmyAccount.accountNumber,
        note: note || "Internal transfer: Saving to Pigmy",
        status: TRANSACTION_STATUS.COMPLETED,
        businessDate: effectiveDate,
        isDeleted: false,
      }],
      { session }
    );

    await ledger.recordSavingToPigmyTransfer({
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
          "Saving " + account.accountNumber,
          "Pigmy " + pigmyAccount.accountNumber,
          toIndianDate(effectiveDate),
        )
        .catch((e) => logger.warn(`[Saving] Transfer SMS failed: ${e.message}`));
    }
  } catch (smsErr) {
    logger.warn(`[Saving] Transfer SMS customer lookup failed: ${smsErr.message}`);
  }

  return { transactionRef, newSavingBalanceInRupees: (newSavingBalance / 100).toFixed(2), newPigmyBalanceInRupees: (newPigmyBalance / 100).toFixed(2) };
};

module.exports = {
  createSavingAccount,
  getSavingAccount,
  listSavingAccounts,
  getSavingAccountsByCustomer,
  getSavingStatement,
  depositToSaving,
  closeSavingAccount,
  freezeSavingAccount,
  unfreezeSavingAccount,
  assertSavingAccountActive,
  withdrawFromSaving,
  repayLoanFromSaving,
  transferSavingToPigmy,
};
