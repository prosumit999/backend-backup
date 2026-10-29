"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Prefer Backend/.env, with support for the existing Backend/src/.env layout.
// Existing deployment environment variables keep precedence.
const rootEnv = path.resolve(__dirname, "../../.env");
const sourceEnv = path.resolve(__dirname, "../.env");
dotenv.config({ path: fs.existsSync(rootEnv) ? rootEnv : sourceEnv });
