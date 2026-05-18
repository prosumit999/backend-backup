// server.js
"use strict";

const mongoose = require("mongoose");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const env = require("./src/config/env");
const logger = require("./src/utils/logger");

const start = async () => {
  // ── 1. Connect DB ──────────────────────────────────────
  await connectDB();

  // ── 2. Seed system data ────────────────────────────────
  const AppConfig = require("./src/models/AppConfig.model");
  const LedgerAccount = require("./src/models/LedgerAccount.model");
  await AppConfig.seedDefaults();
  logger.info("[Server] AppConfig defaults seeded");
  await LedgerAccount.seedSystemAccounts();
  logger.info("[Server] Ledger chart of accounts seeded");

  // ── 3. Start scheduler ─────────────────────────────────
  const { startScheduler } = require("./src/jobs/scheduler");
  startScheduler();

  // ── 4. Start HTTP server ───────────────────────────────
  const server = app.listen(env.PORT, () => {
    logger.info(`[Server] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACEFUL SHUTDOWN
  // ─────────────────────────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`[Server] ${signal} received — shutting down gracefully...`);

    // Stop accepting new connections; let in-flight requests complete
    server.close(async () => {
      logger.info("[Server] HTTP server closed.");
      try {
        await mongoose.connection.close();
        logger.info("[Server] MongoDB connection closed.");
      } catch (err) {
        logger.error(`[Server] Error closing MongoDB: ${err.message}`);
      }
      process.exit(0);
    });

    // Force exit after 10s if graceful shutdown hangs.
    // .unref() ensures the timer doesn't keep the event loop alive
    // if everything else finishes first.
    setTimeout(() => {
      logger.error("[Server] Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Synchronous throws not caught by try/catch — log and exit immediately.
  // Running with corrupted state after uncaughtException is dangerous.
  process.on("uncaughtException", (err) => {
    logger.error(`[Server] Uncaught Exception: ${err.message}\n${err.stack}`);
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? "") : "";
    logger.error(`[Server] Unhandled Rejection: ${msg}\n${stack}`);
    shutdown("unhandledRejection");
  });
};

start().catch((err) => {
  logger.error(`[Server] Startup failed: ${err.message}`);
  process.exit(1);
});

