// src/config/constants.js
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH — system-wide enums, roles, permissions, and actions.
//
// RULES:
//   1. NEVER use raw strings for any of these values in service/middleware files.
//   2. NEVER remove PERMISSIONS — authorize middleware depends on it for every
//      protected route. Removing it breaks the entire access-control layer.
//   3. To add a permission: add it here AND add the route middleware in one PR.
//   4. AUDIT_ACTIONS must be PAST-TENSE (event that happened). One action per
//      business event. Use AuditLog `status` field for success/failure — do NOT
//      create separate _SUCCESS/_FAILED action variants.
//      EXCEPTION: LOGIN_SUCCESS / LOGIN_FAILED are intentionally separate —
//      failed logins must be queryable independently for brute-force detection.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// ─────────────────────────────────────────────────────────
// ROLES
// dev        → software vendor (institution setup, genesis date, branding)
//              Highest privilege tier — bypasses system lock, day guard.
//              Cannot perform banking operations (no deposits, loans, etc.)
// superadmin → institution's IT/compliance officer (system config + watchdog)
// admin      → client's staff (all banking ops)
// agent      → field agent (collection + assigned customer view)
// ─────────────────────────────────────────────────────────
const ROLES = Object.freeze({
  DEV: "dev",
  SUPERADMIN: "superadmin",
  ADMIN: "admin",
  AGENT: "agent",
});

// ── Destructure for clean usage inside PERMISSIONS arrays ──

const { DEV, SUPERADMIN, ADMIN, AGENT } = ROLES;

