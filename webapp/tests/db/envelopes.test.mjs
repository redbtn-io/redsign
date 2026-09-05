import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { startTestDb } from "./harness.mjs";
import {
  ENVELOPE_DETAIL_PROJECTION,
  ENVELOPE_LIST_PROJECTION,
  consentClaimFilter,
  signerCompletionFilter,
} from "../../src/lib/queries.ts";
import { isExpired, orgScopeFilter, tokenBlock } from "../../src/lib/policy.ts";

// The v0.2 read and write contracts, exercised against a real Mongo (in
// memory) using the exact projection and filter objects the routes use.

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function envelopeDoc(overrides = {}) {
  return {
    status: "sent",
    documentFileId: "f1",
    documentName: "By-Laws.pdf",
    documentSha256: "a".repeat(64),
    executedFileId: null,
    executedSha256: null,
    signers: [
      {
        idx: 0,
        name: "Signer One",
        email: "one@example.com",
        token: "1".repeat(48),
        accessCodeHash: "d".repeat(64),
        status: "signed",
        viewedAt: new Date(),
        consentAt: new Date(),
        consent: { disclosureVersion: "2026-09-05.1" },
        signedAt: new Date(),
        ip: "203.0.113.9",
        ipChain: "cf-connecting-ip=203.0.113.9; x-forwarded-for=1.2.3.4",
        userAgent: "test",
        values: { 0: PNG },
      },
      {
        idx: 1,
        name: "Signer Two",
        token: "2".repeat(48),
        accessCodeHash: null,
        status: "pending",
        viewedAt: null,
        consentAt: null,
        consent: null,
        signedAt: null,
        ip: null,
        ipChain: null,
        userAgent: null,
      },
    ],
    fields: [{ type: "signature", page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05, signerIdx: 0 }],
    metadata: { app: "redoffice", orgId: "org_abc", kind: "w9" },
    orgId: "org_abc",
    webhookUrl: "https://finance.redbtn.io/api/webhooks/redsign",
    expiresAt: null,
    createdBy: "consumer:redoffice",
    createdAt: new Date(),
    sentAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

describe("envelope read and write contracts", () => {
  let h;
  let id;
  before(async () => {
    h = await startTestDb();
  });
  after(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    await h.db.collection("envelopes").deleteMany({});
    const r = await h.db.collection("envelopes").insertOne(envelopeDoc());
    id = r.insertedId;
  });

  test("list and detail reads strip tokens, signature values and access codes", async () => {
    for (const projection of [ENVELOPE_LIST_PROJECTION, ENVELOPE_DETAIL_PROJECTION]) {
      const e = await h.db.collection("envelopes").findOne({ _id: id }, { projection });
      const serialised = JSON.stringify(e);
      assert.ok(!serialised.includes(PNG), "signature PNGs must not ride along on a read");
      assert.ok(!serialised.includes("1".repeat(48)), "signer tokens must not leak");
      assert.ok(!serialised.includes("d".repeat(64)), "access code digests must not leak");
      for (const s of e.signers) {
        assert.equal(s.values, undefined);
        assert.equal(s.token, undefined);
        assert.equal(s.accessCodeHash, undefined);
      }
      // Everything a consumer actually needs survives the projection.
      assert.equal(e.signers[0].name, "Signer One");
      assert.equal(e.signers[0].status, "signed");
      assert.equal(e.signers[0].ip, "203.0.113.9");
      assert.equal(e.documentSha256, "a".repeat(64));
    }
  });

  test("the owner-only values read is the one place the PNGs come back", async () => {
    const e = await h.db.collection("envelopes").findOne({ _id: id });
    assert.equal(e.signers[0].values["0"], PNG);
  });

  test("consent is recorded exactly once, and the first record wins", async () => {
    const first = new Date("2026-09-05T10:00:00.000Z");
    const second = new Date("2026-09-05T10:05:00.000Z");
    const claim = (at) =>
      h.db
        .collection("envelopes")
        .updateOne(consentClaimFilter(id, 1), {
          $set: { "signers.$.consentAt": at, "signers.$.consent": { at } },
        });

    assert.equal((await claim(first)).modifiedCount, 1);
    assert.equal((await claim(second)).modifiedCount, 0, "a second consent must not overwrite");

    const e = await h.db.collection("envelopes").findOne({ _id: id });
    assert.deepEqual(e.signers[1].consentAt, first);
    // Signer 0 already consented on insert and is likewise not re-claimable.
    assert.equal(
      (
        await h.db
          .collection("envelopes")
          .updateOne(consentClaimFilter(id, 0), { $set: { "signers.$.consentAt": second } })
      ).modifiedCount,
      0
    );
  });

  test("the consent claim also covers a row with no consentAt field at all", async () => {
    await h.db.collection("envelopes").updateOne({ _id: id }, { $unset: { "signers.1.consentAt": "" } });
    const r = await h.db
      .collection("envelopes")
      .updateOne(consentClaimFilter(id, 1), { $set: { "signers.$.consentAt": new Date() } });
    assert.equal(r.modifiedCount, 1);
  });

  test("a signer can only be completed once, and only while the envelope is sent", async () => {
    const set = { $set: { "signers.$.status": "signed", "signers.$.signedAt": new Date() } };
    assert.equal(
      (await h.db.collection("envelopes").updateOne(signerCompletionFilter(id, 1), set))
        .matchedCount,
      1
    );
    assert.equal(
      (await h.db.collection("envelopes").updateOne(signerCompletionFilter(id, 1), set))
        .matchedCount,
      0,
      "a double submit finds nothing to claim and 409s"
    );

    await h.db.collection("envelopes").updateOne({ _id: id }, { $set: { status: "voided" } });
    await h.db
      .collection("envelopes")
      .updateOne({ _id: id }, { $set: { "signers.1.status": "pending" } });
    assert.equal(
      (await h.db.collection("envelopes").updateOne(signerCompletionFilter(id, 1), set))
        .matchedCount,
      0,
      "a voided envelope is not signable even with a pending signer"
    );
  });

  test("an envelope stored without expiresAt stays signable forever", async () => {
    // The shape of every envelope created before v0.2, including the pending
    // W-9 6a96f5fad8f61708c97e7bc5. Read it back out of Mongo (not from the
    // literal) so a missing field really is a missing field.
    const legacy = envelopeDoc();
    delete legacy.expiresAt;
    const r = await h.db.collection("envelopes").insertOne(legacy);
    const stored = await h.db.collection("envelopes").findOne({ _id: r.insertedId });
    assert.equal(stored.expiresAt, undefined);
    assert.equal(isExpired(stored), false);
    assert.equal(tokenBlock(stored), null);
  });

  test("a new envelope with a past expiry is blocked, a future one is not", async () => {
    const past = await h.db
      .collection("envelopes")
      .insertOne(envelopeDoc({ expiresAt: new Date("2026-01-01T00:00:00Z") }));
    const future = await h.db
      .collection("envelopes")
      .insertOne(envelopeDoc({ expiresAt: new Date("2099-01-01T00:00:00Z") }));

    const expired = await h.db.collection("envelopes").findOne({ _id: past.insertedId });
    const live = await h.db.collection("envelopes").findOne({ _id: future.insertedId });
    assert.equal(tokenBlock(expired), "expired");
    assert.equal(tokenBlock(live), null);

    await h.db
      .collection("envelopes")
      .updateOne({ _id: future.insertedId }, { $set: { status: "voided" } });
    const voided = await h.db.collection("envelopes").findOne({ _id: future.insertedId });
    assert.equal(tokenBlock(voided), "voided");
  });

  test("a platform consumer's list is confined to the org it names", async () => {
    // One credential, many tenants: createdBy is identical on all three rows,
    // so only the org filter separates them.
    await h.db.collection("envelopes").deleteMany({});
    await h.db.collection("envelopes").insertMany([
      envelopeDoc({ orgId: "org_t1", documentName: "t1.pdf" }),
      envelopeDoc({ orgId: "org_t2", documentName: "t2.pdf" }),
      envelopeDoc({ orgId: null, documentName: "legacy.pdf" }),
    ]);
    const platform = { kind: "consumer", name: "redoffice", platform: true, orgId: null };
    const scope = orgScopeFilter(platform, "org_t1");
    assert.equal(scope.error, null);
    const rows = await h.db
      .collection("envelopes")
      .find({ createdBy: "consumer:redoffice", ...scope.filter })
      .toArray();
    assert.deepEqual(
      rows.map((r) => r.documentName),
      ["t1.pdf"]
    );
    // Without ?orgId= there is no query at all, by design.
    assert.equal(orgScopeFilter(platform, null).filter, null);
  });

  test("a pinned consumer sees its org and its own pre-v0.2 envelopes", async () => {
    await h.db.collection("envelopes").deleteMany({});
    // A genuine pre-v0.2 row: the orgId key is absent, not null.
    const legacy = envelopeDoc({ createdBy: "consumer:acme", documentName: "legacy.pdf" });
    delete legacy.orgId;
    await h.db.collection("envelopes").insertMany([
      envelopeDoc({ createdBy: "consumer:acme", orgId: "org_abc", documentName: "mine.pdf" }),
      envelopeDoc({ createdBy: "consumer:acme", orgId: "org_other", documentName: "theirs.pdf" }),
      legacy,
    ]);
    const pinned = { kind: "consumer", name: "acme", platform: false, orgId: "org_abc" };
    const scope = orgScopeFilter(pinned, null);
    const rows = await h.db
      .collection("envelopes")
      .find({ createdBy: "consumer:acme", ...scope.filter })
      .toArray();
    assert.deepEqual(rows.map((r) => r.documentName).sort(), ["legacy.pdf", "mine.pdf"]);
  });

  test("a consumer only ever finds its own envelopes", async () => {
    await h.db
      .collection("envelopes")
      .insertOne(envelopeDoc({ createdBy: "consumer:someone-else" }));
    const mine = await h.db
      .collection("envelopes")
      .find({ createdBy: "consumer:redoffice" })
      .toArray();
    assert.equal(mine.length, 1);
    assert.equal(String(mine[0]._id), String(id));
    assert.ok(ObjectId.isValid(mine[0]._id));
  });
});
