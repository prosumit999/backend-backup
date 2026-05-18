"use strict";

const mongoose = require("mongoose");

const SoftwareVendorSchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      required: true,
      default: "Sandhya Soft",
    },
    websiteUrl: {
      type: String,
      default: "https://www.sandhyasoft.com",
    },
    supportEmail: {
      type: String,
      default: "support@sandhyasoft.com",
    },
    supportPhone: {
      type: String,
      default: "+91 0000000000",
    },
    logoUrl: {
      type: String,
      default: "",
    },
    termsAndConditions: {
      type: String, // Markdown string
      default: "# Terms and Conditions\n\nStandard software terms apply.",
    },
    privacyPolicy: {
      type: String, // Markdown string
      default: "# Privacy Policy\n\nData is securely stored as per industry standards.",
    },
    licenseValidUntil: {
      type: Date,
      default: () => new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
    },
    softwareVersion: {
      type: String,
      default: "1.0.0",
    },
  },
  {
    timestamps: true,
  }
);

// Singleton Pattern: Ensure only one config document ever exists
SoftwareVendorSchema.statics.getInstance = async function () {
  let vendor = await this.findOne();
  if (!vendor) {
    vendor = await this.create({});
  }
  return vendor;
};

module.exports = mongoose.model("SoftwareVendor", SoftwareVendorSchema);
