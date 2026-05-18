// src/models/IdempotencyKey.model.js
"use strict";

const mongoose = require("mongoose");

const IDEMPOTENCY_STATUS = Object.freeze({
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
});

const idempotencyKeySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "userId is required for idempotency scoping"],
    },
    status: {
      type: String,
      enum: Object.values(IDEMPOTENCY_STATUS),
      default: IDEMPOTENCY_STATUS.PROCESSING,
    },
    statusCode: {
      type: Number,
      default: null,
    },
    responseData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      expires: 86400,
    },
  },
  {
    timestamps: true,
    strict: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });

const IdempotencyKey = mongoose.model("IdempotencyKey", idempotencyKeySchema);

module.exports = IdempotencyKey;
module.exports.IDEMPOTENCY_STATUS = IDEMPOTENCY_STATUS;
