// src/seeds/seed.js
// ─────────────────────────────────────────────────────────
// Master seed — run once before first Postman test
// Command: node src/seeds/seed.js
// ─────────────────────────────────────────────────────────
require("../config/load-env");

const requireSeedEnv = require("./require-seed-env");

const mongoose = require("mongoose");
const User = require("../models/User.model");
const AppConfig = require("../models/AppConfig.model");
const Institution = require("../models/Institution.model");
const LedgerAccount = require("../models/LedgerAccount.model");
const LoanPlan = require("../models/LoanPlan.model");
const Counter = require("../models/Counter.model");
const { ROLES, CONFIG_KEYS } = require("../config/constants");

// ── Terminal colors (no extra package needed) ─────────────
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const log = (msg) => console.log(`${GREEN}✅ ${msg}${RESET}`);
const warn = (msg) => console.log(`${YELLOW}⚠️  ${msg}${RESET}`);
const err = (msg) => console.log(`${RED}❌ ${msg}${RESET}`);
const info = (msg) => console.log(`${CYAN}ℹ️  ${msg}${RESET}`);

// ─────────────────────────────────────────────────────────
// 1. DEV USER (software vendor account)
// ─────────────────────────────────────────────────────────
const seedDevUser = async () => {
  info("Seeding dev user...");

  const DEV_PHONE = process.env.DEV_USER_PHONE;
  const DEV_PASSWORD = process.env.DEV_USER_PASSWORD;
  const DEV_CODE = process.env.DEV_USER_CODE || "DEV-0001";

  const existing = await User.findOne({ phone: DEV_PHONE });
  if (existing) {
    warn("Dev user already exists — skipping");
    return existing;
  }

  const devUser = await User.create({
    name: "Software Developer",
    phone: DEV_PHONE,
    password: DEV_PASSWORD,
    role: ROLES.DEV,
    devCode: DEV_CODE,
    isActive: true,
  });

  log("Dev user created using credentials from the environment");
  return devUser;
};

// ─────────────────────────────────────────────────────────
// 2. SUPERADMIN
// ─────────────────────────────────────────────────────────
const seedSuperAdmin = async () => {
  info("Seeding superadmin...");

  const existing = await User.findOne({ phone: process.env.ADMIN_Phone });
  if (existing) {
    warn("Superadmin already exists — skipping");
    return existing;
  }

  const admin = await User.create({
    name: process.env.ADMIN_Name,
    phone: process.env.ADMIN_Phone,
    password: process.env.ADMIN_PASS,  
    role: ROLES.SUPERADMIN || "superadmin",
    isActive: true,
    agentCode: null,
  });

  log("Superadmin created using credentials from the environment");
  return admin;
};

// ─────────────────────────────────────────────────────────
// 3. APP CONFIG (system settings)
// ─────────────────────────────────────────────────────────
const seedAppConfig = async () => {
  info("Seeding AppConfig defaults...");
  const result = await AppConfig.seedDefaults();
  log(`AppConfig seeded — ${result.seeded} config keys processed`);
};

// ─────────────────────────────────────────────────────────
// 4. INSTITUTION SINGLETON (genesis date + placeholder branding)
// ─────────────────────────────────────────────────────────
const seedInstitution = async (devUserId) => {
  info("Seeding Institution singleton...");

  const existing = await Institution.findOne({ singleton: "MASTER" }).lean();
  if (existing && existing.isConfigured) {
    warn("Institution already configured — skipping genesis date update");
    return existing;
  }

  // Set genesis date to today (dev user must configure the exact date from the
  // Dev Panel after first login, or override DEV_GENESIS_DATE in .env).
  const genesisDate = process.env.DEV_GENESIS_DATE
    ? new Date(process.env.DEV_GENESIS_DATE)
    : new Date();

  const institution = await Institution.updateConfig(
    {
      name: process.env.INSTITUTION_NAME || "Abhishek Finance",
      shortName: process.env.INSTITUTION_SHORT_NAME || "AMF",
      systemGenesisDate: genesisDate,
    },
    devUserId,
  );

  log(
    `Institution seeded | Name: ${institution.name} | ` +
    `Genesis: ${genesisDate.toLocaleDateString("en-IN")}`,
  );
  return institution;
};

// ─────────────────────────────────────────────────────────
// 3. LEDGER ACCOUNTS (chart of accounts)
// ─────────────────────────────────────────────────────────
const seedLedgerAccounts = async () => {
  info("Seeding LedgerAccount chart of accounts...");
  await LedgerAccount.seedSystemAccounts();
  log("LedgerAccounts seeded — system accounts ready");
};

