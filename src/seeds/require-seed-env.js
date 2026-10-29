"use strict";

// Validate before connecting to MongoDB or changing any seed data.
module.exports = function requireSeedEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing required seed environment variables: ${missing.join(", ")}. Set them in .env before running this script.`);
  }
};