// ─────────────────────────────────────────────────────────
// PERMISSIONS
// Format: { PERMISSION_KEY: [roles_that_have_it] }
// authorize middleware reads from here only — single source.
// Convention: VERB_NOUN (CREATE_LOAN, VIEW_AGENT, CLOSE_LOAN)
// ─────────────────────────────────────────────────────────
const PERMISSIONS = Object.freeze({
  // ── Dev Panel (DEV role only — vendor-level access) ───
  // Governs the Institution model: branding, genesis date, legal docs.
  // No banking operations allowed for this role.
  DEV_PANEL: [DEV],

  // ── System Config (SUPERADMIN only) ──────────────────
  CONFIG_UPDATE: [SUPERADMIN],
  SYSTEM_LOCK: [SUPERADMIN],
  SYSTEM_UNLOCK: [SUPERADMIN],
  SMS_TOGGLE: [SUPERADMIN],
  VIEW_AUDIT_LOGS: [SUPERADMIN, ADMIN],

  // ── Agent Management ─────────────────────────────────
  CREATE_AGENT: [SUPERADMIN, ADMIN],
  UPDATE_AGENT: [SUPERADMIN, ADMIN],
  DELETE_AGENT: [SUPERADMIN],
  MANAGE_AGENT_KYC: [SUPERADMIN, ADMIN],
  CHANGE_AGENT_STATUS: [SUPERADMIN, ADMIN],
  RECORD_AGENT_DEPOSIT: [ADMIN],
  REVERSE_AGENT_DEPOSIT: [SUPERADMIN, ADMIN],
  VIEW_AGENT_DEPOSIT: [SUPERADMIN, ADMIN, AGENT],
  VIEW_AGENT: [SUPERADMIN, ADMIN, AGENT],

  // ── Customer Management ──────────────────────────────
  // Superadmin can VIEW for oversight only — no creating/editing customers
  CREATE_CUSTOMER: [ADMIN, AGENT],
  VIEW_CUSTOMER: [SUPERADMIN, ADMIN, AGENT],
  UPDATE_CUSTOMER: [ADMIN],
  DELETE_CUSTOMER: [ADMIN],
  MANAGE_CUSTOMER_KYC: [SUPERADMIN, ADMIN],
  ASSIGN_AGENT: [ADMIN],
  REASSIGN_AGENT: [SUPERADMIN, ADMIN],
  HANDOVER_AGENT_PORTFOLIO: [SUPERADMIN, ADMIN],

  // ── Saving Account ────────────────────────────────────
  // Superadmin can VIEW saving accounts for audit/oversight — no transacting
  CREATE_SAVING_ACCOUNT: [ADMIN],
  VIEW_SAVING_ACCOUNT: [SUPERADMIN, ADMIN, AGENT],
  CLOSE_SAVING_ACCOUNT: [ADMIN],
  DEPOSIT_TO_SAVING: [ADMIN],
  WITHDRAW_FROM_SAVING: [SUPERADMIN, ADMIN],
  FREEZE_SAVING_ACCOUNT: [SUPERADMIN, ADMIN],
  UNFREEZE_SAVING_ACCOUNT: [SUPERADMIN, ADMIN],

  // ── Pigmy Account ────────────────────────────────────
  CREATE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN, AGENT],
  VIEW_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN, AGENT],
  UPDATE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  CLOSE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  FREEZE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  UNFREEZE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  DELETE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  RESTORE_PIGMY_ACCOUNT: [SUPERADMIN, ADMIN],
  TRANSFER_PIGMY_TO_SAVING: [SUPERADMIN, ADMIN],

  // ── Collections ──────────────────────────────────────
  CREATE_COLLECTION: [SUPERADMIN, ADMIN, AGENT],
  VIEW_COLLECTION: [SUPERADMIN, ADMIN, AGENT],
  REVERSE_COLLECTION: [SUPERADMIN, ADMIN],
  DELETE_COLLECTION: [SUPERADMIN, ADMIN],

  // ── Loan Management ──────────────────────────────────
  CREATE_LOAN_PLAN: [SUPERADMIN, ADMIN],
  UPDATE_LOAN_PLAN: [SUPERADMIN, ADMIN],
  VIEW_LOAN_PLAN: [SUPERADMIN, ADMIN],
  CREATE_LOAN: [SUPERADMIN, ADMIN],
  VIEW_LOAN: [SUPERADMIN, ADMIN, AGENT],
  APPLY_PIGMY_TO_LOAN: [SUPERADMIN, ADMIN],
  CLOSE_LOAN: [SUPERADMIN, ADMIN],
  LOAN_WRITE_OFF: [SUPERADMIN, ADMIN],
  REACTIVATE_LOAN: [SUPERADMIN, ADMIN],
  POST_LOAN_REPAYMENT: [SUPERADMIN, ADMIN],
  REVERSE_LOAN_REPAYMENT: [SUPERADMIN, ADMIN],

  // ── Penalty Management ───────────────────────────────
  APPLY_PENALTY: [SUPERADMIN, ADMIN],
  SEND_LOAN_REMINDER: [SUPERADMIN, ADMIN],
  VIEW_PENALTY_DASHBOARD: [SUPERADMIN, ADMIN],

  // ── Deficit & Lifeline Management ────────────────────
  VIEW_DEFICIT_DASHBOARD: [SUPERADMIN, ADMIN],
  RESET_LIFELINES: [SUPERADMIN, ADMIN],
  APPLY_SAVING_TO_LOAN: [SUPERADMIN, ADMIN],

  // ── Finance / Ledger ─────────────────────────────────
  VIEW_LEDGER: [SUPERADMIN, ADMIN],
  POST_JOURNAL_VOUCHER: [SUPERADMIN, ADMIN],
  VIEW_TRIAL_BALANCE: [SUPERADMIN, ADMIN],
  DAY_OPEN: [SUPERADMIN, ADMIN],
  DAY_CLOSE: [SUPERADMIN, ADMIN],
  BACKDATE_DAY_OPEN: [SUPERADMIN],
  VIEW_DAY_STATUS: [SUPERADMIN, ADMIN, AGENT, DEV],
  PIGMY_COLLECTION: [SUPERADMIN, ADMIN, AGENT],

  // ── Transactions (unified history) ───────────────────
  VIEW_TRANSACTIONS: [SUPERADMIN, ADMIN],

  // ── Reports ──────────────────────────────────────────
  EXPORT_REPORTS: [SUPERADMIN, ADMIN],
  VIEW_REPORTS: [SUPERADMIN, ADMIN],
  VIEW_AGENT_REPORTS: [SUPERADMIN, ADMIN, AGENT],
  MANAGE_SETTINGS: [SUPERADMIN, ADMIN],
  CREATE_ADMIN: [SUPERADMIN],
  VIEW_ADMIN: [SUPERADMIN],
  RESET_ADMIN_PASSWORD: [SUPERADMIN],
  MANAGE_ADMIN_STATUS: [SUPERADMIN],
  MANAGE_LEDGER_ACCOUNTS: [SUPERADMIN],
  VIEW_DECRYPTED_PII: [SUPERADMIN, ADMIN],
});

