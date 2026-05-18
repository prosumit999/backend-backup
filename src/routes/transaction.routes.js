"use strict";

const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const { listTransactions, getTransaction } = require("../controllers/transaction.controller");

// All routes require authentication
router.use(authenticate);

// GET /api/v1/transactions?fromDate=&toDate=&type=&customerId=&status=&page=&limit=
router.get("/", authorize("VIEW_TRANSACTIONS"), listTransactions);

// GET /api/v1/transactions/:txnId  (accepts ObjectId OR TXN-2026-00001 string)
router.get("/:txnId", authorize("VIEW_TRANSACTIONS"), getTransaction);

module.exports = router;
