// Shared Mongo shapes for the envelope routes (v0.2).
//
// Projections and compare-and-set filters live here rather than inline in each
// route so that a) "what never leaves the database" is one reviewable list
// instead of three copies that can drift, and b) the mongodb-memory-server
// tests exercise the exact objects the routes use rather than a
// re-implementation of them.
//
// Pure data: only a type-only mongodb import (erased at runtime) and no app
// imports, so it type-strips cleanly under `node --test`.

import type { ObjectId } from "mongodb";

// signers.token has always been projected out of reads. v0.2 adds
// signers.values (the collected signature PNGs, reachable only through the
// owner-only /:id/values route) and signers.accessCodeHash (which never leaves
// the database at all).
export const ENVELOPE_LIST_PROJECTION = {
  "signers.token": 0,
  "signers.values": 0,
  "signers.accessCodeHash": 0,
} as const;

export const ENVELOPE_DETAIL_PROJECTION = ENVELOPE_LIST_PROJECTION;

// Compare-and-set: records consent only for a signer who has none yet, so two
// racing submissions produce exactly one consent record and the earliest
// timestamp stands. { consentAt: null } and a missing field are both "no
// consent yet" — envelopes created before v0.2 initialise consentAt to null,
// but a defensive $exists check costs nothing and covers a hand-written row.
export function consentClaimFilter(id: ObjectId, signerIdx: number) {
  return {
    _id: id,
    signers: {
      $elemMatch: {
        idx: signerIdx,
        $or: [{ consentAt: null }, { consentAt: { $exists: false } }],
      },
    },
  };
}

// Claims a pending signer on a sent envelope. A concurrent double-submit
// matches nothing here and 409s, which is what makes signing idempotent
// without a transaction.
export function signerCompletionFilter(id: ObjectId, signerIdx: number) {
  return {
    _id: id,
    status: "sent",
    signers: { $elemMatch: { idx: signerIdx, status: "pending" } },
  };
}
