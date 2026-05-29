// src/utils/sms.service.js
"use strict";

const axios = require("axios");
const logger = require("./logger");

// ─── Constants ────────────────────────────────────────────────────────────────
const MSG91_FLOW_URL = "https://api.msg91.com/api/v5/flow/";
const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";
const SMS_PROVIDER_TIMEOUT_MS = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const maskPhone = (phone) => {
  const s = String(phone ?? "");
  if (s.length < 4) return "****";
  return "****" + s.slice(-4);
};

const normalizePhone = (phone) => {
  const s = String(phone ?? "").trim();
  if (s.startsWith("+91")) return s.slice(3);
  if (s.length === 12 && s.startsWith("91")) return s.slice(2);
  return s;
};

// ─── DLT Variable Compliance ──────────────────────────────────────────────────
// TRAI Rule: Variable values must be 3–30 characters.
// pad3() pads short numbers: pad3(1)="001", pad3(50)="050"
// Also truncates to 30 chars max.
const pad3 = (val) => String(val ?? "000").padStart(3, "0").slice(0, 30);

const resolveSmsFooter = async () => {
  try {
    const Institution = require("../models/Institution.model");
    const institution = await Institution.getInstance();
    if (institution) {
      return String(institution.smsFooter || institution.shortName || institution.name || "ABHISHEK FINANCE");
    }
  } catch (err) {
    logger.warn(
      "[SMS] Institution fetch failed (footer): " + err.message + ". Using fallback."
    );
  }
  return process.env.SMS_FOOTER_FALLBACK || "ABHISHEK FINANCE";
};

const isGlobalSmsEnabled = async () => {
  try {
    const AppConfig = require("../models/AppConfig.model");
    const { CONFIG_KEYS } = require("../config/constants");
    const val = await AppConfig.getValue(CONFIG_KEYS.SMS_ENABLED_GLOBAL);
    return val !== false;
  } catch (err) {
    logger.warn("[SMS] AppConfig read failed: " + err.message + ". Defaulting to enabled.");
    return true;
  }
};

const isPhoneOptedOut = async (phone) => {
  try {
    const Customer = require("../models/Customer.model");
    const User = require("../models/User.model");
    const [customer, user] = await Promise.all([
      Customer.findOne({ phone }).select("smsEnabled").lean(),
      User.findOne({ phone }).select("smsEnabled").lean(),
    ]);
    if (customer && customer.smsEnabled === false) return { optedOut: true, reason: "customer_opted_out" };
    if (user && user.smsEnabled === false) return { optedOut: true, reason: "user_opted_out" };
  } catch (err) {
    logger.warn("[SMS] Opt-out DB check failed for " + maskPhone(phone) + ": " + err.message + ". Proceeding.");
  }
  return { optedOut: false };
};