// ─────────────────────────────────────────────────────────
// APP CONFIG KEYS
// Managed by SUPERADMIN via /api/v1/config endpoints.
// These are the MongoDB AppConfig document keys — always
// use these constants, never raw strings.
//
//     CRON_LOCK_* keys below must be EXCLUDED from the
//     updateConfig allowed-keys list in superadmin.service.js.
//     These are written only by cron workers — manual override
//     can permanently disable penalty/reconcile cron jobs.
// ─────────────────────────────────────────────────────────
const CONFIG_KEYS = Object.freeze({
  // ── Charges & Rates (Superadmin-configurable) ─────────
  SAVINGS_OPENING_CHARGE: "SAVINGS_OPENING_CHARGE",
  PROCESSING_FEE_BPS: "PROCESSING_FEE_BPS",
  // DEFAULT_INTEREST_RATE_BPS: Only used by the loan plan seed script.
  // Not read at runtime. Kept here for seed.js backward-compat only.
  DEFAULT_INTEREST_RATE_BPS: "DEFAULT_INTEREST_RATE_BPS",
  PENALTY_EXTRA_RATE_BPS: "PENALTY_EXTRA_RATE_BPS",
  LATE_PENALTY_EXTRA_BPS: "LATE_PENALTY_EXTRA_BPS",
  PENALTY_AMOUNT_PER_MISSED_DAY: "PENALTY_AMOUNT_PER_MISSED_DAY",

  // ── SMS ───────────────────────────────────────────────
  SMS_ENABLED_GLOBAL: "SMS_ENABLED_GLOBAL",

  // ── System ────────────────────────────────────────────
  SYSTEM_LOCKED: "SYSTEM_LOCKED",

  // ── Day Control (managed by dayClose.service.js only) ─
  DAY_STATUS: "DAY_STATUS",
  CURRENT_BUSINESS_DATE: "CURRENT_BUSINESS_DATE",
  IS_CURRENT_DAY_BACKDATED: "IS_CURRENT_DAY_BACKDATED",

  // ── Catch-Up Day Processing ───────────────────────────
  // Set to true when a backdated day is opened specifically because the admin
  // missed processing that date (not a ledger correction).
  // When true, full EOD job chain runs on close — identical to normal close.
  // When false (correction mode), EOD is skipped to prevent double-charging.
  // Reset to false automatically after every day close.
  IS_CATCHUP_MODE: "IS_CATCHUP_MODE",

  // ── Pigmy Deficit Warning — superadmin-configurable ──
  // How many SMS warnings a customer gets before admin can apply penalty.
  // After this many consecutive deficit days, isPenaltyEligible = true.
  WARNING_SMS_BEFORE_PENALTY: "WARNING_SMS_BEFORE_PENALTY",

  // ── Security (Superadmin-configurable) ────────────────
  MAX_LOGIN_ATTEMPTS: "MAX_LOGIN_ATTEMPTS",
  LOCK_DURATION_MINUTES: "LOCK_DURATION_MINUTES",

  // ── Cron internal locks — NOT editable via updateConfig API ──
  // These are written only by cron workers. Manual override can permanently
  // disable penalty/reconcile jobs — DO NOT expose in UI.
  CRON_LOCK_PENALTY: "CRON_LOCK_PENALTY",
  CRON_LOCK_RECONCILE: "CRON_LOCK_RECONCILE",
  CRON_LOCK_MISSED_DAY_TRACKING: "CRON_LOCK_MISSED_DAY_TRACKING",
  CRON_LOCK_DEFICIT_WARNING: "CRON_LOCK_DEFICIT_WARNING",

  // ── REMOVED KEYS (documented for migration reference) ─
  // DAY_CLOSE_TIME           — defined but never read at runtime. Removed.
  // MAX_ALLOWED_LEAVES_PER_MONTH — defined but never read at runtime. Removed.
  // SYSTEM_GENESIS_DATE      — migrated to Institution.model.js singleton.
});

