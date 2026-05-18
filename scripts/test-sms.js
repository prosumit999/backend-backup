#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// SMS TEMPLATE TEST SCRIPT
// ═══════════════════════════════════════════════════════════════════════════════
// Usage:
//   node scripts/test-sms.js <phone> [template_number|all]
//
// Examples:
//   node scripts/test-sms.js 9158286544 8       → Test T8 (Saving Withdrawal)
//   node scripts/test-sms.js 9158286544 all     → Test ALL 23 templates
//   node scripts/test-sms.js 9158286544          → Shows template list
//
// This script sends REAL SMS via MSG91. Use your own number for testing.
// ═══════════════════════════════════════════════════════════════════════════════
"use strict";

require("dotenv").config();

const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────────
const MSG91_FLOW_URL = "https://api.msg91.com/api/v5/flow/";
const AUTH_KEY = process.env.MSG91_AUTH_KEY;
const SENDER_ID = process.env.MSG91_SENDER_ID;

if (!AUTH_KEY || !SENDER_ID) {
  console.error("❌ MSG91_AUTH_KEY or MSG91_SENDER_ID not set in .env");
  process.exit(1);
}

// ─── All 23 Templates with Test Data ───────────────────────────────────────────
const TEMPLATES = [
  {
    num: 1,
    key: "OTP_VERIFICATION",
    envKey: "MSG91_TEMPLATE_OTP",
    templateId: process.env.MSG91_TEMPLATE_OTP,
    vars: ["Ritesh", "123456"],
    desc: "T1: OTP Verification — Dear {name}, OTP is {otp}",
  },
  {
    num: 2,
    key: "KYC_APPROVED",
    envKey: "MSG91_TEMPLATE_KYC_APPROVED",
    templateId: process.env.MSG91_TEMPLATE_KYC_APPROVED,
    vars: ["Ritesh"],
    desc: "T2: KYC Approved — Dear {name}, KYC verified",
  },
  {
    num: 3,
    key: "KYC_REJECTED",
    envKey: "MSG91_TEMPLATE_KYC_REJECTED",
    templateId: process.env.MSG91_TEMPLATE_KYC_REJECTED,
    vars: ["Ritesh", "Invalid photo submitted"],
    desc: "T3: KYC Rejected — Dear {name}, rejected: {reason}",
  },
  {
    num: 4,
    key: "COLLECTION_RECEIPT",
    envKey: "MSG91_TEMPLATE_COLLECTION",
    templateId: process.env.MSG91_TEMPLATE_COLLECTION,
    vars: ["Ritesh", "Rs.500 Rcpt:RCP001 Bal:5000"],
    desc: "T4: Pigmy Collection — Dear {name}, {detail}",
  },
  {
    num: 5,
    key: "SAVING_ACCOUNT_OPENED",
    envKey: "MSG91_TEMPLATE_SAVING_OPENED",
    templateId: process.env.MSG91_TEMPLATE_SAVING_OPENED,
    vars: ["Ritesh", "A/C:SAV001 Charge:Rs.100"],
    desc: "T5: Savings Opened — Dear {name}, {detail}",
  },
  {
    num: 6,
    key: "SAVING_ACCOUNT_CLOSED",
    envKey: "MSG91_TEMPLATE_SAVING_CLOSED",
    templateId: process.env.MSG91_TEMPLATE_SAVING_CLOSED,
    vars: ["Ritesh", "A/C:SAV001 Bal:Rs.5000"],
    desc: "T6: Savings Closed — Dear {name}, {detail}",
  },
  {
    num: 7,
    key: "SAVING_DEPOSIT_RECEIPT",
    envKey: "MSG91_TEMPLATE_SAVING_DEPOSIT",
    templateId: process.env.MSG91_TEMPLATE_SAVING_DEPOSIT,
    vars: ["Ritesh", "A/C:SAV001 Rs.1000 Bal:6000"],
    desc: "T7: Savings Deposit — Dear {name}, {detail}",
  },
  {
    num: 8,
    key: "SAVING_WITHDRAWAL_RECEIPT",
    envKey: "MSG91_TEMPLATE_SAVING_WITHDRAWAL",
    templateId: process.env.MSG91_TEMPLATE_SAVING_WITHDRAWAL,
    vars: ["Ritesh", "A/C:SAV001 Rs.500 Bal:5500"],
    desc: "T8: Savings Withdrawal — Dear {name}, {detail}",
  },
  {
    num: 9,
    key: "PIGMY_ACCOUNT_OPENED",
    envKey: "MSG91_TEMPLATE_PIGMY_OPENED",
    templateId: process.env.MSG91_TEMPLATE_PIGMY_OPENED,
    vars: ["Ritesh", "A/C:PIG001 Daily:Rs.50 Daily"],
    desc: "T9: Pigmy Opened — Dear {name}, {detail}",
  },
  {
    num: 10,
    key: "PIGMY_ACCOUNT_CLOSED",
    envKey: "MSG91_TEMPLATE_PIGMY_CLOSED",
    templateId: process.env.MSG91_TEMPLATE_PIGMY_CLOSED,
    vars: ["Ritesh", "A/C:PIG001 Bal:Rs.18250"],
    desc: "T10: Pigmy Closed — Dear {name}, {detail}",
  },
  {
    num: 11,
    key: "LOAN_DISBURSED",
    envKey: "MSG91_TEMPLATE_LOAN",
    templateId: process.env.MSG91_TEMPLATE_LOAN,
    vars: ["Ritesh", "A/C:LN001 Amt:Rs.50000"],
    desc: "T11: Loan Disbursed — Dear {name}, {detail}",
  },
  {
    num: 12,
    key: "LOAN_REPAYMENT",
    envKey: "MSG91_TEMPLATE_REPAYMENT",
    templateId: process.env.MSG91_TEMPLATE_REPAYMENT,
    vars: ["Ritesh", "Loan:LN001 EMI:2500 Due:47500"],
    desc: "T12: Loan Repayment — Dear {name}, {detail}",
  },
  {
    num: 13,
    key: "LOAN_CLOSED",
    envKey: "MSG91_TEMPLATE_LOAN_CLOSED",
    templateId: process.env.MSG91_TEMPLATE_LOAN_CLOSED,
    vars: ["Ritesh", "LN-2026-00001"],
    desc: "T13: Loan Closed — Dear {name}, loan {loanNo} closed",
  },
  {
    num: 14,
    key: "LOAN_WRITTEN_OFF",
    envKey: "MSG91_TEMPLATE_LOAN_WRITTEN_OFF",
    templateId: process.env.MSG91_TEMPLATE_LOAN_WRITTEN_OFF,
    vars: ["Ritesh", "LN-2026-00001"],
    desc: "T14: Loan Written Off — Dear {name}, loan {loanNo} written off",
  },
  {
    num: 15,
    key: "LOAN_REACTIVATED",
    envKey: "MSG91_TEMPLATE_LOAN_REACTIVATED",
    templateId: process.env.MSG91_TEMPLATE_LOAN_REACTIVATED,
    vars: ["Ritesh", "Loan:LN001 Status:Active"],
    desc: "T15: Loan Reactivated — Dear {name}, {detail}",
  },
  {
    num: 16,
    key: "LOAN_PAYMENT_REMINDER",
    envKey: "MSG91_TEMPLATE_LOAN_REMINDER",
    templateId: process.env.MSG91_TEMPLATE_LOAN_REMINDER,
    vars: ["Ritesh", "Loan:LN001 Due:47500 Miss:005d"],
    desc: "T16: Loan Reminder — Dear {name}, {detail}",
  },
  {
    num: 17,
    key: "PENALTY_APPLIED",
    envKey: "MSG91_TEMPLATE_PENALTY",
    templateId: process.env.MSG91_TEMPLATE_PENALTY,
    vars: ["Ritesh", "Loan:LN001 Penalty:Rs.250"],
    desc: "T17: Penalty Applied — Dear {name}, {detail}",
  },
  {
    num: 18,
    key: "MISSED_PENALTY_APPLIED",
    envKey: "MSG91_TEMPLATE_MISSED_PENALTY",
    templateId: process.env.MSG91_TEMPLATE_MISSED_PENALTY,
    vars: ["Ritesh", "Loan:LN001 Penalty:Rs.250"],
    desc: "T18: Missed Penalty — Dear {name}, {detail}",
  },
  {
    num: 19,
    key: "COLLECTION_DEFICIT_WARNING",
    envKey: "MSG91_TEMPLATE_DEFICIT_WARNING",
    templateId: process.env.MSG91_TEMPLATE_DEFICIT_WARNING,
    vars: ["Ritesh", "LN001 S:150 W:001/003 Lv:001"],
    desc: "T19: Deficit Warning — Dear {name}, {detail}",
  },
  {
    num: 20,
    key: "LIFELINE_EXHAUSTED",
    envKey: "MSG91_TEMPLATE_LIFELINE_EXHAUSTED",
    templateId: process.env.MSG91_TEMPLATE_LIFELINE_EXHAUSTED,
    vars: ["Ritesh", "Loan:LN001 Warnings:003"],
    desc: "T20: Lifeline Exhausted — Dear {name}, {detail}",
  },
  {
    num: 21,
    key: "LIFELINE_RESTORED",
    envKey: "MSG91_TEMPLATE_LIFELINE_RESTORED",
    templateId: process.env.MSG91_TEMPLATE_LIFELINE_RESTORED,
    vars: ["Ritesh", "Loan:LN001 Lives:003"],
    desc: "T21: Lifeline Restored — Dear {name}, {detail}",
  },
  {
    num: 22,
    key: "LIFELINE_ADMIN_ADJUSTED",
    envKey: "MSG91_TEMPLATE_LIFELINE_ADJUSTED",
    templateId: process.env.MSG91_TEMPLATE_LIFELINE_ADJUSTED,
    vars: ["Ritesh", "Loan:LN001 Lives:002"],
    desc: "T22: Lifeline Adjusted — Dear {name}, {detail}",
  },
  {
    num: 23,
    key: "INTERNAL_TRANSFER",
    envKey: "MSG91_TEMPLATE_INTERNAL_TRANSFER",
    templateId: process.env.MSG91_TEMPLATE_INTERNAL_TRANSFER,
    vars: ["Ritesh", "Rs.1000 SAV001->PIG001 16May"],
    desc: "T23: Internal Transfer — Dear {name}, {detail}",
  },
];