// ─── DLT Templates ────────────────────────────────────────────────────────────
// ─── DLT Templates (TRAI Compliant — Max 2 Variables) ─────────────────────────
// DLT COMPLIANCE (Jio TrueConnect — SANDHYA SOFTTECH PRIVATE LIMITED):
//   - Entity ID: 1201177632719072846
//   - Header/Sender: SAFIN (Active, Permanent)
//   - Template Type: Service Inferred (NOT Transactional)
//   - Brand name "ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED" is
//     STATIC TEXT at end of every DLT template — NOT a variable.
//   - TRAI Rule: Max 2 {#var#} per template. Multiple fields merged into VAR2.
//   - TRAI Rule: Variable values must be 3–30 characters.
//   - variableCount = caller-supplied args only (brand name NOT counted)
//   - build() = human-readable string for mock logs only — NOT sent to MSG91
//   - MSG91 receives VAR1, VAR2 mapped to {#var#} positions in DLT template
const SMS_TEMPLATES = {

  // T1 — DLT: Dear {#var#}, your OTP for KYC verification is {#var#}. Valid for 10 minutes. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  OTP_VERIFICATION: {
    dltTemplateId: process.env.MSG91_TEMPLATE_OTP,
    variableCount: 2, // [name, otp]
    build: function (name, otp, brand) {
      return "Dear " + name + ", your OTP for KYC verification is " + otp + ". Valid for 10 minutes. - " + brand;
    },
  },

  // T2 — DLT: Dear {#var#}, your KYC has been verified. You can now open a savings account. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  KYC_APPROVED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_KYC_APPROVED,
    variableCount: 1, // [name]
    build: function (name, brand) {
      return "Dear " + name + ", your KYC has been verified. You can now open a savings account. - " + brand;
    },
  },

  // T3 — DLT: Dear {#var#}, your KYC was rejected. Reason: {#var#}. Please resubmit documents. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  KYC_REJECTED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_KYC_REJECTED,
    variableCount: 2, // [name, reason]
    build: function (name, reason, brand) {
      return "Dear " + name + ", your KYC was rejected. Reason: " + reason + ". Please resubmit documents. - " + brand;
    },
  },

  // T4 — DLT: Dear {#var#}, Your  Pigmy Collection Received. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Amout Rs.{amount} On {date}. Rcpt:{receipt}. Bal:Rs.{balance}"
  COLLECTION_RECEIPT: {
    dltTemplateId: process.env.MSG91_TEMPLATE_COLLECTION,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ",Your Pigmy Collection Received. " + detail + ". - " + brand;
    },
  },

  // T5 — DLT: Dear {#var#}, savings A/C opened. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber}. Charge:Rs.{openingCharge}"
  SAVING_ACCOUNT_OPENED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_SAVING_OPENED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", savings A/C opened. " + detail + ". - " + brand;
    },
  },

  // T6 — DLT: Dear {#var#}, your savings A/C has been closed. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber}. Bal returned:Rs.{balanceReturned}"
  SAVING_ACCOUNT_CLOSED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_SAVING_CLOSED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your savings A/C has been closed. " + detail + ". - " + brand;
    },
  },

  // T7 — DLT: Dear {#var#}, your savings A/C credited. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber} Rs.{amount} on {date}. Bal:Rs.{balance}"
  SAVING_DEPOSIT_RECEIPT: {
    dltTemplateId: process.env.MSG91_TEMPLATE_SAVING_DEPOSIT,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your savings A/C credited. " + detail + ". - " + brand;
    },
  },

  // T8 — DLT: Dear {#var#}, your savings A/C debited. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber} Rs.{amount} on {date}. Bal:Rs.{balance}"
  SAVING_WITHDRAWAL_RECEIPT: {
    dltTemplateId: process.env.MSG91_TEMPLATE_SAVING_WITHDRAWAL,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your savings A/C debited. " + detail + ". - " + brand;
    },
  },

  // T9 — DLT: Dear {#var#}, pigmy A/C opened. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber}. Daily:Rs.{dailyDeposit}. Freq:{frequency}"
  PIGMY_ACCOUNT_OPENED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_PIGMY_OPENED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", pigmy A/C opened. " + detail + ". - " + brand;
    },
  },

  // T10 — DLT: Dear {#var#}, your pigmy A/C has been closed. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "A/C:{accountNumber}. Bal returned:Rs.{balanceReturned}"
  PIGMY_ACCOUNT_CLOSED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_PIGMY_CLOSED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your pigmy A/C has been closed. " + detail + ". - " + brand;
    },
  },

  // T11 — DLT: Dear {#var#}, your loan has been disbursed. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan A/C:{loanNo}. Amount:Rs.{amount}"
  LOAN_DISBURSED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LOAN,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your loan has been disbursed. " + detail + ". - " + brand;
    },
  },

  // T12 — DLT: Dear {#var#}, loan EMI received. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. EMI:Rs.{amount}. Outstanding:Rs.{outstanding}"
  LOAN_REPAYMENT: {
    dltTemplateId: process.env.MSG91_TEMPLATE_REPAYMENT,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", loan EMI received. " + detail + ". - " + brand;
    },
  },

  // T13 — DLT: Dear {#var#}, your loan A/C {#var#} has been closed successfully. Thank you. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  LOAN_CLOSED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LOAN_CLOSED,
    variableCount: 2, // [name, loanNo]
    build: function (name, loanNo, brand) {
      return "Dear " + name + ", your loan A/C " + loanNo + " has been closed successfully. Thank you. - " + brand;
    },
  },

  // T14 — DLT: Dear {#var#}, your loan A/C {#var#} has been written off. Contact office for details. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  LOAN_WRITTEN_OFF: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LOAN_WRITTEN_OFF,
    variableCount: 2, // [name, loanNo]
    build: function (name, loanNo, brand) {
      return "Dear " + name + ", your loan A/C " + loanNo + " has been written off. Contact office for details. - " + brand;
    },
  },

  // T15 — DLT: Dear {#var#}, your loan A/C has been reactivated. {#var#}. Please resume payments. Contact office.
  // - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo} Status:{status}"
  LOAN_REACTIVATED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LOAN_REACTIVATED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your loan A/C has been reactivated. " + detail + ". - " + brand;
    },
  },

  // T16 — DLT: Dear {#var#}, loan payment pending. {#var#}. Please pay to avoid penalty. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Due:Rs.{outstanding}. Missed:{pad3(missedDays)} days"
  LOAN_PAYMENT_REMINDER: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LOAN_REMINDER,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", loan payment pending. " + detail + ". Please pay to avoid penalty. - " + brand;
    },
  },

  // T17 — DLT: Dear {#var#}, penalty applied on your loan. {#var#}. Contact office. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Penalty:Rs.{amount} due to overdue"
  PENALTY_APPLIED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_PENALTY,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", penalty applied on your loan. " + detail + ". Contact office. - " + brand;
    },
  },

  // T18 — DLT: Dear {#var#}, missed-collection penalty charged. {#var#}. Contact office. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Penalty:Rs.{amount}"
  MISSED_PENALTY_APPLIED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_MISSED_PENALTY,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", missed-collection penalty charged. " + detail + ". Contact office. - " + brand;
    },
  },

  // T19 — DLT: Dear {#var#}, pigmy collection deficit warning. {#var#}. Pay now. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Short:Rs.{deficitRs}. Warn:{pad3(warnNum)}/{pad3(maxWarn)}. Lives:{pad3(lifelinesLeft)}"
  COLLECTION_DEFICIT_WARNING: {
    dltTemplateId: process.env.MSG91_TEMPLATE_DEFICIT_WARNING,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", pigmy collection deficit warning. " + detail + ". Pay now. - " + brand;
    },
  },

  // T20 — DLT: Dear {#var#}, all warnings exhausted for your loan. {#var#}. Penalty will be applied. Contact office immediately. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Warnings:{pad3(maxWarn)}"
  LIFELINE_EXHAUSTED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LIFELINE_EXHAUSTED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", all warnings exhausted for your loan. " + detail + ". Penalty will be applied. Contact office immediately. - " + brand;
    },
  },

  // T21 — DLT: Dear {#var#}, pigmy collection back on track. {#var#}. Thank you. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. Lifelines restored:{pad3(lifelinesMax)}"
  LIFELINE_RESTORED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LIFELINE_RESTORED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", pigmy collection back on track. " + detail + ". Thank you. - " + brand;
    },
  },

  // T22 — DLT: Dear {#var#}, your lifeline count has been adjusted. {#var#}. Contact office. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Loan:{loanNo}. New lifelines:{pad3(newCount)}"
  LIFELINE_ADMIN_ADJUSTED: {
    dltTemplateId: process.env.MSG91_TEMPLATE_LIFELINE_ADJUSTED,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", your lifeline count has been adjusted. " + detail + ". Contact office. - " + brand;
    },
  },

  // T23 — DLT: Dear {#var#}, internal account transfer done. {#var#}. - ABHISHEK FINANCE | SANDHYA SOFTTECH PRIVATE LIMITED
  // VAR2 = merged: "Rs.{amount} from {fromAccount} to {toAccount} on {date}"
  INTERNAL_TRANSFER: {
    dltTemplateId: process.env.MSG91_TEMPLATE_INTERNAL_TRANSFER,
    variableCount: 2, // [name, mergedDetail]
    build: function (name, detail, brand) {
      return "Dear " + name + ", internal account transfer done. " + detail + ". - " + brand;
    },
  },
};