// Keys that the updateConfig API endpoint is ALLOWED to update via
// PATCH /superadmin/config. Anything not in this list is rejected.
//
// Excluded intentionally:
//   CRON_LOCK_*           — cron workers own these; manual override breaks jobs
//   DAY_STATUS, etc.      — managed exclusively by dayClose.service.js
//   DEFAULT_INTEREST_RATE_BPS — seed-only; not used at runtime
//   SYSTEM_GENESIS_DATE   — migrated to Institution model; managed by Dev Panel
const CONFIG_UPDATABLE_KEYS = Object.freeze([
  CONFIG_KEYS.SAVINGS_OPENING_CHARGE,
  CONFIG_KEYS.PROCESSING_FEE_BPS,
  CONFIG_KEYS.PENALTY_EXTRA_RATE_BPS,
  CONFIG_KEYS.LATE_PENALTY_EXTRA_BPS,
  CONFIG_KEYS.PENALTY_AMOUNT_PER_MISSED_DAY,
  CONFIG_KEYS.MAX_LOGIN_ATTEMPTS,
  CONFIG_KEYS.LOCK_DURATION_MINUTES,
  CONFIG_KEYS.WARNING_SMS_BEFORE_PENALTY,
]);

// ─────────────────────────────────────────────────────────
// ACCOUNT STATUS (Saving + Pigmy)
// ─────────────────────────────────────────────────────────
const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: "active",
  CLOSED: "closed",
  FROZEN: "frozen",
});

// ─────────────────────────────────────────────────────────
// LOAN STATUS
// ─────────────────────────────────────────────────────────
const LOAN_STATUS = Object.freeze({
  ACTIVE: "active",
  OVERDUE: "overdue",
  CLOSED: "closed",
  WRITTEN_OFF: "written_off",
});

// ─────────────────────────────────────────────────────────
// DAY STATUS
// ─────────────────────────────────────────────────────────
const DAY_STATUS = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
});

// ─────────────────────────────────────────────────────────
// COLLECTION STATUS
// ─────────────────────────────────────────────────────────
const COLLECTION_STATUS = Object.freeze({
  COLLECTED: "collected",
  MISSED: "missed",
  PENDING: "pending",
  REVERSED: "reversed",
});

// ─────────────────────────────────────────────────────────
// PAYMENT MODES
// Used by: Transaction.model.js, saving.service.js, account.routes.js (Joi validation)
// "cash"          = physical notes/coins handed over in person
// "cheque"        = physical cheque deposited at bank
// "bank_transfer" = NEFT/RTGS wire transfer (hits company bank account)
// "online"        = UPI / Net-banking / digital wallet payment
// ─────────────────────────────────────────────────────────
const PAYMENT_MODES = Object.freeze({
  CASH: "cash",
  BANK_TRANSFER: "bank_transfer",
  CHEQUE: "cheque",
  ONLINE: "online",
});

// ─────────────────────────────────────────────────────────
// COLLECTION TYPES
// ─────────────────────────────────────────────────────────
const COLLECTION_TYPES = Object.freeze({
  DAILY: "daily",
  WEEKLY: "weekly",
  MANUAL: "manual",
});
// ─────────────────────────────────────────────────────────
// TRANSACTION STATUS
// ─────────────────────────────────────────────────────────
const TRANSACTION_STATUS = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  REVERSED: "reversed",
});

