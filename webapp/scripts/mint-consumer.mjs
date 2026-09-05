#!/usr/bin/env node
// Mints a machine consumer of the envelope API (v0.2).
//
//   node scripts/mint-consumer.mjs --name redoffice --platform
//   node scripts/mint-consumer.mjs --name acme --org-id org_123
//   node scripts/mint-consumer.mjs --name redoffice --rotate
//
// What it writes to the `consumers` collection:
//   name              unique
//   keyHash           sha256 of the service key (x-redsign-key). HASHED: redSign
//                     only ever compares it.
//   webhookSecretEnc  AES-256-GCM blob under REDSIGN_SECRETS_KEY. ENCRYPTED,
//                     not hashed: redSign has to compute the outgoing HMAC with
//                     the plaintext, so it must be reversible. v0 stored this in
//                     the clear, which put a live signing key in every database
//                     dump, backup and screen-share of the collection.
//   platform          true for a multi-tenant caller (redOffice). Platform
//                     consumers must assert metadata.orgId on every envelope.
//   orgId             single-tenant pin, for a consumer that only ever acts for
//                     one org. Mutually exclusive with --platform.
//
// The service key and the webhook secret are printed ONCE, at mint time, and
// are unrecoverable afterwards: the key is hashed and the secret is encrypted
// under a key this script does not print. Copy them straight into the
// consumer's workspace env.
//
// Requires node >= 22.18 (it imports lib/secrets.ts directly, relying on
// default TypeScript type stripping — the same thing `npm run test:unit`
// relies on).

import crypto from "node:crypto";
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { encryptSecret, parseSecretsKey } from "../src/lib/secrets.ts";

export function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function mintServiceKey(name) {
  // Prefixed so a leaked credential is identifiable on sight, and scoped by
  // consumer name so an operator reading logs knows whose key turned up.
  return `rsk_${name.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}_${crypto
    .randomBytes(24)
    .toString("hex")}`;
}

export function mintWebhookSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function validateConsumerName(name) {
  if (!name || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name)) {
    throw new Error("name must be 2-40 chars of [a-z0-9_-] and start alphanumeric");
  }
  return name;
}

// Core, exported so the mongodb-memory-server tests can exercise the real
// thing instead of a re-implementation of it.
export async function mintConsumer(db, opts) {
  const name = validateConsumerName(opts.name);
  const platform = opts.platform === true;
  const orgId = opts.orgId ?? null;
  if (platform && orgId) {
    throw new Error("--platform and --org-id are mutually exclusive: a platform consumer serves many orgs");
  }
  const key = parseSecretsKey(opts.secretsKey);

  const existing = await db.collection("consumers").findOne({ name });
  if (existing && !opts.rotate) {
    throw new Error(`consumer "${name}" already exists (pass --rotate to issue new credentials)`);
  }

  const serviceKey = mintServiceKey(name);
  const webhookSecret = mintWebhookSecret();
  const now = new Date();
  const set = {
    name,
    keyHash: hashKey(serviceKey),
    webhookSecretEnc: encryptSecret(key, webhookSecret),
    platform,
    orgId,
    active: true,
    updatedAt: now,
    rotatedAt: existing ? now : null,
  };
  // The v0 plaintext field is removed on rotation, so a rotated row cannot fall
  // back to a stale cleartext secret.
  await db
    .collection("consumers")
    .updateOne(
      { name },
      { $set: set, $unset: { webhookSecret: "" }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

  return { name, platform, orgId, serviceKey, webhookSecret, rotated: Boolean(existing) };
}

function parseArgs(argv) {
  const out = { name: null, orgId: null, platform: false, rotate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--org-id") out.orgId = argv[++i];
    else if (a === "--platform") out.platform = true;
    else if (a === "--rotate") out.rotate = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = new URL("../.env.local", import.meta.url);
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, "utf8").match(/^MONGODB_URI=(.*)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

function resolveSecretsKey() {
  if (process.env.REDSIGN_SECRETS_KEY) return process.env.REDSIGN_SECRETS_KEY;
  const envPath = new URL("../.env.local", import.meta.url);
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, "utf8").match(/^REDSIGN_SECRETS_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.name) {
    console.error(
      "usage: node scripts/mint-consumer.mjs --name <consumer> [--platform | --org-id <id>] [--rotate]"
    );
    process.exit(1);
  }
  const uri = resolveMongoUri();
  if (!uri) {
    console.error("mint-consumer: MONGODB_URI not set and no .env.local");
    process.exit(1);
  }
  const secretsKey = resolveSecretsKey();
  if (!secretsKey) {
    console.error(
      "mint-consumer: REDSIGN_SECRETS_KEY not set. Generate one with:\n" +
        "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n" +
        "and put it in the workspace env BEFORE minting: rows encrypted under a key that is\n" +
        "then lost cannot sign webhooks."
    );
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const result = await mintConsumer(client.db(), { ...opts, secretsKey });
    console.log("");
    console.log(`consumer:        ${result.name}${result.rotated ? " (rotated)" : " (created)"}`);
    console.log(`platform:        ${result.platform}`);
    console.log(`orgId:           ${result.orgId ?? "(none)"}`);
    console.log("");
    console.log("Copy these into the consumer's workspace env. They are shown once.");
    console.log(`  REDSIGN_KEY=${result.serviceKey}`);
    console.log(`  REDSIGN_WEBHOOK_SECRET=${result.webhookSecret}`);
    console.log("");
  } finally {
    await client.close();
  }
}

// Only run when invoked directly, so the tests can import mintConsumer.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
