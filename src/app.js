// src/app.js
"use strict";

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");
const morgan = require("morgan");
const mongoose = require("mongoose");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const logger = require("./utils/logger");
const ApiError = require("./utils/ApiError");
const routes = require("./routes/index");

const app = express();

// ─── 0. Trust Proxy (REQUIRED for Nginx reverse proxy) ────
// Without this, req.ip returns 127.0.0.1 (Nginx loopback) instead of the
// real client IP. This breaks rate limiting, audit logs, and account lockout.
// Set to 1 = trust the first proxy hop (Nginx). Never set to true (trusts all).
if (env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ─── 1. Request ID ────────────────────────────────────────
app.use((req, res, next) => {
  req.id = uuidv4();
  res.set("X-Request-ID", req.id);
  next();
});

// ─── 2. Security Headers (Banking-Grade) ─────────────────
app.use(
  helmet({
    // HSTS — force HTTPS for 1 year, include subdomains, preload eligible
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    // CSP — Content Security Policy (prevents XSS, data injection on PII forms)
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // required for inline styles (Tailwind)
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"], // prevents clickjacking (replaces X-Frame-Options)
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Prevent MIME-type sniffing attacks
    crossOriginEmbedderPolicy: false, // disabled — breaks Cloudinary image loads
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// Permissions-Policy — restrict browser APIs (banking standard: minimize attack surface)
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  next();
});

// ─── 3. CORS ──────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server / Postman (no Origin header)
      if (!origin) return callback(null, true);

      const allowed = env.ALLOWED_ORIGINS; // string[] from env.js
      if (
        (Array.isArray(allowed) && allowed.includes(origin)) ||
        allowed === "*"
      ) {
        return callback(null, true);
      }

      logger.warn(`[CORS] Blocked origin: ${origin}`);
      callback(
        new ApiError(403, `CORS blocked: Origin '${origin}' is not allowed.`),
      );
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Client-Type", "x-client-type", "idempotency-key"],
    credentials: true,
  }),
);

// ─── 4. Body Parsing ──────────────────────────────────────
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

// ─── 5. NoSQL Injection Prevention ───────────────────────
app.use(mongoSanitize());

// ─── 6. Request Logging ───────────────────────────────────
// Minimal format — avoid logging query strings that may contain PII.
app.use(
  morgan(":method :url :status :response-time ms - :res[content-length]", {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }),
);

// ─── 7. Rate Limiting ─────────────────────────────────────
const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(
      `[RateLimit] Global limit hit | IP: ${req.ip} | ReqID: ${req.id}`,
    );
    res.status(429).json({
      success: false,
      requestId: req.id,
      message: "Too many requests. Please slow down and try again later.",
    });
  },
});


const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(
      `[RateLimit] Auth limit hit | IP: ${req.ip} | ReqID: ${req.id}`,
    );
    res.status(429).json({
      success: false,
      requestId: req.id,
      message: "Too many attempts. Please try again after 15 minutes.",
    });
  },
});

app.use("/api", limiter);
app.use("/api/v1/auth/login", authLimiter);
app.use("/api/v1/auth/refresh", authLimiter);

// ─── 8. System Lock ───────────────────────────────────────
// Applied per-router AFTER authenticate so req.user is populated.
// See routes/index.js — each router applies: authenticate → systemLock → handler.
// Auth routes are excluded inside the auth router itself.

// ─── Health Check ─────────────────────────────────────────
app.get("/health", (req, res) => {
  const dbStateCode = mongoose.connection.readyState;
  const dbStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  const dbStatus = dbStateMap[dbStateCode] || "unknown";
  const isHealthy = dbStateCode === 1;

  return res.status(isHealthy ? 200 : 503).json({
    statusCode: isHealthy ? 200 : 503,
    success: isHealthy,
    message: isHealthy
      ? "Server is healthy."
      : "Server is degraded — DB not connected.",
    data: {
      db: dbStatus,
      uptime: `${Math.floor(process.uptime())}s`,
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      requestId: req.id,
    },
  });
});

// ─── API Routes ───────────────────────────────────────────
app.use("/api/v1", routes);

// ─── 404 Handler ──────────────────────────────────────────
app.use((req, res) => {
  logger.warn(`[404] ${req.method} ${req.originalUrl} | ReqID: ${req.id}`);
  res.status(404).json({
    success: false,
    requestId: req.id,
    message: `Route [${req.method}] ${req.originalUrl} not found.`,
  });
});

// ─── Global Error Handler ─────────────────────────────────
// Must be last — Express identifies 4-arg middleware as error handler.
// Order of checks matters — most specific first, catch-all last.
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  // Always log internally — stack only in non-production
  logger.error({
    requestId: req.id,
    status: statusCode,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?._id || "unauthenticated",
    message: err.message,
    stack: env.NODE_ENV !== "production" ? err.stack : undefined,
  });

  // Must be BEFORE ApiError check (MulterError is not ApiError)
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? "File too large. Maximum allowed size exceeded."
        : `File upload error: ${err.message}`;
    return res.status(400).json({
      success: false,
      requestId: req.id,
      message: msg,
    });
  }

  // ── ApiError — all operational errors thrown by services/middleware ──
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      requestId: req.id,
      message: err.message,
      errors: err.errors || undefined,
    });
  }

  // Returns { field, message } objects — same shape as Joi validate.js
  if (err.name === "ValidationError") {
    const errors = err.errors
      ? Object.values(err.errors).map((e) => ({
        field: e.path,
        message: e.message,
      }))
      : [{ field: "unknown", message: err.message }];
    return res.status(422).json({
      success: false,
      requestId: req.id,
      message: "Validation failed.",
      errors,
    });
  }

  // ── MongoDB duplicate key ──────────────────────────────
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    return res.status(409).json({
      success: false,
      requestId: req.id,
      message: `Duplicate value for '${field}'. Please use a different value.`,
    });
  }

  // ── Mongoose CastError (invalid ObjectId / wrong type) ──
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      requestId: req.id,
      message: `Invalid value for '${err.path}': '${err.value}'.`,
    });
  }

  // ── JWT errors ────────────────────────────────────────
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      requestId: req.id,
      message: "Invalid token. Please log in again.",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      requestId: req.id,
      message: "Token expired. Please log in again.",
    });
  }

  // ── Immutable record guard (model pre-save hooks) ─────
  if (err.message?.includes("immutable")) {
    return res.status(403).json({
      success: false,
      requestId: req.id,
      message: "This record is immutable. Create a reversal entry instead.",
    });
  }

  // ── Unhandled / programmer error ──────────────────────
  // Never expose internals in production
  return res.status(500).json({
    success: false,
    requestId: req.id,
    message:
      env.NODE_ENV === "production"
        ? "Internal server error. Please contact support."
        : err.message,
  });
});

module.exports = app;
