#!/usr/bin/env node
// Indexes the envelope reads actually use (v0.2). Idempotent: createIndex on
// an index that already exists is a no-op, so this is safe to re-run and safe
// to run against production.
//
//   node scripts/ensure-indexes.mjs          # create them
//   node scripts/ensure-indexes.mjs --dry    # print what is missing
//
// Why: v0.2 scopes every envelope read by tenant (envelopes.orgId), and the
// list route sorts by createdAt. Without these, a platform consumer's list is
// a collection scan that grows with every tenant on the platform.

import fs from "node:fs";
import { MongoClient } from "mongodb";

const INDEXES = [
  ["envelopes", { orgId: 1, createdAt: -1 }, { name: "orgId_createdAt" }],
  ["envelopes", { createdBy: 1, createdAt: -1 }, { name: "createdBy_createdAt" }],
  ["envelopes", { "signers.token": 1 }, { name: "signers_token" }],
  ["consumers", { keyHash: 1 }, { name: "keyHash", unique: true }],
  ["consumers", { name: 1 }, { name: "name", unique: true }],
  ["envelope_events", { envelopeId: 1, at: 1 }, { name: "envelopeId_at" }],
];

function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = new URL("../.env.local", import.meta.url);
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, "utf8").match(/^MONGODB_URI=(.*)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

const dry = process.argv.includes("--dry");
const uri = resolveMongoUri();
if (!uri) {
  console.error("ensure-indexes: MONGODB_URI not set and no .env.local");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const db = client.db();
  for (const [collection, keys, opts] of INDEXES) {
    const existing = await db
      .collection(collection)
      .indexes()
      .catch(() => []);
    const have = existing.some((i) => i.name === opts.name);
    if (have) {
      console.log(`ok      ${collection}.${opts.name}`);
      continue;
    }
    if (dry) {
      console.log(`missing ${collection}.${opts.name} ${JSON.stringify(keys)}`);
      continue;
    }
    await db.collection(collection).createIndex(keys, opts);
    console.log(`created ${collection}.${opts.name} ${JSON.stringify(keys)}`);
  }
} finally {
  await client.close();
}
