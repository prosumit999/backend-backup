// src/utils/permissions.js
"use strict";

const { PERMISSIONS, ROLES } = require("../config/constants");
const ApiError = require("./ApiError");

const hasPermission = (role, permission) => {
  if (!role || !permission) return false;
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) return false;
  return allowedRoles.includes(role);
};

const authorize =
  (...permissionKeys) =>
  (req, _res, next) => {
    const role = req.user?.role;

    if (!role) {
      return next(ApiError.unauthorized("Authentication required"));
    }

    const missing = permissionKeys.find((p) => !hasPermission(role, p));
    if (missing) {
      return next(
        ApiError.forbidden(`Access denied. Required permission: ${missing}`),
      );
    }
    next();
  };

const blockSuperadminMutations = (req, _res, next) => {
  if (
    req.user?.role === ROLES.SUPERADMIN &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
  ) {
    return next(
      ApiError.forbidden(
        "Superadmin cannot perform banking operations. Read-only access only.",
      ),
    );
  }
  next();
};

module.exports = {
  hasPermission,
  authorize,
  blockSuperadminMutations,
};
