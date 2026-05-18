// src/seeds/create-dev-user.js
// ─────────────────────────────────────────────────────────
// Standalone script — creates (or resets) the Dev Panel user.
//
// Usage:
//   node src/seeds/create-dev-user.js           → create if not exists
//   node src/seeds/create-dev-user.js --reset   → delete & recreate
//
// Credentials are read from .env:
//   DEV_USER_PHONE    = 9000000000
//   DEV_USER_PASSWORD = Dev@Vendor#2024
//   DEV_USER_CODE     = DEV-0001
// ─────────────────────────────────────────────────────────
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User.model");
const { ROLES } = require("../config/constants");

// ── Terminal colors ───────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

const log  = (msg) => console.log(`${GREEN}✅ ${msg}${RESET}`);
const warn = (msg) => console.log(`${YELLOW}⚠️  ${msg}${RESET}`);
const err  = (msg) => console.log(`${RED}❌ ${msg}${RESET}`);
const info = (msg) => console.log(`${CYAN}ℹ️  ${msg}${RESET}`);

// ── Read credentials from .env ────────────────────────────
const DEV_PHONE    = process.env.DEV_USER_PHONE    || "9000000000";
const DEV_PASSWORD = process.env.DEV_USER_PASSWORD || "Dev@Vendor#2024";
const DEV_CODE     = process.env.DEV_USER_CODE     || "DEV-0001";

const isReset = process.argv.includes("--reset");

// ─────────────────────────────────────────────────────────
const run = async () => {
  console.log("\n" + "═".repeat(55));
  console.log(`${CYAN}${BOLD}  👤 DEV USER CREATION — PIGMY FINANCE${RESET}`);
  console.log("═".repeat(55));
  console.log(`${CYAN}  Mode   :${RESET} ${isReset ? RED + "RESET (existing user will be deleted)" + RESET : "CREATE (skip if already exists)"}`);
  console.log(`${CYAN}  Phone  :${RESET} ${DEV_PHONE}`);
  console.log(`${CYAN}  Code   :${RESET} ${DEV_CODE}`);
  console.log("═".repeat(55) + "\n");

  if (!process.env.MONGO_URI) {
    err("MONGO_URI is not set in .env — aborting.");
    process.exit(1);
  }

  info("Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  log(`MongoDB connected: ${mongoose.connection.host}`);
  console.log("");

  // ── Reset mode: delete existing dev user ─────────────────
  if (isReset) {
    const deleted = await User.findOneAndDelete({ phone: DEV_PHONE });
    if (deleted) {
      warn(`Existing dev user deleted (Phone: ${DEV_PHONE})`);
    } else {
      info("No existing dev user found — will create fresh.");
    }
    console.log("");
  }

  // ── Check for existing user ───────────────────────────────
  const existing = await User.findOne({ phone: DEV_PHONE }).lean();
  if (existing) {
    warn(`Dev user already exists (Phone: ${DEV_PHONE}) — skipping.`);
    warn("Run with --reset flag to recreate: npm run create-dev -- --reset");
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Create dev user ───────────────────────────────────────
  await User.create({
    name: "Software Developer",
    phone: DEV_PHONE,
    password: DEV_PASSWORD,
    role: ROLES.DEV,
    devCode: DEV_CODE,
    isActive: true,
  });

  console.log("═".repeat(55));
  console.log(`${GREEN}${BOLD}  🎉 DEV USER CREATED SUCCESSFULLY!${RESET}`);
  console.log("═".repeat(55));
  console.log("");
  console.log(`  ${CYAN}Dev Panel Login Credentials:${RESET}`);
  console.log(`  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Phone    → ${DEV_PHONE.padEnd(28)}│`);
  console.log(`  │  Password → ${DEV_PASSWORD.padEnd(28)}│`);
  console.log(`  │  Code     → ${DEV_CODE.padEnd(28)}│`);
  console.log(`  │  Role     → dev                         │`);
  console.log(`  └─────────────────────────────────────────┘`);
  console.log("");
  console.log(`  ${CYAN}Login endpoint:${RESET} POST /api/v1/auth/login`);
  console.log(`  ${YELLOW}⚠️  Change the password after first login in production!${RESET}`);
  console.log("");
};

run()
  .catch((e) => {
    err(`Script failed: ${e.message}`);
    console.error(e);
    process.exit(1);
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
