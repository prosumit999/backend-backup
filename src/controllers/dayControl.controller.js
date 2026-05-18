// src/controllers/dayControl.controller.js
'use strict';

const dayControlService = require('../services/dayClose.service');
const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');

// GET /api/v1/day-control/status
const getDayStatus = asyncHandler(async (req, res) => {
    const result = await dayControlService.getDayStatus();
    return res.status(200).json(new ApiResponse(200, result, 'Day status fetched'));
});

// POST /api/v1/day-control/open
const openDay = asyncHandler(async (req, res) => {
    const { backdate, backdatePassword, catchupMode } = req.body;
    const result = await dayControlService.openDay({
        openedBy: req.user._id,
        ipAddress: req.ip,
        requestId: req.id,
        backdate: backdate || null,
        backdatePassword: backdatePassword || null,
        catchupMode: catchupMode === true,
        performingUserRole: req.user.role,
    });
    return res.status(200).json(new ApiResponse(200, result, result.message));
});

// POST /api/v1/day-control/close
const closeDay = asyncHandler(async (req, res) => {
    const result = await dayControlService.closeDay({
        closedBy: req.user._id,
        ipAddress: req.ip,
        requestId: req.id,
        forceClose: req.body.forceClose === true
    });
    return res.status(200).json(new ApiResponse(200, result, result.message));
});

// GET /api/v1/day-control/history
const getDayHistory = asyncHandler(async (req, res) => {
    // Note: BusinessDay is a model, but for architectural consistency we call a service method
    // Since getHistory is simple and read-only, we could do it in the controller, 
    // but better to add it to dayControlService.
    const result = await dayControlService.getDayHistory(req.query.limit);
    return res.status(200).json(new ApiResponse(200, result, 'Day history fetched'));
});

module.exports = {
    getDayStatus,
    getDayHistory,
    openDay,
    closeDay
};
