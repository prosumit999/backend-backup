// src/utils/logger.js
"use strict";

const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// LOG DIRECTORY
// ─────────────────────────────────────────────────────────────────────────────
const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const PII_PATTERNS = [
  {
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: "[AADHAAR REDACTED]",
  },
  { regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, replacement: "[PAN REDACTED]" },
  { regex: /\b[6-9]\d{9}\b/g, replacement: "[PHONE REDACTED]" },
];

const scrubPII = (value) => {
  if (typeof value !== "string") return value;
  let scrubbed = value;
  for (const { regex, replacement } of PII_PATTERNS) {
    scrubbed = scrubbed.replace(regex, replacement);
  }
  return scrubbed;
};

// Recursively scrub PII from log info objects (handles nested objects/arrays)
const scrubInfoObject = (info) => {
  if (typeof info === "string") return scrubPII(info);
  if (Array.isArray(info)) return info.map(scrubInfoObject);
  if (info && typeof info === "object") {
    const scrubbed = {};
    for (const [key, val] of Object.entries(info)) {
      scrubbed[key] = scrubInfoObject(val);
    }
    return scrubbed;
  }
  return info;
};

// Winston custom format — runs before every transport
const piiScrubFormat = format((info) => {
  // Always scrub the message string
  if (info.message) info.message = scrubPII(String(info.message));

  if (info.stack) info.stack = scrubPII(String(info.stack));

  // Scrub splat (metadata array passed as second arg to logger calls)
  if (info[Symbol.for("splat")]) {
    info[Symbol.for("splat")] = info[Symbol.for("splat")].map(scrubInfoObject);
  }

  const SKIP_KEYS = new Set(["level", "message", "stack", "service"]);
  for (const [key, val] of Object.entries(info)) {
    if (SKIP_KEYS.has(key)) continue;
    if (typeof val === "string") {
      info[key] = scrubPII(val);
    } else if (val && typeof val === "object") {
      info[key] = scrubInfoObject(val);
    }
  }

  return info;
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED FORMATS
// ─────────────────────────────────────────────────────────────────────────────
const baseFormat = format.combine(
  format.errors({ stack: true }),
  piiScrubFormat(),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
);

// FILE FORMAT — structured JSON for log aggregation tools (Datadog, CloudWatch)
const fileFormat = format.combine(baseFormat, format.json());

const consoleFormat = format.combine(
  baseFormat,
  format.colorize(),
  format.printf(({ timestamp, level, message, stack, ...metadata }) => {
    let log = `${timestamp} ${level}: ${message}`;

    if (stack) log += `\n${stack}`;

    const cleanMeta = Object.fromEntries(
      Object.entries(metadata).filter(
        ([k]) => !["service", "splat"].includes(k),
      ),
    );
    if (Object.keys(cleanMeta).length > 0) {
      log += `\n  ${JSON.stringify(cleanMeta, null, 2)}`;
    }

    return log;
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// ROTATING FILE TRANSPORT FACTORY
// 30-day retention, 20MB per file, gzip archived
// ─────────────────────────────────────────────────────────────────────────────
const rotatingFile = (level, filename) =>
  new DailyRotateFile({
    filename: `logs/${filename}-%DATE%.log`,
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxSize: "20m",
    maxFiles: "30d",
    level,
    format: fileFormat,
  });

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER INSTANCE
// ─────────────────────────────────────────────────────────────────────────────
const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",

  defaultMeta: { service: "microfinance-api" },

  transports: [
    rotatingFile("error", "error"),
    rotatingFile("info", "combined"),
  ],

  exitOnError: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLE TRANSPORT (development + test only)
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  logger.add(
    new transports.Console({
      format: consoleFormat,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIAL EVENT LOGGER
// ─────────────────────────────────────────────────────────────────────────────
logger.financial = (event, data = {}) => {
  logger.info(`[FINANCIAL] ${event}`, {
    event,
    ...data,
    businessDate: data.businessDate
      ? new Date(data.businessDate).toISOString().slice(0, 10)
      : "NOT_SET",
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL ALERT LOGGER
// ─────────────────────────────────────────────────────────────────────────────
logger.critical = (event, data = {}) => {
  logger.error(`[CRITICAL] ${event}`, {
    event,
    severity: "CRITICAL",
    ...data,
    alertAt: new Date().toISOString(),
  });
};

module.exports = logger;
