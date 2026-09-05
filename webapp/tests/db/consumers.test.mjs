import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startTestDb, assertMemoryUri } from "./harness.mjs";
import { mintConsumer, hashKey, mintServiceKey } from "../../scripts/mint-consumer.mjs";
import { readStoredSecret, isEncryptedBlob } from "../../src/lib/secrets.ts";

// scripts/mint-consumer.mjs against a real Mongo, in memory. This is the
// script an operator runs to issue the redOffice platform credential, so the
// row it writes is worth asserting field by field.

const SECRETS_KEY = crypto.randomBytes(32).toString("hex");

describe("mint-consumer", () => {
  let h;
  before(async () => {
    h = await startTestDb();
  });
  after(async () => {
    await h.stop();
  });

  test("the guard refuses anything that is not the in-memory test database", () => {
    assert.throws(() => assertMemoryUri("mongodb://10.100.0.10:27017/redsign"), /non-loopback/);
    assert.throws(() => assertMemoryUri("mongodb://127.0.0.1:27017/redsign"), /must be "test"/);
    assert.throws(() => assertMemoryUri("mongodb://127.0.0.1:27017/"), /must be "test"/);
    assert.ok(assertMemoryUri("mongodb://127.0.0.1:27017/test"));
  });

  test("mints a platform consumer with a hashed key and an encrypted secret", async () => {
    const r = await mintConsumer(h.db, {
      name: "redoffice",
      platform: true,
      secretsKey: SECRETS_KEY,
    });
    assert.equal(r.name, "redoffice");
    assert.equal(r.platform, true);
    assert.equal(r.rotated, false);
    assert.match(r.serviceKey, /^rsk_redoffice_[0-9a-f]{48}$/);
    assert.match(r.webhookSecret, /^[0-9a-f]{64}$/);

    const row = await h.db.collection("consumers").findOne({ name: "redoffice" });
    assert.equal(row.platform, true);
    assert.equal(row.orgId, null);
    assert.equal(row.active, true);
    // The service key is hashed: the row cannot be turned back into a credential.
    assert.equal(row.keyHash, hashKey(r.serviceKey));
    assert.ok(!JSON.stringify(row).includes(r.serviceKey));
    // The webhook secret is encrypted, not plaintext and not hashed: redSign
    // has to compute the outgoing HMAC with it.
    assert.equal(row.webhookSecret, undefined);
    assert.ok(isEncryptedBlob(row.webhookSecretEnc));
    assert.ok(!row.webhookSecretEnc.includes(r.webhookSecret));
    assert.deepEqual(readStoredSecret(row, SECRETS_KEY), {
      secret: r.webhookSecret,
      error: null,
    });
  });

  test("the encrypted secret is unreadable under a different key", async () => {
    const row = await h.db.collection("consumers").findOne({ name: "redoffice" });
    const wrong = readStoredSecret(row, crypto.randomBytes(32).toString("hex"));
    assert.equal(wrong.secret, null);
    assert.ok(wrong.error);
  });

  test("refuses to overwrite an existing consumer without --rotate", async () => {
    await assert.rejects(
      mintConsumer(h.db, { name: "redoffice", platform: true, secretsKey: SECRETS_KEY }),
      /already exists/
    );
  });

  test("rotation replaces both credentials and clears any v0 plaintext secret", async () => {
    // Simulate a v0 row that still carries the plaintext secret.
    await h.db
      .collection("consumers")
      .updateOne({ name: "redoffice" }, { $set: { webhookSecret: "v0-plaintext-secret-x" } });
    const before = await h.db.collection("consumers").findOne({ name: "redoffice" });

    const r = await mintConsumer(h.db, {
      name: "redoffice",
      platform: true,
      rotate: true,
      secretsKey: SECRETS_KEY,
    });
    assert.equal(r.rotated, true);

    const after = await h.db.collection("consumers").findOne({ name: "redoffice" });
    assert.notEqual(after.keyHash, before.keyHash);
    assert.equal(after.webhookSecret, undefined, "the plaintext fallback must not survive rotation");
    assert.equal(readStoredSecret(after, SECRETS_KEY).secret, r.webhookSecret);
    assert.ok(after.rotatedAt instanceof Date);
    assert.ok(after.createdAt instanceof Date);
  });

  test("rotating with no tenancy flags keeps the consumer a platform consumer", async () => {
    // `--name redoffice --rotate` is the documented rotation. If it rewrote
    // platform to false, redSign would stop requiring metadata.orgId from
    // redOffice and every later envelope would carry no tenant at all, with
    // nothing in the output saying so.
    const r = await mintConsumer(h.db, { name: "redoffice", rotate: true, secretsKey: SECRETS_KEY });
    assert.equal(r.platform, true, "rotation must not demote a platform consumer");
    assert.equal(r.orgId, null);
    assert.equal(r.tenancyInherited, true);
    const after = await h.db.collection("consumers").findOne({ name: "redoffice" });
    assert.equal(after.platform, true);
    assert.equal(after.orgId, null);
  });

  test("rotating with flags that disagree with the stored row is refused", async () => {
    await assert.rejects(
      mintConsumer(h.db, {
        name: "redoffice",
        orgId: "org_abc123",
        rotate: true,
        secretsKey: SECRETS_KEY,
      }),
      /refusing to change tenancy on rotate/
    );
    const row = await h.db.collection("consumers").findOne({ name: "redoffice" });
    assert.equal(row.platform, true, "the refused rotate must not have touched the row");
  });

  test("--retenant changes tenancy on purpose", async () => {
    const r = await mintConsumer(h.db, {
      name: "redoffice",
      orgId: "org_moved",
      rotate: true,
      retenant: true,
      secretsKey: SECRETS_KEY,
    });
    assert.equal(r.platform, false);
    assert.equal(r.orgId, "org_moved");
    // Put it back: the rest of the suite expects the platform consumer.
    const back = await mintConsumer(h.db, {
      name: "redoffice",
      platform: true,
      rotate: true,
      retenant: true,
      secretsKey: SECRETS_KEY,
    });
    assert.equal(back.platform, true);
    assert.equal(back.orgId, null);
  });

  test("a malformed --org-id is refused before anything is written", async () => {
    await assert.rejects(
      mintConsumer(h.db, { name: "badorg", orgId: "not a valid id!", secretsKey: SECRETS_KEY }),
      /--org-id must be/
    );
    assert.equal(await h.db.collection("consumers").countDocuments({ name: "badorg" }), 0);
  });

  test("a single-tenant consumer pins an orgId; platform and orgId are exclusive", async () => {
    const r = await mintConsumer(h.db, {
      name: "acme",
      orgId: "org_abc123",
      secretsKey: SECRETS_KEY,
    });
    assert.equal(r.platform, false);
    assert.equal(r.orgId, "org_abc123");

    await assert.rejects(
      mintConsumer(h.db, {
        name: "both",
        platform: true,
        orgId: "org_abc123",
        secretsKey: SECRETS_KEY,
      }),
      /mutually exclusive/
    );
  });

  test("rejects bad names and a missing or malformed secrets key", async () => {
    await assert.rejects(
      mintConsumer(h.db, { name: "Bad Name!", secretsKey: SECRETS_KEY }),
      /name must be/
    );
    await assert.rejects(mintConsumer(h.db, { name: "nokey" }), /REDSIGN_SECRETS_KEY is not set/);
    await assert.rejects(
      mintConsumer(h.db, { name: "badkey", secretsKey: "abc" }),
      /must be 32 bytes/
    );
    assert.equal(
      await h.db.collection("consumers").countDocuments({ name: { $in: ["nokey", "badkey"] } }),
      0,
      "a failed mint must not leave a half-configured row"
    );
  });

  test("service keys are unique per mint and carry an identifying prefix", () => {
    const a = mintServiceKey("redoffice");
    const b = mintServiceKey("redoffice");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("rsk_redoffice_"));
  });
});
