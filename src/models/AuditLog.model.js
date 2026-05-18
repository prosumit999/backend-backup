// src/models/AuditLog.model.js
"use strict";

const mongoose = require("mongoose");

const { AUDIT_STATUS } = require("../config/constants");

const AuditLogSchema = new mongoose.Schema(
  {
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    action: {
      type: String,
      required: true,
    },
    entity: {
      type: String,
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    oldData: { type: mongoose.Schema.Types.Mixed, default: null },
    newData: { type: mongoose.Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: "unknown" },
    requestId: { type: String, default: null },
    userAgent: { type: String, default: null },

    status: {
      type: String,
      enum: Object.values(AUDIT_STATUS),
      default: AUDIT_STATUS.SUCCESS,
    },

    errorMessage: { type: String, default: null },
    businessDate: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    strict: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─── Compound indexes for admin queries ───────────────────
AuditLogSchema.index({ performedBy: 1, createdAt: -1 });
AuditLogSchema.index({ entity: 1, entityId: 1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ businessDate: 1 });

// ─── Immutability — AuditLog records cannot be modified or deleted ────────
AuditLogSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany", "replaceOne"],
  function () {
    throw new Error(
      "AuditLog records are immutable. Updates are not permitted.",
    );
  },
);

AuditLogSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany", "findOneAndRemove"],
  function () {
    throw new Error(
      "AuditLog records are immutable. Deletes are not permitted.",
    );
  },
);

AuditLogSchema.pre("bulkWrite", function () {
  throw new Error(
    "AuditLog records are immutable. bulkWrite is not permitted on AuditLog.",
  );
});

// ─── STATIC: log() — only write path ─────────────────────────────────────
// Pass { session } in options for transactional audit logging.
AuditLogSchema.statics.log = async function (data, options = {}) {
  return this.create(
    [
      {
        performedBy: data.performedBy || null,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId || null,
        oldData: data.oldData || null,
        newData: data.newData || null,
        ipAddress: data.ipAddress || "unknown",
        requestId: data.requestId || null,
        userAgent: data.userAgent || null,
        status: data.status || AUDIT_STATUS.SUCCESS,
        errorMessage: data.errorMessage || null,
        businessDate: data.businessDate || null,
      },
    ],
    options,
  );
};

module.exports = mongoose.model("AuditLog", AuditLogSchema);