// ─────────────────────────────────────────────────────────
// 4. LOAN PLANS
// ─────────────────────────────────────────────────────────
const seedLoanPlans = async (adminId) => {
  info("Seeding LoanPlans...");

  const [defaultInterestRateBps, defaultProcessingFeeBps] = await Promise.all([
    AppConfig.getValue(CONFIG_KEYS.DEFAULT_INTEREST_RATE_BPS),
    AppConfig.getValue(CONFIG_KEYS.PROCESSING_FEE_BPS),
  ]);

  const plans = [
    {
      planCode: "LP-3M",
      planName: "3 Month Plan",
      description: "Short-term loan plan for 3 months",
      durationMonths: 3,
      baseInterestRateBps: defaultInterestRateBps,
      processingFeeBps: defaultProcessingFeeBps,
      minLoanAmountInPaise: 100000,
      maxLoanAmountInPaise: 5000000,
      isActive: true,
      createdBy: adminId,
    },
    {
      planCode: "LP-6M",
      planName: "6 Month Plan",
      description: "Standard loan plan for 6 months",
      durationMonths: 6,
      baseInterestRateBps: defaultInterestRateBps,
      processingFeeBps: defaultProcessingFeeBps,
      minLoanAmountInPaise: 100000,
      maxLoanAmountInPaise: 7500000,
      isActive: true,
      createdBy: adminId,
    },
    {
      planCode: "LP-12M",
      planName: "12 Month Plan",
      description: "Longer-duration loan plan for 12 months",
      durationMonths: 12,
      baseInterestRateBps: defaultInterestRateBps,
      processingFeeBps: defaultProcessingFeeBps,
      minLoanAmountInPaise: 100000,
      maxLoanAmountInPaise: 10000000,
      isActive: true,
      createdBy: adminId,
    },
  ];

  let created = 0;
  let skipped = 0;

  for (const plan of plans) {
    const existing = await LoanPlan.findOne({
      planCode: plan.planCode,
      isDeleted: false,
    }).lean();

    if (existing) {
      skipped++;
      continue;
    }

    await LoanPlan.create(plan);
    created++;
  }

  log(`LoanPlans → Created: ${created} | Skipped (already exist): ${skipped}`);
};

// ─────────────────────────────────────────────────────────
// 5. COUNTERS (auto-increment sequences)
// ─────────────────────────────────────────────────────────
const seedCounters = async () => {
  info("Seeding Counters...");

  const counters = [
    "agentCode",
    "customerCode",
    "accountNumber",
    "loanAccountNumber",
    "receiptNumber",
    "transactionId",
  ];

  let created = 0;
  let skipped = 0;

  for (const name of counters) {
    const existing = await Counter.findById(name).lean();
    if (existing) {
      skipped++;
      continue;
    }
    await Counter.create({ _id: name, seq: 0 });
    created++;
  }

  log(`Counters → Created: ${created} | Skipped: ${skipped}`);
};

// ─────────────────────────────────────────────────────────
// MASTER RUNNER
// ─────────────────────────────────────────────────────────
const run = async () => {
  console.log("\n" + "═".repeat(55));
  console.log(`${CYAN}  🌱 PIGMY FINANCE — DATABASE SEED${RESET}`);
  console.log("═".repeat(55) + "\n");

  try {
    requireSeedEnv(["MONGO_URI", "DEV_USER_PHONE", "DEV_USER_PASSWORD", "ADMIN_Name", "ADMIN_Phone", "ADMIN_PASS"]);
    info("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    log(`MongoDB connected: ${mongoose.connection.host}`);
    console.log("");

    await seedCounters();
    console.log("");

    await seedAppConfig();
    console.log("");

    await seedLedgerAccounts();
    console.log("");

    // Dev user must be seeded before Institution (Institution references devUserId)
    const devUser = await seedDevUser();
    console.log("");

    await seedInstitution(devUser._id);
    console.log("");

    const admin = await seedSuperAdmin();
    console.log("");

    await seedLoanPlans(admin._id);
    console.log("");

    console.log("═".repeat(55));
    console.log(
      `${GREEN}  🎉 SEED COMPLETE — Ready for Postman testing!${RESET}`,
    );
    console.log("═".repeat(55));
    console.log("");
    info("Login with the credentials configured in your environment.");
    console.log(`  ${CYAN}POST /api/v1/auth/login${RESET}`);
    console.log("");
  } catch (error) {
    err(`Seed failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    info("MongoDB disconnected");
    process.exit(0);
  }
};

run();
