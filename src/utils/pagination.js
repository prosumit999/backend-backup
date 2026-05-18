// src/utils/pagination.js
// Eliminates repeated pagination boilerplate in every list service
'use strict';

const {PAGINATION} = require('../config/constants');

// ─────────────────────────────────────────────────────────
// PARSE PAGINATION
// Input : req.query ({ page, limit })
// Output: { page, limit, skip } — ready for .skip().limit()
// ─────────────────────────────────────────────────────────
const parsePagination = (query = {}) => {
    const page = Math.max(1, parseInt(query.page) || PAGINATION.DEFAULT_PAGE);
    const limit = Math.min(Math.max(1, parseInt(query.limit) || PAGINATION.DEFAULT_LIMIT), PAGINATION.MAX_LIMIT);
    const skip = (page - 1) * limit;
    return {page, limit, skip};
};

// ─────────────────────────────────────────────────────────
// BUILD PAGINATION RESPONSE
// Attaches consistent pagination metadata to every list response
// ─────────────────────────────────────────────────────────
const buildPaginationMeta = ({total, page, limit}) => ({
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page < Math.ceil(total / limit),
    hasPrevPage: page > 1
});

module.exports = {
    parsePagination,
    buildPaginationMeta
};
