#!/usr/bin/env node
// Ensures a consumer row has a `webhookSecret` (the HMAC key redSign signs
// that consumer's webhook deliveries with). Generates a 64-hex secret only
// when missing — idempotent, and it NEVER prints the secret. The secret is
// stored as-is (not hashed): redSign must be able to compute HMACs with it,
// so unlike the service key it has to stay retrievable server-side.
//
// The consumer reads it out-of-band (operator copies it into the consumer's
// env) — `mongosh redsign --eval 'db.consumers.findOne({name:"..."}).webhookSecret'`.
//
// Usage: node scripts/ensure-webhook-secret.mjs <consumer-name>
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/ensure-webhook-secret.mjs <consumer-name>');
  process.exit(1);
}

const envPath = new URL('../.env.local', import.meta.url);
let uri = process.env.MONGODB_URI ?? null;
if (!uri && fs.existsSync(envPath)) {
  const m = fs.readFileSync(envPath, 'utf8').match(/^MONGODB_URI=(.*)$/m);
  if (m) uri = m[1].trim().replace(/^"|"$/g, '');
}
if (!uri) {
  console.error('ensure-webhook-secret: MONGODB_URI not set and no .env.local');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const db = client.db();
  const row = await db.collection('consumers').findOne({ name });
  if (!row) {
    // Refuses to invent a consumer: rows are provisioned with a keyHash by the
    // key-issuing flow; a secret-only row would be a half-configured trap.
    console.error(`ensure-webhook-secret: consumer "${name}" not found`);
    process.exit(1);
  }
  if (typeof row.webhookSecret === 'string' && row.webhookSecret.length >= 16) {
    console.log(`ensure-webhook-secret: "${name}" already has a webhookSecret`);
  } else {
    await db
      .collection('consumers')
      .updateOne({ _id: row._id }, { $set: { webhookSecret: crypto.randomBytes(32).toString('hex') } });
    console.log(`ensure-webhook-secret: generated webhookSecret for "${name}"`);
  }
} finally {
  await client.close();
}
