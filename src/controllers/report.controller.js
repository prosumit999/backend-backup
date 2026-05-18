// src/controllers/report.controller.js
'use strict';
const reportService = require('../services/report.service');
const asyncHandler   = require('../utils/asyncHandler');
const ApiResponse    = require('../utils/ApiResponse');

// ── DASHBOARD ─────────────────────────────────────────────
const getDashboard = asyncHandler(async (req, res) => {
    const data = await reportService.getDashboard();
    res.status(200).json(new ApiResponse(200, data, 'Dashboard fetched'));
});

// ── COLLECTION REPORT ─────────────────────────────────────
const getCollectionReport = asyncHandler(async (req, res) => {
    const data = await reportService.getCollectionReport({
        ...req.query,
        requestingUserRole: req.user.role,
        requestingUserId:   req.user._id
    });
    res.status(200).json(new ApiResponse(200, data, 'Collection report fetched'));
});

// ── AGENT PERFORMANCE ─────────────────────────────────────
const getAgentPerformance = asyncHandler(async (req, res) => {
    const data = await reportService.getAgentPerformance(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Agent performance fetched'));
});

// ── LOAN REPORTS ──────────────────────────────────────────
const getLoanPortfolio = asyncHandler(async (req, res) => {
    const data = await reportService.getLoanPortfolio();
    res.status(200).json(new ApiResponse(200, data, 'Loan portfolio fetched'));
});

const getOverdueReport = asyncHandler(async (req, res) => {
    const data = await reportService.getOverdueReport(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Overdue loans fetched'));
});

// ── FINANCIAL ─────────────────────────────────────────────
const getTrialBalance = asyncHandler(async (req, res) => {
    const data = await reportService.getTrialBalance(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Trial balance fetched'));
});

const getPnlReport = asyncHandler(async (req, res) => {
    const data = await reportService.getPnlReport(req.query);
    res.status(200).json(new ApiResponse(200, data, 'P&L report fetched'));
});

const getCashPosition = asyncHandler(async (req, res) => {
    const data = await reportService.getCashPosition();
    res.status(200).json(new ApiResponse(200, data, 'Cash position fetched'));
});

// ── CUSTOMER REPORT ───────────────────────────────────────
const getCustomerReport = asyncHandler(async (req, res) => {
    const data = await reportService.getCustomerReport(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Customer report fetched'));
});

// ── DAILY TRANSACTIONS ────────────────────────────────────
const getDailyTransactionReport = asyncHandler(async (req, res) => {
    const data = await reportService.getDailyTransactionReport(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Daily transactions fetched'));
});

// ── LEDGER HISTORY ────────────────────────────────────────
const getLedgerHistory = asyncHandler(async (req, res) => {
    const data = await reportService.getLedgerHistory(req.query);
    res.status(200).json(new ApiResponse(200, data, 'Ledger history fetched'));
});

// ── CONSOLIDATED REPORTS ─────────────────────────────────
const getConsolidatedPigmy = asyncHandler(async (req, res) => {
    const data = await reportService.getConsolidatedPigmy();
    res.status(200).json(new ApiResponse(200, data, 'Consolidated pigmy fetched'));
});

const getConsolidatedSavings = asyncHandler(async (req, res) => {
    const data = await reportService.getConsolidatedSavings();
    res.status(200).json(new ApiResponse(200, data, 'Consolidated savings fetched'));
});

const getConsolidatedLoans = asyncHandler(async (req, res) => {
    const data = await reportService.getConsolidatedLoans();
    res.status(200).json(new ApiResponse(200, data, 'Consolidated loans fetched'));
});

const getConsolidatedAgents = asyncHandler(async (req, res) => {
    const data = await reportService.getConsolidatedAgents();
    res.status(200).json(new ApiResponse(200, data, 'Consolidated agents fetched'));
});



module.exports = {
    getDashboard,
    getCollectionReport,
    getAgentPerformance,
    getLoanPortfolio,
    getOverdueReport,
    getTrialBalance,
    getPnlReport,
    getCashPosition,
    getCustomerReport,
    getDailyTransactionReport,
    getLedgerHistory,
    getConsolidatedPigmy,
    getConsolidatedSavings,
    getConsolidatedLoans,
    getConsolidatedAgents
};
