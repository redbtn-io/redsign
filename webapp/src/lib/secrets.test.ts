import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  generateSecretsKey,
  isEncryptedBlob,
  parseSecretsKey,
  readStoredSecret,
  SECRET_BLOB_PREFIX,
} from './secrets.ts';

const KEY_HEX = 'a'.repeat(64);
const KEY = parseSecretsKey(KEY_HEX);

test('parseSecretsKey accepts 64-hex and base64, rejects everything else', () => {
  assert.equal(parseSecretsKey(KEY_HEX).length, 32);
  const b64 = crypto.randomBytes(32).toString('base64');
  assert.equal(parseSecretsKey(b64).length, 32);
  assert.equal(parseSecretsKey(`"${KEY_HEX}"`).length, 32); // env quoting
  assert.throws(() => parseSecretsKey(undefined), /not set/);
  assert.throws(() => parseSecretsKey('short'), /32 bytes/);
  assert.throws(() => parseSecretsKey('f'.repeat(63)), /32 bytes/);
});

test('generateSecretsKey produces a key parseSecretsKey accepts', () => {
  assert.equal(parseSecretsKey(generateSecretsKey()).length, 32);
});

test('encrypt then decrypt round-trips and is non-deterministic', () => {
  const secret = 'redfinance-webhook-secret-0123456789';
  const a = encryptSecret(KEY, secret);
  const b = encryptSecret(KEY, secret);
  assert.notEqual(a, b, 'a fresh IV per call means the same plaintext never repeats a ciphertext');
  assert.equal(decryptSecret(KEY, a), secret);
  assert.equal(decryptSecret(KEY, b), secret);
  assert.ok(a.startsWith(SECRET_BLOB_PREFIX));
  assert.ok(!a.includes(secret));
});

test('decryptSecret rejects tampering and the wrong key', () => {
  const blob = encryptSecret(KEY, 'a-webhook-signing-secret');
  const [v, iv, tag, ct] = blob.split('.');
  const flipped = `${v}.${iv}.${tag}.${ct.slice(0, -2)}${ct.slice(-2) === 'ff' ? '00' : 'ff'}`;
  assert.throws(() => decryptSecret(KEY, flipped), /unable to authenticate|bad decrypt|Unsupported/i);
  assert.throws(() => decryptSecret(parseSecretsKey('b'.repeat(64)), blob));
  assert.throws(() => decryptSecret(KEY, 'plaintext-secret'), /not an encrypted/);
  assert.throws(() => decryptSecret(KEY, 'v1.only.two'), /malformed/);
});

test('isEncryptedBlob only claims the versioned form', () => {
  assert.equal(isEncryptedBlob(encryptSecret(KEY, 'xxxxxxxxxxxxxxxx')), true);
  assert.equal(isEncryptedBlob('deadbeef'.repeat(8)), false);
  assert.equal(isEncryptedBlob(null), false);
  assert.equal(isEncryptedBlob(undefined), false);
});

test('readStoredSecret prefers the encrypted field', () => {
  const row = {
    webhookSecretEnc: encryptSecret(KEY, 'the-real-encrypted-secret'),
    webhookSecret: 'the-stale-plaintext-one',
  };
  assert.deepEqual(readStoredSecret(row, KEY_HEX), {
    secret: 'the-real-encrypted-secret',
    error: null,
  });
});

test('readStoredSecret falls back to a v0 plaintext row', () => {
  // The existing redFinance consumer must keep signing webhooks after deploy.
  const row = { webhookSecret: 'legacy-plaintext-secret-64' };
  assert.deepEqual(readStoredSecret(row, KEY_HEX), {
    secret: 'legacy-plaintext-secret-64',
    error: null,
  });
});

test('readStoredSecret reports rather than throws on a bad key or missing row', () => {
  const row = { webhookSecretEnc: encryptSecret(KEY, 'a-secret-of-sufficient-length') };
  const wrongKey = readStoredSecret(row, 'b'.repeat(64));
  assert.equal(wrongKey.secret, null);
  assert.ok(wrongKey.error);

  const noKey = readStoredSecret(row, undefined);
  assert.equal(noKey.secret, null);
  assert.match(noKey.error ?? '', /not set/);

  assert.deepEqual(readStoredSecret(null, KEY_HEX), {
    secret: null,
    error: 'consumer not found',
  });
  assert.equal(readStoredSecret({}, KEY_HEX).secret, null);
});

test('readStoredSecret enforces the minimum length on both shapes', () => {
  assert.equal(readStoredSecret({ webhookSecret: 'tooshort' }, KEY_HEX).secret, null);
  assert.equal(
    readStoredSecret({ webhookSecretEnc: encryptSecret(KEY, 'tooshort') }, KEY_HEX).secret,
    null
  );
});
