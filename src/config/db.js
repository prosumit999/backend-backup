// src/config/db.js
"use strict";

const mongoose = require("mongoose");
const env = require("./env");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN HELPER
// ─────────────────────────────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  logger.warn(`[DB] ${signal} received — closing MongoDB connection...`);
  try {
    await mongoose.connection.close();
    logger.info("[DB] MongoDB connection closed. Process exiting.");
  } catch (err) {
    logger.error(`[DB] Error during graceful shutdown: ${err.message}`);
  } finally {
    process.exit(0);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION LIFECYCLE EVENTS
// ─────────────────────────────────────────────────────────────────────────────
mongoose.connection.on("connecting", () =>
  logger.info("[DB] Connecting to MongoDB..."),
);

mongoose.connection.on("disconnected", () =>
  logger.warn("[DB] MongoDB disconnected. Mongoose will attempt reconnect..."),
);

mongoose.connection.on("reconnected", () =>
  logger.info("[DB] MongoDB reconnected successfully."),
);

mongoose.connection.on("error", (err) => {
  logger.error(`[DB] MongoDB connection error: ${err.message}`, {
    name: err.name,
    code: err.code,
  });
  // Do NOT process.exit here — Mongoose will auto-reconnect on transient errors.
  // Only exit on auth errors (wrong credentials) — they will never self-heal.
  if (err.name === "MongoServerError" && err.code === 18) {
    logger.error(
      "[DB] Authentication failed. Check MONGO_URI credentials. Exiting.",
    );
    process.exit(1);
  }
});

mongoose.connection.on("close", () =>
  logger.info("[DB] MongoDB connection closed."),
);

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT
// ─────────────────────────────────────────────────────────────────────────────
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 8000,

      maxPoolSize: 10,

      // Heartbeat keeps replica-set primary detection fast
      heartbeatFrequencyMS: 10000,

      autoIndex: env.NODE_ENV !== "production",
    });

    logger.info(`[DB] MongoDB connected: ${conn.connection.host}`);

    process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (error) {
    logger.error(`[DB] Initial MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