// ─── Send SMS Function (direct MSG91 call, no service wrapper) ─────────────────
async function sendTestSms(phone, templateId, variables, label) {
  // Use "name" for first var, "details" for second — matches ##name## / ##details## in MSG91 templates
  var MSG91_KEYS = ["name", "details"];
  var recipientObj = { mobiles: "91" + phone };
  for (var i = 0; i < variables.length; i++) {
    var key = MSG91_KEYS[i] || ("var" + (i + 1));
    recipientObj[key] = String(variables[i]);
  }

  var payload = {
    template_id: templateId,
    short_url: "0",
    recipients: [recipientObj],
  };

  console.log("\n" + "═".repeat(70));
  console.log("📤 SENDING: " + label);
  console.log("   Template ID: " + templateId);
  console.log("   Phone: 91" + phone);
  console.log("   Variables: " + JSON.stringify(variables));
  console.log("   Full Payload:");
  console.log("   " + JSON.stringify(payload, null, 2).split("\n").join("\n   "));
  console.log("─".repeat(70));

  try {
    var response = await axios.post(MSG91_FLOW_URL, payload, {
      headers: {
        authkey: AUTH_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      timeout: 10000,
    });

    console.log("   ✅ Response: " + JSON.stringify(response.data));

    if (response.data && response.data.type === "success") {
      return { success: true, requestId: response.data.message };
    } else {
      return { success: false, error: JSON.stringify(response.data) };
    }
  } catch (err) {
    var errData = err.response ? JSON.stringify(err.response.data) : err.message;
    console.log("   ❌ ERROR: " + errData);
    return { success: false, error: errData };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  var phone = process.argv[2];
  var templateArg = process.argv[3];

  if (!phone || phone.length < 10) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║           SMS TEMPLATE TEST SCRIPT — Usage                  ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║                                                            ║");
    console.log("║  node scripts/test-sms.js <phone> [num|all]                ║");
    console.log("║                                                            ║");
    console.log("║  Examples:                                                 ║");
    console.log("║    node scripts/test-sms.js 9158286544 8                   ║");
    console.log("║    node scripts/test-sms.js 9158286544 all                 ║");
    console.log("║                                                            ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("\nAvailable Templates:");
    console.log("─".repeat(70));
    for (var t of TEMPLATES) {
      var id = t.templateId || "❌ NOT SET";
      console.log("  " + String(t.num).padStart(2) + ". " + t.desc);
      console.log("      ENV: " + t.envKey + "=" + id);
    }
    console.log("─".repeat(70));
    process.exit(0);
  }

  // Normalize phone
  if (phone.startsWith("+91")) phone = phone.slice(3);
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║           SMS TEMPLATE TEST — MSG91 Flow API v5             ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  Auth Key: " + AUTH_KEY.slice(0, 8) + "..." + " ".repeat(38) + "║");
  console.log("║  Sender:   " + SENDER_ID + " ".repeat(Math.max(0, 44 - SENDER_ID.length)) + "║");
  console.log("║  Phone:    91" + phone + " ".repeat(Math.max(0, 42 - phone.length)) + "║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  var templatesToTest = [];

  if (!templateArg) {
    console.log("\nNo template specified. Use a number (1-23) or 'all'.");
    console.log("Run without args to see template list.\n");
    process.exit(0);
  }

  if (templateArg === "all") {
    templatesToTest = TEMPLATES;
  } else {
    var num = parseInt(templateArg, 10);
    var found = TEMPLATES.find(function (t) { return t.num === num; });
    if (!found) {
      console.error("❌ Template #" + templateArg + " not found. Use 1-23.");
      process.exit(1);
    }
    templatesToTest = [found];
  }

  var results = [];

  for (var tmpl of templatesToTest) {
    if (!tmpl.templateId) {
      console.log("\n⚠️  SKIPPING T" + tmpl.num + " (" + tmpl.key + ") — template ID not set in .env");
      results.push({ num: tmpl.num, key: tmpl.key, status: "SKIPPED", reason: "no_template_id" });
      continue;
    }

    var result = await sendTestSms(phone, tmpl.templateId, tmpl.vars, tmpl.desc);
    results.push({ num: tmpl.num, key: tmpl.key, status: result.success ? "OK" : "FAIL", detail: result });

    // Delay between sends to avoid rate limiting
    if (templatesToTest.length > 1) {
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
  }

  // Summary
  console.log("\n\n" + "═".repeat(70));
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(70));
  for (var r of results) {
    var icon = r.status === "OK" ? "✅" : r.status === "SKIPPED" ? "⚠️ " : "❌";
    console.log("  " + icon + " T" + String(r.num).padStart(2) + " " + r.key + " → " + r.status);
  }
  console.log("═".repeat(70));
  console.log("Done. Check your phone for received SMS.");
  console.log("If variables are empty, the variable KEY NAMES need to be changed.\n");
}

main().catch(function (err) {
  console.error("Fatal:", err);
  process.exit(1);
});
