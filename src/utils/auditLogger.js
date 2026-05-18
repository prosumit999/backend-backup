// src/utils/auditLogger.js
"use strict";

const AuditLog = require("../models/AuditLog.model");
const logger = require("./logger");

const logAudit = (data, session = null) => {
  const options = session ? { session } : {};
  return AuditLog.log(data, options).catch((err) =>
    logger.error(
      `[AuditLog] FAILED | Action: ${data.action} | ` +
        `Entity: ${data.entity} | EntityId: ${data.entityId} | ` +
        `Error: ${err.message}`,
    ),
  );
};

const buildAuditContext = (req) => ({
  performedBy: req.user?._id,
  requestId: req.id || req.headers["x-request-id"] || null,

  ipAddress:
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown",

  userAgent: req.headers["user-agent"] || null,
});

module.exports = { logAudit, buildAuditContext };