// ─────────────────────────────────────────────────────────
// TRANSACTION TYPES
// Every financial movement gets exactly one type.
// ─────────────────────────────────────────────────────────
const TRANSACTION_TYPES = Object.freeze({
  // ── Saving Account ─────────────────────────────────
  SAVING_OPENING_CHARGE: "saving_opening_charge",
  SAVING_DEPOSIT: "saving_deposit",
  SAVING_WITHDRAWAL: "saving_withdrawal",

  // ── Pigmy Account ──────────────────────────────────
  PIGMY_COLLECTION: "pigmy_collection",
  PIGMY_WITHDRAWAL: "pigmy_withdrawal",

  // ── Agent Collection ───────────────────────────────
  AGENT_COLLECTION: "agent_collection",
  AGENT_COLLECTION_REVERSAL: "agent_collection_reversal",
  COLLECTION_REVERSAL: "collection_reversal",

  // ── Agent Deposit ──────────────────────────────────
  AGENT_DEPOSIT: "agent_deposit",
  AGENT_DEPOSIT_REVERSAL: "agent_deposit_reversal",

  // ── Loan Disbursement — 4 atomic ledger steps ──────
  LOAN_TO_SAVING: "loan_to_saving",
  PROCESSING_FEE: "processing_fee",
  INTEREST_DEDUCTION: "interest_deduction",
  NET_CASH_DISBURSAL: "net_cash_disbursal",

  // ── Loan Disbursement — 1 summary idempotency record ──
  LOAN_DISBURSEMENT: "loan_disbursement",

  // ── Loan Repayment & Closure ───────────────────────
  LOAN_REPAYMENT: "loan_repayment",
  LOAN_REPAYMENT_REVERSAL: "loan_repayment_reversal",
  LOAN_CLOSURE: "loan_closure",
  LOAN_WRITE_OFF: "loan_write_off",
  LOAN_WRITE_OFF_REVERSAL: "loan_write_off_reversal",

  // ── Penalty ────────────────────────────────────────
  PENALTY_CHARGE: "penalty_charge",
  // Missed-collection penalty — manually applied by admin after lifelines exhausted
  MISSED_COLLECTION_PENALTY: "missed_collection_penalty",

  // ── Saving → Loan Direct Repayment ─────────────────
  // Customer has saving balance; admin applies it directly to reduce loan outstanding.
  // Ledger: DR Saving Deposits | CR Loans Receivable
  SAVING_TO_LOAN_REPAYMENT: "saving_to_loan_repayment",

  // ── Admin / Finance ────────────────────────────────
  JOURNAL_VOUCHER: "journal_voucher",
  CAPITAL_INFUSION: "capital_infusion",
  SAVING_TO_PIGMY_TRANSFER: "saving_to_pigmy_transfer",
  PIGMY_TO_SAVING_TRANSFER: "pigmy_to_saving_transfer",
  // NOTE: Removed generic REVERSAL — use specific reversal types above.
  //       Generic types break report queries and audit trail clarity.
});

// ─────────────────────────────────────────────────────────
// LEDGER ACCOUNT TYPES
// ─────────────────────────────────────────────────────────
const LEDGER_ACCOUNT_TYPES = Object.freeze({
  ASSET: "asset",
  LIABILITY: "liability",
  INCOME: "income",
  EXPENSE: "expense",
  EQUITY: "equity",
});

// ─────────────────────────────────────────────────────────
// LEDGER NORMAL BALANCE
// ─────────────────────────────────────────────────────────
const LEDGER_NORMAL_BALANCE = Object.freeze({
  DEBIT: "debit",
  CREDIT: "credit",
});

// ─────────────────────────────────────────────────────────
// KYC STATUS — Customers
// Flow: pending → phone_verified → documents_submitted
//               → kyc_verified | kyc_rejected
// ─────────────────────────────────────────────────────────
const KYC_STATUS = Object.freeze({
  PENDING: "pending",
  PHONE_VERIFIED: "phone_verified",
  DOCUMENTS_SUBMITTED: "documents_submitted",
  KYC_VERIFIED: "kyc_verified",
  KYC_REJECTED: "kyc_rejected",
});

// ─────────────────────────────────────────────────────────
// AGENT KYC STATUS
// Flow: pending → documents_submitted → kyc_verified | kyc_rejected
// ─────────────────────────────────────────────────────────
const AGENT_KYC_STATUS = Object.freeze({
  PENDING: "pending",
  DOCUMENTS_SUBMITTED: "documents_submitted",
  KYC_VERIFIED: "kyc_verified",
  KYC_REJECTED: "kyc_rejected",
});

