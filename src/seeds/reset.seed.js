// src/seeds/reset.seed.js
// ⚠️  DANGER — drops all collections then re-seeds
// NEVER run in production
// Command: node src/seeds/reset.seed.js
require("dotenv").config();

const mongoose = require("mongoose");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

const run = async () => {
  if (process.env.NODE_ENV === "production") {
    console.log(`${RED}❌ BLOCKED — Cannot reset production database${RESET}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`${RED}⚠️  Dropping all collections...${RESET}`);

  const collections = await mongoose.connection.db.collections();
  for (const col of collections) {
    await col.drop().catch(() => {}); // Ignore "ns not found" errors
    console.log(`  Dropped: ${col.collectionName}`);
  }

  console.log(`${GREEN}✅ All collections dropped${RESET}`);
  await mongoose.disconnect();

  console.log("\nNow run: node src/seeds/seed.js\n");
  process.exit(0);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
