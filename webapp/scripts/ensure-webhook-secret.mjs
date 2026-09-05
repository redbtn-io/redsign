#!/usr/bin/env node
// Ensures a consumer row has a webhook signing secret (the HMAC key redSign
// signs that consumer's webhook deliveries with). Generates a 64-hex secret
// only when missing — idempotent, and it NEVER prints the secret.
//
// v0.2: the secret is written ENCRYPTED (`webhookSecretEnc`, AES-256-GCM under
// REDSIGN_SECRETS_KEY). It stays reversible rather than hashed because redSign
// has to compute the HMAC on outgoing bodies; only API keys are hashed. Rows
// still holding the v0 plaintext `webhookSecret` are read as a fallback by
// lib/secrets.ts and are left alone here — pass --reencrypt to convert one.
//
// For a NEW consumer use scripts/mint-consumer.mjs, which issues the service
// key and the webhook secret together and prints both once. This script only
// backfills a row that already exists.
//
// Usage: node scripts/ensure-webhook-secret.mjs <consumer-name> [--reencrypt]
//
// Requires node >= 22.18 (imports lib/secrets.ts, relying on default
// TypeScript type stripping).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import { encryptSecret, isEncryptedBlob, parseSecretsKey } from '../src/lib/secrets.ts';

const args = process.argv.slice(2);
const reencrypt = args.includes('--reencrypt');
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error('usage: node scripts/ensure-webhook-secret.mjs <consumer-name> [--reencrypt]');
  process.exit(1);
}

const envPath = new URL('../.env.local', import.meta.url);
const readEnv = (key) => {
  if (process.env[key]) return process.env[key];
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
};

const uri = readEnv('MONGODB_URI');
if (!uri) {
  console.error('ensure-webhook-secret: MONGODB_URI not set and no .env.local');
  process.exit(1);
}
let secretsKey;
try {
  secretsKey = parseSecretsKey(readEnv('REDSIGN_SECRETS_KEY'));
} catch (e) {
  console.error(`ensure-webhook-secret: ${e.message}`);
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
  const hasEncrypted = isEncryptedBlob(row.webhookSecretEnc);
  const legacy = typeof row.webhookSecret === 'string' && row.webhookSecret.length >= 16
    ? row.webhookSecret
    : null;

  if (hasEncrypted) {
    console.log(`ensure-webhook-secret: "${name}" already has an encrypted webhook secret`);
  } else if (legacy && reencrypt) {
    // Same secret, now encrypted: the consumer's env does not have to change.
    await db.collection('consumers').updateOne(
      { _id: row._id },
      { $set: { webhookSecretEnc: encryptSecret(secretsKey, legacy) }, $unset: { webhookSecret: '' } }
    );
    console.log(`ensure-webhook-secret: re-encrypted the existing secret for "${name}"`);
  } else if (legacy) {
    console.log(
      `ensure-webhook-secret: "${name}" still has a v0 plaintext webhookSecret. ` +
        'It keeps working; pass --reencrypt to convert it in place.'
    );
  } else {
    await db.collection('consumers').updateOne(
      { _id: row._id },
      { $set: { webhookSecretEnc: encryptSecret(secretsKey, crypto.randomBytes(32).toString('hex')) } }
    );
    console.log(
      `ensure-webhook-secret: generated an encrypted webhook secret for "${name}". ` +
        'It was NOT printed; use scripts/mint-consumer.mjs --rotate if the consumer needs to see it.'
    );
  }
} finally {
  await client.close();
}
