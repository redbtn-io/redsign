import { MongoClient, Db } from "mongodb";

// One client per process; dev-mode HMR re-evaluates modules, so the
// promise is cached on globalThis to avoid connection pile-up.
declare global {
  // eslint-disable-next-line no-var
  var _redsignClient: Promise<MongoClient> | undefined;
}

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!globalThis._redsignClient) {
    globalThis._redsignClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
    }).connect();
  }
  const client = await globalThis._redsignClient;
  return client.db(); // db name comes from the URI path (redsign)
}
