"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ApiError = require("../src/utils/ApiError");

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = {
    JWT_SECRET: "test-only-signing-key",
    BACKUP_STORAGE_DIR: directory,
    BACKUP_LINK_TTL_HOURS: 24,
    BACKUP_PUBLIC_BASE_URL: "https://api.example.test",
    SMTP_HOST: "smtp.example.test", SMTP_PORT: 587,
    SMTP_USER: "sender@example.test", SMTP_PASS: "test-only",
    BACKUP_EMAIL_TO: "recipient@example.test", NODE_ENV: "test",
    ...options.env,
  };
  const mails = [];
  const module = { exports: {} };
  const source = await fs.readFile(path.resolve(__dirname, "../src/services/backup.service.js"), "utf8");
  vm.runInNewContext(source, {
    module, Buffer, URL, Date,
    require(name) {
      if (name === "../config/env") return env;
      if (name === "../utils/ApiError") return ApiError;
      if (name === "nodemailer") return { createTransport(config) {
        assert.equal(config.requireTLS, true);
        return {
          async verify() { if (options.verifyError) throw Error("SMTP unavailable"); },
          async sendMail(mail) {
            mails.push(mail);
            if (options.mailError) throw Error("SMTP rejected");
            return { accepted: [env.BACKUP_EMAIL_TO], rejected: [] };
          },
        };
      } };
      if (name.startsWith("../models/")) return {
        collection: { name: name.split("/").pop().split(".")[0] },
        find() { return {
          setOptions() { return this; }, sort() { return this; }, lean() { return this; },
          cursor() { return {
            async *[Symbol.asyncIterator]() {
              yield { _id: "record", balance: 100, password: "excluded", nested: { panEncrypted: "excluded", city: "Pune" }, entries: [{ refreshTokenHash: "excluded", amount: 50 }] };
              if (options.queryError) throw Error("Database read failed");
            },
            async close() {},
          }; },
        }; },
      };
      return require(name);
    },
  });
  return { service: module.exports, directory, env, mails };
}

test("emails a link to a valid nested JSON export and rejects tampered, expired, and missing links", async (t) => {
  const { service, directory, mails, env } = await fixture(t);
  const result = await service.emailJsonBackup();
  assert.match(result.fileName, /\.json$/);
  assert.equal(mails[0].to, env.BACKUP_EMAIL_TO);
  const link = new URL(mails[0].text.match(/Download: (\S+)/)[1]);
  const token = link.searchParams.get("token");
  const file = await service.resolveDownload(token);
  const data = JSON.parse(await fs.readFile(file.path, "utf8"));
  assert.equal(Object.keys(data.collections).length, 15);
  const row = data.collections.Customer[0];
  assert.equal(row.balance, 100);
  assert.deepEqual(row.nested, { city: "Pune" });
  assert.deepEqual(row.entries, [{ amount: 50 }]);
  assert.equal(row.password, undefined);
  await assert.rejects(service.resolveDownload(token.slice(0,-1) + (token.endsWith("a") ? "b" : "a")), { statusCode: 401 });
  await assert.rejects(service.resolveDownload("../../etc/passwd"), { statusCode: 401 });
  const id = token.split(".")[0];
  const value = `${id}.${Date.now() - 1000}`;
  const signature = crypto.createHmac("sha256", env.JWT_SECRET).update(`backup-download:${value}`).digest("hex");
  await assert.rejects(service.resolveDownload(`${value}.${signature}`), { statusCode: 410 });
  await fs.unlink(file.path);
  await assert.rejects(service.resolveDownload(token), { statusCode: 404 });
  assert.deepEqual(await fs.readdir(directory), []);
});

test("validates recipient and SMTP before exporting", async (t) => {
  const missing = await fixture(t, { env: { BACKUP_EMAIL_TO: "" } });
  await assert.rejects(missing.service.emailJsonBackup(), /BACKUP_EMAIL_TO/);
  assert.deepEqual(await fs.readdir(missing.directory), []);
  const unavailable = await fixture(t, { verifyError: true });
  await assert.rejects(unavailable.service.emailJsonBackup(), /SMTP unavailable/);
  assert.deepEqual(await fs.readdir(unavailable.directory), []);
});

test("removes partial files and files whose email could not be sent", async (t) => {
  for (const options of [{ queryError: true }, { mailError: true }]) {
    const { service, directory } = await fixture(t, options);
    await assert.rejects(service.emailJsonBackup());
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test("cleans expired backups without removing other files", async (t) => {
  const { service, directory } = await fixture(t);
  const backup = await service.createJsonBackup();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(backup.path, old, old);
  await fs.writeFile(path.join(directory, "keep.txt"), "keep");
  await service.cleanupExpiredBackups();
  assert.deepEqual(await fs.readdir(directory), ["keep.txt"]);
});
