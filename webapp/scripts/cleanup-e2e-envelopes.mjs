#!/usr/bin/env node
// Deletes e2e-created envelopes (metadata.e2e: true) and their GridFS PDFs
// (pdfs.files / pdfs.chunks by documentFileId / executedFileId), plus their
// Phase 4 residue: webhook_deliveries and envelope_events rows keyed by the
// envelope ids (collected BEFORE the envelopes are deleted).
//
// Reads MONGODB_URI from the environment, falling back to webapp/.env.local —
// the same file `next dev` loads — so the cleanup always hits the same DB the
// e2e run wrote to. Usage: node scripts/cleanup-e2e-envelopes.mjs
import fs from 'node:fs';
import { MongoClient, ObjectId } from 'mongodb';

const envPath = new URL('../.env.local', import.meta.url);
let uri = process.env.MONGODB_URI ?? null;
if (!uri && fs.existsSync(envPath)) {
  const m = fs.readFileSync(envPath, 'utf8').match(/^MONGODB_URI=(.*)$/m);
  if (m) uri = m[1].trim().replace(/^"|"$/g, '');
}
if (!uri) {
  console.error('cleanup-e2e-envelopes: MONGODB_URI not set and no .env.local — nothing to do');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const db = client.db(); // db name comes from the URI path (redsign)
  const envelopes = await db.collection('envelopes').find({ 'metadata.e2e': true }).toArray();
  let filesDeleted = 0;
  for (const env of envelopes) {
    for (const fid of [env.documentFileId, env.executedFileId]) {
      if (!fid) continue;
      try {
        const _id = new ObjectId(String(fid));
        const r = await db.collection('pdfs.files').deleteOne({ _id });
        await db.collection('pdfs.chunks').deleteMany({ files_id: _id });
        filesDeleted += r.deletedCount;
      } catch {
        // malformed id — skip, the envelope delete below still runs
      }
    }
  }
  const ids = envelopes.map((env) => String(env._id));
  const deliveries = ids.length
    ? (await db.collection('webhook_deliveries').deleteMany({ envelopeId: { $in: ids } })).deletedCount
    : 0;
  const events = ids.length
    ? (await db.collection('envelope_events').deleteMany({ envelopeId: { $in: ids } })).deletedCount
    : 0;
  const r = await db.collection('envelopes').deleteMany({ 'metadata.e2e': true });
  console.log(
    `cleanup-e2e-envelopes: removed ${r.deletedCount} envelope(s), ${filesDeleted} GridFS file(s), ` +
      `${deliveries} webhook deliver(ies), ${events} event(s)`
  );
} finally {
  await client.close();
}