// ─── MSG91 Provider ───────────────────────────────────────────────────────────
const sendViaMSG91 = async function (opts) {
  var phone = opts.phone;
  var allVariables = opts.allVariables;
  var dltTemplateId = opts.dltTemplateId;

  if (!process.env.MSG91_AUTH_KEY || !process.env.MSG91_SENDER_ID) {
    throw new Error("MSG91_AUTH_KEY or MSG91_SENDER_ID not configured in .env");
  }

  // Build per-recipient variable object.
  // MSG91 templates use ##name## and ##details## as variable placeholders.
  // The API payload key names MUST exactly match (without hashes).
  // Mapping: variables[0] → "name", variables[1] → "details"
  var MSG91_VAR_KEYS = ["name", "details"];
  var recipientObj = { mobiles: "91" + phone };
  for (var i = 0; i < allVariables.length; i++) {
    var key = MSG91_VAR_KEYS[i] || ("var" + (i + 1)); // fallback for 3+ vars
    recipientObj[key] = String(allVariables[i] != null ? allVariables[i] : "");
  }

  // MSG91 Flow API v5 — variables MUST be inside recipients array.
  var payload = {
    template_id: dltTemplateId,
    short_url: "0",
    recipients: [recipientObj],
  };

  var response = await axios.post(MSG91_FLOW_URL, payload, {
    headers: {
      authkey: process.env.MSG91_AUTH_KEY,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    timeout: SMS_PROVIDER_TIMEOUT_MS,
  });

  if (!response.data || response.data.type !== "success") {
    throw new Error("MSG91 error: " + JSON.stringify(response.data));
  }

  return { provider: "MSG91", requestId: response.data.message };
};

// ─── Fast2SMS Provider (OTP fallback only) ────────────────────────────────────
const sendViaFast2SMS = async function (opts) {
  var phone = opts.phone;
  var otp = opts.otp;

  if (!process.env.FAST2SMS_API_KEY) {
    throw new Error("FAST2SMS_API_KEY not configured in .env");
  }

  var response = await axios.get(FAST2SMS_URL, {
    params: {
      authorization: process.env.FAST2SMS_API_KEY,
      variables_values: String(otp),
      route: "otp",
      numbers: phone,
    },
    timeout: SMS_PROVIDER_TIMEOUT_MS,
  });

  if (!response.data || response.data.return !== true) {
    throw new Error("Fast2SMS error: " + JSON.stringify(response.data));
  }

  return { provider: "Fast2SMS", requestId: response.data.request_id };
};

// ─── Core sendSms ─────────────────────────────────────────────────────────────
// GUARANTEES:
//   1. NEVER throws — always returns { success: true|false }
//   2. SMS failure NEVER crashes a financial transaction
//   3. All errors logged, nothing silently swallowed
//   4. Phone masked in all log lines (PII)
//   5. isSystemSms=true skips per-user opt-out DB lookup (cron/batch jobs)
const sendSms = async function (opts) {
  var phone = opts.phone;
  var templateKey = opts.templateKey;
  var variables = opts.variables || [];
  var isSystemSms = opts.isSystemSms || false;

  // 1. Normalize & validate phone
  var cleanPhone = normalizePhone(phone);

  // 1a. Detect pre-masked phone data (e.g. "****6544") — this means the caller
  //     is passing a display-masked value instead of the raw DB phone number.
  //     Root cause is usually: populate() returning a toJSON-masked field,
  //     or the raw phone column is corrupted in MongoDB.
  if (/\*/.test(String(phone ?? ""))) {
    logger.error(
      "[SMS] MASKED PHONE DETECTED: \"" + String(phone) + "\" | Template: " + templateKey +
      " | The caller is passing a masked value instead of the raw phone. " +
      "Check the .populate() or DB record — the phone field may be corrupted."
    );
    return { success: false, reason: "phone_is_masked_not_raw" };
  }

  if (!cleanPhone || cleanPhone.length < 10) {
    logger.warn("[SMS] Invalid phone: \"" + maskPhone(phone) + "\" | Template: " + templateKey);
    return { success: false, reason: "invalid_phone_number" };
  }

  // 2. Mock mode — resolve brand name for display only
  if (process.env.SMS_MOCK_MODE === "true") {
    var brandName = await resolveSmsFooter();
    var tmpl = SMS_TEMPLATES[templateKey];
    var mockMsg = "[unknown template]";
    if (tmpl) {
      try { mockMsg = tmpl.build.apply(null, variables.concat([brandName])); }
      catch (e) { mockMsg = "[build error: " + e.message + "]"; }
    }
    logger.info("[SMS MOCK] To: " + maskPhone(cleanPhone) + " | Template: " + templateKey + " | Msg: " + mockMsg);
    return { success: true, mock: true };
  }

  // 3. Global SMS toggle
  var globalEnabled = await isGlobalSmsEnabled();
  if (!globalEnabled) {
    logger.info("[SMS] Skipped - globally disabled | Phone: " + maskPhone(cleanPhone) + " | Template: " + templateKey);
    return { success: false, reason: "sms_disabled_globally" };
  }

  // 4. Per-user opt-out (skipped for system/cron SMS)
  if (!isSystemSms) {
    var optResult = await isPhoneOptedOut(cleanPhone);
    if (optResult.optedOut) {
      logger.info("[SMS] Skipped - " + optResult.reason + " | Phone: " + maskPhone(cleanPhone) + " | Template: " + templateKey);
      return { success: false, reason: optResult.reason };
    }
  }

  // 5. Validate template exists
  var template = SMS_TEMPLATES[templateKey];
  if (!template) {
    logger.error("[SMS] Unknown template key: \"" + templateKey + "\". Add it to SMS_TEMPLATES.");
    return { success: false, reason: "unknown_template_" + templateKey };
  }

  // 6. Validate DLT template ID is set in .env
  if (!template.dltTemplateId) {
    logger.warn("[SMS] MSG91 template ID not set for: " + templateKey + ". Copy the template ID from control.msg91.com → Templates, then set MSG91_TEMPLATE_* in .env.");
    return { success: false, reason: "dlt_id_not_configured_" + templateKey };
  }

  // 7. Variable count guard
  if (template.variableCount !== undefined && variables.length !== template.variableCount) {
    logger.error("[SMS] Variable count mismatch | Template: " + templateKey + " | Expected: " + template.variableCount + " | Received: " + variables.length);
    return { success: false, reason: "variable_count_mismatch_" + templateKey };
  }

  // 7b. DLT TRAI Rule: Every variable must be 3–30 characters.
  //     Auto-pad short values; truncate long values; log warnings.
  for (var vi = 0; vi < variables.length; vi++) {
    var v = String(variables[vi] ?? "");
    if (v.length < 3) {
      logger.warn("[SMS] DLT var too short | Template: " + templateKey + " | VAR" + (vi + 1) + ": \"" + v + "\" (" + v.length + " chars). Padding to 3.");
      variables[vi] = v.padStart(3, "0");
    }
    if (v.length > 30) {
      logger.warn("[SMS] DLT var too long | Template: " + templateKey + " | VAR" + (vi + 1) + ": " + v.length + " chars. Truncating to 30.");
      variables[vi] = v.slice(0, 30);
    }
  }

  // 8. DLT COMPLIANCE: Brand name is STATIC TEXT in DLT template — NOT a variable.
  //    Only caller-supplied variables are sent to MSG91 as VAR1...VARn.
  //    Footer is resolved only for audit log display.
  var allVariables = variables; // ← NO footer appended — DLT has it hardcoded

  // Build readable string for audit log only — NOT sent to MSG91
  var brandForLog = await resolveSmsFooter();
  var messageForLog = "[build unavailable]";
  try {
    messageForLog = template.build.apply(null, variables.concat([brandForLog]));
  } catch (buildErr) {
    logger.error("[SMS] Template build() threw | Key: " + templateKey + " | " + buildErr.message);
    return { success: false, reason: "template_build_error_" + templateKey };
  }

  var dltTemplateId = template.dltTemplateId;

  // 9. Primary: MSG91
  try {
    var result = await sendViaMSG91({ phone: cleanPhone, allVariables: allVariables, dltTemplateId: dltTemplateId });
    logger.info("[SMS] Sent | Provider: " + result.provider + " | To: " + maskPhone(cleanPhone) + " | Template: " + templateKey + " | ReqID: " + result.requestId);
    return Object.assign({ success: true }, result);

  } catch (primaryErr) {
    logger.error("[SMS] MSG91 failed: " + primaryErr.message + " | To: " + maskPhone(cleanPhone) + " | Template: " + templateKey);

    // 10. Fallback: Fast2SMS — OTP only
    if (templateKey === "OTP_VERIFICATION" && process.env.FAST2SMS_API_KEY) {
      try {
        var otp = variables[1]; // variables = [name, otp]
        if (!otp) {
          logger.error("[SMS] OTP value missing - cannot use Fast2SMS fallback.");
        } else {
          var fbResult = await sendViaFast2SMS({ phone: cleanPhone, otp: otp });
          logger.info("[SMS] Fallback sent | Provider: " + fbResult.provider + " | To: " + maskPhone(cleanPhone));
          return Object.assign({ success: true }, fbResult);
        }
      } catch (fallbackErr) {
        logger.error("[SMS] Fast2SMS fallback also failed: " + fallbackErr.message + " | To: " + maskPhone(cleanPhone));
      }
    }

    // 11. All providers failed — NEVER throw
    logger.error("[SMS] All providers failed | To: " + maskPhone(cleanPhone) + " | Template: " + templateKey);
    return { success: false, reason: primaryErr.message };
  }
};

// ─── Convenience Wrappers (DLT Compliant — Pre-Merged VAR2) ───────────────────
// Import ONLY these in your service files — never call sendSms() directly.
// Footer is resolved internally. Never pass footer from callers.
// TRAI Rule: Max 2 variables per template. Wrappers merge fields into VAR2.
// Function SIGNATURES are unchanged — callers do NOT need any updates.

// Auth (T1 — 2 vars: name, otp — no merge needed)
const sendKycOtp = function (phone, name, otp) {
  return sendSms({ phone: phone, templateKey: "OTP_VERIFICATION", variables: [name, otp] });
};

// KYC (T2 — 1 var, T3 — 2 vars — no merge needed)
const sendKycApproved = function (phone, name) {
  return sendSms({ phone: phone, templateKey: "KYC_APPROVED", variables: [name] });
};
const sendKycRejected = function (phone, name, reason) {
  return sendSms({ phone: phone, templateKey: "KYC_REJECTED", variables: [name, reason] });
};

// Collections (T4 — merge amount+receipt+balance into VAR2, date dropped to fit)
// VAR2 example: "Rs.500 Rcpt:RCP001 Bal:5000" (27 chars ✅)
const sendCollectionReceipt = function (phone, name, amount, date, receipt, balance) {
  var merged = "Rs." + amount + " Rcpt:" + receipt + " Bal:" + balance;
  return sendSms({ phone: phone, templateKey: "COLLECTION_RECEIPT", variables: [name, merged.slice(0, 30)] });
};

// Saving Account (T5-T8 — merge fields into VAR2)
// VAR2 example: "A/C:SAV0012345 Charge:Rs.100" (28 chars ✅)
const sendSavingAccountOpened = function (phone, name, accountNumber, openingCharge) {
  var merged = "A/C:" + accountNumber + " Charge:Rs." + openingCharge;
  return sendSms({ phone: phone, templateKey: "SAVING_ACCOUNT_OPENED", variables: [name, merged.slice(0, 30)] });
};
// VAR2 example: "A/C:SAV0012345 Bal:Rs.5000" (26 chars ✅)
const sendSavingAccountClosed = function (phone, name, accountNumber, balanceReturned) {
  var merged = "A/C:" + accountNumber + " Bal:Rs." + balanceReturned;
  return sendSms({ phone: phone, templateKey: "SAVING_ACCOUNT_CLOSED", variables: [name, merged.slice(0, 30)] });
};
// VAR2 example: "A/C:SAV001 Rs.1000 Bal:6000" (27 chars ✅) — date dropped, acct truncated to 6
const sendSavingDepositReceipt = function (phone, name, accountNumber, amount, date, balance) {
  var acc = String(accountNumber).slice(0, 6);
  var merged = "A/C:" + acc + " Rs." + amount + " Bal:" + balance;
  return sendSms({ phone: phone, templateKey: "SAVING_DEPOSIT_RECEIPT", variables: [name, merged.slice(0, 30)] });
};
// VAR2 example: "A/C:SAV001 Rs.500 Bal:5500" (26 chars ✅) — date dropped, acct truncated to 6
const sendSavingWithdrawalReceipt = function (phone, name, accountNumber, amount, date, balance) {
  var acc = String(accountNumber).slice(0, 6);
  var merged = "A/C:" + acc + " Rs." + amount + " Bal:" + balance;
  return sendSms({ phone: phone, templateKey: "SAVING_WITHDRAWAL_RECEIPT", variables: [name, merged.slice(0, 30)] });
};

// Pigmy Account (T9-T10 — merge fields into VAR2)
// VAR2 example: "A/C:PIG001 Daily:Rs.50 Daily" (28 chars ✅) — acct truncated to 6
const sendPigmyAccountOpened = function (phone, name, accountNumber, dailyDeposit, frequency) {
  var acc = String(accountNumber).slice(0, 6);
  var merged = "A/C:" + acc + " Daily:Rs." + dailyDeposit + " " + frequency;
  return sendSms({ phone: phone, templateKey: "PIGMY_ACCOUNT_OPENED", variables: [name, merged.slice(0, 30)] });
};
// VAR2 example: "A/C:PIG0012345 Bal:Rs.18250" (27 chars ✅)
const sendPigmyAccountClosed = function (phone, name, accountNumber, balanceReturned) {
  var merged = "A/C:" + accountNumber + " Bal:Rs." + balanceReturned;
  return sendSms({ phone: phone, templateKey: "PIGMY_ACCOUNT_CLOSED", variables: [name, merged.slice(0, 30)] });
};

// Loans (T11-T14)
// VAR2 example: "A/C:LOAN-2026-00001 Rs.1780" (27 chars ✅)
const sendLoanDisbursed = function (phone, name, amount, loanNo) {
  var merged = "A/C:" + loanNo + " Rs." + amount;
  return sendSms({ phone: phone, templateKey: "LOAN_DISBURSED", variables: [name, merged.slice(0, 30)] });
};
// VAR2 example: "Loan:LN001 EMI:2500 Due:47500" (29 chars ✅) — loanNo truncated to 5
const sendLoanRepayment = function (phone, name, amount, loanNo, outstanding) {
  var ln = String(loanNo).slice(0, 5);
  var merged = "Loan:" + ln + " EMI:" + amount + " Due:" + outstanding;
  return sendSms({ phone: phone, templateKey: "LOAN_REPAYMENT", variables: [name, merged.slice(0, 30)] });
};
const sendLoanClosed = function (phone, name, loanNo) {
  return sendSms({ phone: phone, templateKey: "LOAN_CLOSED", variables: [name, loanNo] });
};
const sendLoanWrittenOff = function (phone, name, loanNo) {
  return sendSms({ phone: phone, templateKey: "LOAN_WRITTEN_OFF", variables: [name, loanNo] });
};

// T15 — VAR2 example: "Loan:LN0012345 Status:Active" (28 chars ✅)
const sendLoanReactivated = function (phone, name, loanNo, status) {
  var merged = "Loan:" + loanNo + " Status:" + status;
  return sendSms({ phone: phone, templateKey: "LOAN_REACTIVATED", variables: [name, merged.slice(0, 30)] });
};
// T16 — VAR2 example: "Loan:LN001 Due:47500 Miss:005d" (30 chars ✅) — loanNo truncated to 5
const sendLoanPaymentReminder = function (phone, name, outstanding, loanNo, missedDays) {
  var ln = String(loanNo).slice(0, 5);
  var merged = "Loan:" + ln + " Due:" + outstanding + " Miss:" + pad3(missedDays) + "d";
  return sendSms({ phone: phone, templateKey: "LOAN_PAYMENT_REMINDER", variables: [name, merged.slice(0, 30)] });
};
// T17 — VAR2 example: "Loan:LN0012345 Penalty:Rs.250" (29 chars ✅)
const sendPenaltyApplied = function (phone, name, amount, loanNo) {
  var merged = "Loan:" + loanNo + " Penalty:Rs." + amount;
  return sendSms({ phone: phone, templateKey: "PENALTY_APPLIED", variables: [name, merged.slice(0, 30)] });
};

// Pigmy Deficit Warning & Lifelines (T18-T22, isSystemSms=true — skips opt-out lookup on batch runs)
// T18 — VAR2 example: "Loan:LN0012345 Penalty:Rs.250" (29 chars ✅)
const sendMissedPenaltyApplied = function (phone, name, amount, loanNo) {
  var merged = "Loan:" + loanNo + " Penalty:Rs." + amount;
  return sendSms({ phone: phone, templateKey: "MISSED_PENALTY_APPLIED", variables: [name, merged.slice(0, 30)], isSystemSms: true });
};
// T19 — VAR2 example: "LN001 S:150 W:001/003 Lv:001" (28 chars ✅) — loanNo truncated to 5
const sendCollectionDeficitWarning = function (phone, name, loanNo, deficitRs, dailyRs, warnNum, maxWarn, lifelinesLeft) {
  var ln = String(loanNo).slice(0, 5);
  var merged = ln + " S:" + deficitRs + " W:" + pad3(warnNum) + "/" + pad3(maxWarn) + " Lv:" + pad3(lifelinesLeft);
  return sendSms({ phone: phone, templateKey: "COLLECTION_DEFICIT_WARNING", variables: [name, merged.slice(0, 30)], isSystemSms: true });
};
// T20 — NO CHANGE ("Loan:LN0012345 Warnings:003" = 27 chars ✅)
const sendLifelineExhausted = function (phone, name, loanNo, maxWarn) {
  var merged = "Loan:" + loanNo + " Warnings:" + pad3(maxWarn);
  return sendSms({ phone: phone, templateKey: "LIFELINE_EXHAUSTED", variables: [name, merged.slice(0, 30)], isSystemSms: true });
};
// T21 — VAR2 example: "Loan:LN0012345 Lives:003" (24 chars ✅)
const sendLifelineRestored = function (phone, name, loanNo, lifelinesMax) {
  var merged = "Loan:" + loanNo + " Lives:" + pad3(lifelinesMax);
  return sendSms({ phone: phone, templateKey: "LIFELINE_RESTORED", variables: [name, merged.slice(0, 30)], isSystemSms: true });
};
// T22 — VAR2 example: "Loan:LN0012345 Lives:002" (24 chars ✅)
const sendLifelineAdminAdjusted = function (phone, name, loanNo, newCount) {
  var merged = "Loan:" + loanNo + " Lives:" + pad3(newCount);
  return sendSms({ phone: phone, templateKey: "LIFELINE_ADMIN_ADJUSTED", variables: [name, merged.slice(0, 30)] });
};

// Internal Transfers (T23 — merge 4 fields into VAR2)
// VAR2 example: "Rs.1000 SAV001->PIG001 10May26" (30 chars ✅)
const sendInternalTransfer = function (phone, name, amount, fromAccount, toAccount, date) {
  var merged = "Rs." + amount + " " + fromAccount + "->" + toAccount + " " + date;
  return sendSms({ phone: phone, templateKey: "INTERNAL_TRANSFER", variables: [name, merged.slice(0, 30)] });
};

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  sendSms,
  sendKycOtp,
  sendKycApproved,
  sendKycRejected,
  sendCollectionReceipt,
  sendSavingAccountOpened,
  sendSavingAccountClosed,
  sendSavingDepositReceipt,
  sendSavingWithdrawalReceipt,
  sendPigmyAccountOpened,
  sendPigmyAccountClosed,
  sendLoanDisbursed,
  sendLoanRepayment,
  sendLoanClosed,
  sendLoanWrittenOff,
  sendLoanReactivated,
  sendLoanPaymentReminder,
  sendPenaltyApplied,
  sendCollectionDeficitWarning,
  sendLifelineExhausted,
  sendLifelineRestored,
  sendMissedPenaltyApplied,
  sendLifelineAdminAdjusted,
  sendInternalTransfer,
};