// ─────────────────────────────────────────────────────────
// AGENT STATUS
// ─────────────────────────────────────────────────────────
const AGENT_STATUS = Object.freeze({
  ACTIVE: "active",
  INACTIVE: "inactive",
  SUSPENDED: "suspended",
  TERMINATED: "terminated",
});

// ─────────────────────────────────────────────────────────
// LOAN TENURE OPTIONS (months)
// ─────────────────────────────────────────────────────────
const LOAN_DURATIONS = Object.freeze([3, 6, 12, 18, 24]);

// ─────────────────────────────────────────────────────────
// AUDIT STATUS
// ─────────────────────────────────────────────────────────
const AUDIT_STATUS = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
});

// ─────────────────────────────────────────────────────────
// AUDIT ACTIONS
// Convention: PAST-TENSE, NOUN_VERB format (what happened).
// One action per business event. Do NOT create _SUCCESS/_FAILED variants —
// use the AuditLog `status` field (AUDIT_STATUS) for that distinction.
// EXCEPTION: LOGIN_SUCCESS / LOGIN_FAILED are kept separate because
// failed logins must be independently queryable for brute-force detection.
// ─────────────────────────────────────────────────────────
const AUDIT_ACTIONS = Object.freeze({
  // ── Auth ─────────────────────────────────────────────
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  CHANGE_PASSWORD: "CHANGE_PASSWORD",
  REFRESH_TOKEN_REUSE_DETECTED: "REFRESH_TOKEN_REUSE_DETECTED",
  TOKEN_REFRESHED: "TOKEN_REFRESHED",

  // ── User ─────────────────────────────────────────────
  UPDATE_OWN_PROFILE: "UPDATE_OWN_PROFILE",

  // ── Agent ────────────────────────────────────────────
  AGENT_CREATED: "AGENT_CREATED",
  AGENT_UPDATED: "AGENT_UPDATED",
  AGENT_PROFILE_UPDATED: "AGENT_PROFILE_UPDATED",
  AGENT_DOCS_UPLOADED: "AGENT_DOCS_UPLOADED",
  AGENT_KYC_APPROVED: "AGENT_KYC_APPROVED",
  AGENT_KYC_REJECTED: "AGENT_KYC_REJECTED",
  AGENT_KYC_RESET: "AGENT_KYC_RESET",
  AGENT_SUSPENDED: "AGENT_SUSPENDED",
  AGENT_UNSUSPENDED: "AGENT_UNSUSPENDED",
  AGENT_TERMINATED: "AGENT_TERMINATED",
  AGENT_ACTIVATED: "AGENT_ACTIVATED",
  AGENT_DEACTIVATED: "AGENT_DEACTIVATED",
  AGENT_DEPOSIT_RECORDED: "AGENT_DEPOSIT_RECORDED",
  AGENT_DEPOSIT_REVERSED: "AGENT_DEPOSIT_REVERSED",
  AGENT_ACCOUNTS_UNASSIGNED: "AGENT_ACCOUNTS_UNASSIGNED",
  AGENT_REASSIGNED: "AGENT_REASSIGNED",
  AGENT_PORTFOLIO_TRANSFERRED: "AGENT_PORTFOLIO_TRANSFERRED",
  CUSTOMER_AGENT_CHANGED: "CUSTOMER_AGENT_CHANGED",

  // ── Customer ─────────────────────────────────────────
  CUSTOMER_CREATED: "CUSTOMER_CREATED",
  CUSTOMER_UPDATED: "CUSTOMER_UPDATED",
  CUSTOMER_DELETED: "CUSTOMER_DELETED",
  CUSTOMER_RESTORED: "CUSTOMER_RESTORED",
  AGENT_ASSIGNED: "AGENT_ASSIGNED",

  // ── Customer KYC ─────────────────────────────────────
  PHONE_OTP_VERIFIED: "PHONE_OTP_VERIFIED",
  KYC_DOCUMENTS_SUBMITTED: "KYC_DOCUMENTS_SUBMITTED",
  KYC_VERIFIED: "KYC_VERIFIED",
  KYC_REJECTED: "KYC_REJECTED",
  AADHAAR_VIEWED: "AADHAAR_VIEWED",
  PAN_VIEWED: "PAN_VIEWED",

  // ── Saving Account ───────────────────────────────────
  SAVING_ACCOUNT_CREATED: "SAVING_ACCOUNT_CREATED",
  SAVING_ACCOUNT_CLOSED: "SAVING_ACCOUNT_CLOSED",
  SAVING_ACCOUNT_FROZEN: "SAVING_ACCOUNT_FROZEN",
  SAVING_ACCOUNT_UNFROZEN: "SAVING_ACCOUNT_UNFROZEN",
  SAVING_DEPOSITED: "SAVING_DEPOSITED",
  SAVING_WITHDRAWN: "SAVING_WITHDRAWN",

  // ── Pigmy Account ────────────────────────────────────
  PIGMY_ACCOUNT_CREATED: "PIGMY_ACCOUNT_CREATED",
  PIGMY_ACCOUNT_UPDATED: "PIGMY_ACCOUNT_UPDATED",
  PIGMY_ACCOUNT_CLOSED: "PIGMY_ACCOUNT_CLOSED",
  PIGMY_ACCOUNT_FROZEN: "PIGMY_ACCOUNT_FROZEN",
  PIGMY_ACCOUNT_UNFROZEN: "PIGMY_ACCOUNT_UNFROZEN",
  PIGMY_ACCOUNT_DELETED: "PIGMY_ACCOUNT_DELETED",
  PIGMY_ACCOUNT_RESTORED: "PIGMY_ACCOUNT_RESTORED",

  // ── Collections ──────────────────────────────────────
  COLLECTION_RECORDED: "COLLECTION_RECORDED",
  COLLECTION_REVERSED: "COLLECTION_REVERSED",
  MISSED_DAY_TRACKED: "MISSED_DAY_TRACKED",
  SCHEDULER_STARTED: "SCHEDULER_STARTED",

  // ── Loan Plan ────────────────────────────────────────
  LOAN_PLAN_CREATED: "LOAN_PLAN_CREATED",
  LOAN_PLAN_UPDATED: "LOAN_PLAN_UPDATED",
  LOAN_PLAN_ACTIVATED: "LOAN_PLAN_ACTIVATED",
  LOAN_PLAN_DEACTIVATED: "LOAN_PLAN_DEACTIVATED",

  // ── Loan ─────────────────────────────────────────────
  LOAN_CREATED: "LOAN_CREATED",
  LOAN_REPAYMENT_APPLIED: "LOAN_REPAYMENT_APPLIED",
  LOAN_REPAYMENT_REVERSED: "LOAN_REPAYMENT_REVERSED",
  PIGMY_APPLIED_TO_LOAN: "PIGMY_APPLIED_TO_LOAN",
  LOAN_CLOSED: "LOAN_CLOSED",
  LOAN_WRITTEN_OFF: "LOAN_WRITTEN_OFF",
  LOAN_REACTIVATED: "LOAN_REACTIVATED",
  LOAN_OVERDUE_MARKED: "LOAN_OVERDUE_MARKED",
  PENALTY_APPLIED: "PENALTY_APPLIED",
  MISSED_COLLECTION_PENALTY_APPLIED: "MISSED_COLLECTION_PENALTY_APPLIED",
  LOAN_REMINDER_SENT: "LOAN_REMINDER_SENT",

  // ── Deficit Warning & Lifeline ────────────────────────
  DEFICIT_WARNING_SENT: "DEFICIT_WARNING_SENT",       // cron sent a warning SMS
  LIFELINE_EXHAUSTED: "LIFELINE_EXHAUSTED",           // 0 lifelines left, penalty eligible
  LIFELINE_RECOVERED: "LIFELINE_RECOVERED",           // customer caught up, auto-restored
  LIFELINES_RESET: "LIFELINES_RESET",                 // admin manually adjusted lifelines
  SAVING_APPLIED_TO_LOAN: "SAVING_APPLIED_TO_LOAN",   // saving balance → loan repayment

  // ── Finance ───────────────────────────────────────────
  JOURNAL_VOUCHER_POSTED: "JOURNAL_VOUCHER_POSTED",
  CAPITAL_INFUSION_RECORDED: "CAPITAL_INFUSION_RECORDED",
  DAY_OPENED: "DAY_OPENED",
  DAY_CLOSED: "DAY_CLOSED",
  DAY_OPENED_BACKDATED: "DAY_OPENED_BACKDATED",
  BACKDATE_AUTH_FAILED: "BACKDATE_AUTH_FAILED",
  // Catch-up open is a distinct audit event from normal backdate correction.
  // Queryable independently to track how often missed-day recovery is used.
  DAY_OPENED_CATCHUP: "DAY_OPENED_CATCHUP",
  FORCE_CLOSE_UNSETTLED_AGENTS: "FORCE_CLOSE_UNSETTLED_AGENTS",
  UNSETTLED_AGENTS_FORCE_CLOSED: "UNSETTLED_AGENTS_FORCE_CLOSED",

  // ── Reconciliation ────────────────────────────────────
  RECONCILE_PASSED: "RECONCILE_PASSED",
  RECONCILE_FAILED: "RECONCILE_FAILED",
  RECONCILIATION_BREACH: "RECONCILIATION_BREACH",
  BALANCE_MISMATCH: "BALANCE_MISMATCH",

  // ── System (SUPERADMIN) ───────────────────────────────
  CONFIG_UPDATED: "CONFIG_UPDATED",
  SYSTEM_LOCKED: "SYSTEM_LOCKED",
  SYSTEM_UNLOCKED: "SYSTEM_UNLOCKED",
  SMS_ENABLED: "SMS_ENABLED",
  SMS_DISABLED: "SMS_DISABLED",
  AUDIT_LOGS_VIEWED: "AUDIT_LOGS_VIEWED",
  ADMIN_CREATED: "ADMIN_CREATED",
  ADMIN_UPDATED: "ADMIN_UPDATED",
  ADMIN_STATUS_CHANGED: "ADMIN_STATUS_CHANGED",
  ADMIN_PASSWORD_RESET: "ADMIN_PASSWORD_RESET",
  LEDGER_ACCOUNT_CREATED: "LEDGER_ACCOUNT_CREATED",
  LEDGER_ACCOUNT_UPDATED: "LEDGER_ACCOUNT_UPDATED",

  // ── Dev Panel (DEV role) ──────────────────────────────
  INSTITUTION_CONFIGURED: "INSTITUTION_CONFIGURED",   // First-time institution setup
  INSTITUTION_UPDATED: "INSTITUTION_UPDATED",         // Partial institution data update
  GENESIS_DATE_UPDATED: "GENESIS_DATE_UPDATED",       // System genesis date changed
  LEGAL_DOCS_UPDATED: "LEGAL_DOCS_UPDATED",           // Privacy policy/rules/T&C changed
  DEV_PASSWORD_CHANGED: "DEV_PASSWORD_CHANGED",       // Dev user changed own password
});

