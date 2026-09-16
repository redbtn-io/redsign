import { cookies } from "next/headers";
import ComposeClient from "./compose-client";
import Landing from "./landing";
import { authBypass, isSender, readRedSession, SESSION_COOKIE } from "@/lib/redsession";

export const dynamic = "force-dynamic";

// Root: senders get the composer they have always had; everyone else gets the
// public landing page. The gate is the same one the middleware applies — a
// signature-valid shared red_session with an @redbtn.io email.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  if (authBypass()) return <ComposeClient />;

  const store = await cookies();
  const session = await readRedSession(store.get(SESSION_COOKIE)?.value);
  if (isSender(session)) return <ComposeClient />;

  return <Landing next={next} />;
}
