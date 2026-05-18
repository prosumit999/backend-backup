// src/routes/report.routes.js
// ─── Reporting layer — all read-only, no DB writes ────────
// Dashboard: live summary for admin home screen
// Collection: daily/period totals, agent breakdown
// Loan: portfolio health, overdue list
// Financial: trial balance, P&L, cash position (superadmin only)
'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/report.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const {
    collectionReportSchema,
    agentPerformanceSchema,
    overdueReportSchema,
    trialBalanceSchema,
    pnlReportSchema,
    customerReportSchema,
    dailyTransactionReportSchema,
    ledgerHistorySchema
} = require('../validators/report.validator');

router.use(authenticate);

// ── DASHBOARD ─────────────────────────────────────────────
// GET /reports/dashboard → live KPIs (collections today, overdue count, open day status)
router.get('/dashboard', authorize('VIEW_REPORTS'), ctrl.getDashboard);

// ── COLLECTION REPORTS ────────────────────────────────────
// GET /reports/collections → period totals, agent filtered (agents see own only)
router.get('/collections', authorize('VIEW_COLLECTION'), validate(collectionReportSchema, 'query'), ctrl.getCollectionReport);

// ── AGENT PERFORMANCE ─────────────────────────────────────
// GET /reports/agents/performance → collection rate, amounts per agent
router.get('/agents/performance', authorize('VIEW_REPORTS'), validate(agentPerformanceSchema, 'query'), ctrl.getAgentPerformance);

// ── CUSTOMER REPORT ───────────────────────────────────────
// GET /reports/customers → KYC status breakdown, assigned agents
router.get('/customers', authorize('VIEW_REPORTS'), validate(customerReportSchema, 'query'), ctrl.getCustomerReport);

// ── LOAN REPORTS ──────────────────────────────────────────
// GET /reports/loans/portfolio → active/overdue/closed counts + amounts
router.get('/loans/portfolio', authorize('VIEW_REPORTS'), ctrl.getLoanPortfolio);

// GET /reports/loans/overdue → overdue loans with days + penalty
router.get('/loans/overdue', authorize('VIEW_REPORTS'), validate(overdueReportSchema, 'query'), ctrl.getOverdueReport);

// ── FINANCIAL — admin/superadmin only ─────────────────────
// GET /reports/financial/trial-balance → DR=CR balance check as of date
router.get('/financial/trial-balance', authorize('MANAGE_SETTINGS'), validate(trialBalanceSchema, 'query'), ctrl.getTrialBalance);

// GET /reports/financial/pnl → income vs expense for period
router.get('/financial/pnl', authorize('MANAGE_SETTINGS'), validate(pnlReportSchema, 'query'), ctrl.getPnlReport);

// GET /reports/financial/cash → current cash-in-hand ledger balance
router.get('/financial/cash', authorize('MANAGE_SETTINGS'), ctrl.getCashPosition);

// ── NEW REPORTS ──────────────────────────────────────────
// GET /reports/transactions/daily → list of all daily transactions
router.get('/transactions/daily', authorize('VIEW_REPORTS'), validate(dailyTransactionReportSchema, 'query'), ctrl.getDailyTransactionReport);

// GET /reports/financial/ledger-history → statement for specific GL
router.get('/financial/ledger-history', authorize('MANAGE_SETTINGS'), validate(ledgerHistorySchema, 'query'), ctrl.getLedgerHistory);

// ── CONSOLIDATED REPORTS ─────────────────────────────────
router.get('/consolidated/pigmy',  authorize('VIEW_REPORTS'), ctrl.getConsolidatedPigmy);
router.get('/consolidated/savings', authorize('VIEW_REPORTS'), ctrl.getConsolidatedSavings);
router.get('/consolidated/loans',   authorize('VIEW_REPORTS'), ctrl.getConsolidatedLoans);
router.get('/consolidated/agents',  authorize('VIEW_REPORTS'), ctrl.getConsolidatedAgents);


module.exports = router;