// ─────────────────────────────────────────────────────────
// COLLECTION FREQUENCY
// Single source of truth for pigmy collection schedule types.
// NOTE: Currently only DAILY is fully implemented in collection.service.js.
//       WEEKLY is defined here but BLOCKED at the service level until the
//       weekly scheduling logic is built. See createPigmyAccount() guard.
// ─────────────────────────────────────────────────────────
const COLLECTION_FREQUENCY = Object.freeze({
  DAILY: "daily",
  WEEKLY: "weekly",
});

// ─────────────────────────────────────────────────────────
// PAGINATION DEFAULTS
// ─────────────────────────────────────────────────────────
const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
});

// ─────────────────────────────────────────────────────────
module.exports = {
  ROLES,
  PERMISSIONS,
  CONFIG_KEYS,
  CONFIG_UPDATABLE_KEYS,
  ACCOUNT_STATUS,
  LOAN_STATUS,
  DAY_STATUS,
  COLLECTION_STATUS,
  PAYMENT_MODES,
  COLLECTION_TYPES,
  COLLECTION_FREQUENCY,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  LEDGER_ACCOUNT_TYPES,
  LEDGER_NORMAL_BALANCE,
  KYC_STATUS,
  AGENT_KYC_STATUS,
  AGENT_STATUS,
  LOAN_DURATIONS,
  AUDIT_ACTIONS,
  AUDIT_STATUS,
  PAGINATION,
};
