// mongodb-memory-server harness for the v0.2 database tests.
//
// HARD RULE: no test may touch a real database. redSign's Mongo is the system
// of record for live envelopes, including signing links already in people's
// inboxes, and a test that dropped a collection there would be unrecoverable.
// Three guards, all of which must pass before a client is handed out:
//
//   1. MONGODB_URI must NOT be set in the environment. If it is, the process
//      aborts rather than risk a helper somewhere reading it.
//   2. The URI must be loopback (127.0.0.1 / localhost). A remote host is
//      refused outright.
//   3. The database in the URI must be exactly `test` (the URI therefore
//      contains "/test"), which is what the memory server is configured to
//      hand out.
//
// The guard runs against the URI the memory server actually returns, not
// against what we asked for.
//
// `npm run test:db` runs the files with --test-concurrency=1 on purpose: each
// file starts its own mongod, and the self-hosted CI runners are under a 3 GB
// MemoryMax, where two live mongods plus node wedge the job instead of failing
// it. --test-timeout turns any future wedge into a failed step rather than a
// 30-minute job timeout with no output.

import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";

const TEST_DB_NAME = "test";

export function assertMemoryUri(uri) {
  if (typeof uri !== "string" || !uri) throw new Error("guard: no URI");
  const u = new URL(uri.replace(/^mongodb:/, "http:"));
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`guard: refusing a non-loopback Mongo host in tests (${host})`);
  }
  const dbName = u.pathname.replace(/^\//, "").split("?")[0];
  if (dbName !== TEST_DB_NAME) {
    throw new Error(`guard: test database must be "${TEST_DB_NAME}", got "${dbName || "(none)"}"`);
  }
  if (!uri.includes(`/${TEST_DB_NAME}`)) {
    throw new Error("guard: URI does not name the test database");
  }
  return uri;
}

export async function startTestDb() {
  if (process.env.MONGODB_URI) {
    throw new Error(
      "guard: MONGODB_URI is set. Database tests run only against mongodb-memory-server; " +
        "unset it before running npm run test:db."
    );
  }
  const server = await MongoMemoryServer.create({ instance: { dbName: TEST_DB_NAME } });
  const uri = assertMemoryUri(server.getUri(TEST_DB_NAME));
  const client = await new MongoClient(uri).connect();
  const db = client.db(TEST_DB_NAME);
  return {
    db,
    uri,
    async stop() {
      await client.close();
      await server.stop();
    },
  };
}
