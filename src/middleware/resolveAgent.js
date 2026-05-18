// src/middleware/resolveAgent.js
"use strict";

const User = require("../models/User.model");
const AgentProfile = require("../models/AgentProfile.model");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");

/**
 * resolveAgent — resolves /:id to User + AgentProfile pair.
 *
 * Accepts:
 *   - agentCode  → AGT-2026-0004   (frontend always sends this)
 *   - MongoDB _id → 507f1f77bc...  (internal use only)
 *
 * Sets:
 *   req.agentUser    → User doc (raw — for internal middleware use only)
 *   req.agentProfile → AgentProfile doc (aadhaarNumberEncrypted +
 *                      panNumberEncrypted excluded via select:false on schema)
 *   req.agent        → safe merged view — sensitive auth fields pre-stripped
 */
const resolveAgent = async (req, res, next) => {
  try {
    const id = req.params.id?.trim();
    if (!id) return next(ApiError.badRequest("Agent ID is required"));

    let agentUser;

    if (/^AGT-\d{4}-\d{4,}$/i.test(id)) {
      agentUser = await User.findOne({
        agentCode: id.toUpperCase(),
        role: ROLES.AGENT,
        isDeleted: false,
      });
    } else if (/^[0-9a-fA-F]{24}$/.test(id)) {
      agentUser = await User.findOne({
        _id: id,
        role: ROLES.AGENT,
        isDeleted: false,
      });
    } else {
      return next(ApiError.badRequest(`Invalid agent identifier: '${id}'`));
    }

    if (!agentUser) return next(ApiError.notFound("Agent not found"));

    // RES-2: isDeleted:false removed — pre-find hook on AgentProfile handles it
    // APROF-9: aadhaarNumberEncrypted + panNumberEncrypted excluded via select:false
    const agentProfile = await AgentProfile.findOne({ user: agentUser._id });

    req.agentUser = agentUser;
    req.agentProfile = agentProfile;

    // RES-1: strip all sensitive auth fields before building merged view
    const {
      password,
      refreshTokenHash,
      refreshTokenFamily,
      refreshTokenVersion,
      passwordChangedAt,
      loginAttempts,
      lockUntil,
      ...safeAgentUser
    } = agentUser.toObject();

    req.agent = {
      ...safeAgentUser,
      profile: agentProfile || null,
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = resolveAgent;
