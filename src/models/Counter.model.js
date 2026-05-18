// src/models/Counter.model.js
// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC SEQUENCE GENERATOR
//
// Provides strictly incrementing integer sequences for all account numbers,
// codes, and transaction IDs across the system.
//
// CONCURRENCY GUARANTEE:
// findOneAndUpdate with $inc is a single atomic operation at the MongoDB
// WiredTiger storage engine level. Under any level of concurrent requests,
// each caller receives a unique sequence number — no collision possible.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

const CounterSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    seq: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  },
);

// ─────────────────────────────────────────────────────────
// STATIC: getNextSequence
// Returns the NEXT integer in the sequence — guaranteed unique.
// ─────────────────────────────────────────────────────────
CounterSchema.statics.getNextSequence = async function (name) {
  if (!name || typeof name !== "string" || name.trim() === "") {
    throw new Error(
      `Counter.getNextSequence requires a valid non-empty string name. ` +
      `Received: ${JSON.stringify(name)}`,
    );
  }

  const counter = await this.findOneAndUpdate(
    {
      _id: name,
    },
    {
      $inc: {
        seq: 1,
      },
    },
    {
      returnDocument: "after",
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return counter.seq;
};

module.exports = mongoose.model("Counter", CounterSchema);
