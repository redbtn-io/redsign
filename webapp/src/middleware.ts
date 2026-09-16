import { NextRequest, NextResponse } from "next/server";
import { isSender, readRedSession, SESSION_COOKIE } from "./lib/redsession";
import { safeNextPath } from "./lib/nextPath";

// redAuth gate, redSuite convention: a valid platform `red_session` JWT
// (HS256, shared JWT_SECRET, domain-wide .redbtn.io cookie) with an
// @redbtn.io email gets sender access. Sign-in itself lives at
// accounts.redbtn.io — the landing page at `/` carries visitors there.
//
// Exempt: `/` (the public landing page, which renders the composer for
// senders and the front door for everyone else), /sign/<token> + /api/sign/*
// (public signer links) and /api/health (uptime probes).
// AUTH_BYPASS=1 disables the gate for CI/e2e only — never set in prod.
//
// Signed-out browsers are sent to `/` with the requested path preserved as
// `?next=`; the landing button carries it through Accounts and back. NEVER
// delete the shared cookie from here — it belongs to every *.redbtn.io app.

const PUBLIC_PREFIXES = ["/sign/", "/api/sign/", "/api/health"];

export async function middleware(request: NextRequest) {
  if (process.env.AUTH_BYPASS === "1") return NextResponse.next();
  const { pathname } = request.nextUrl;
  // Trailing-slash entries are prefix matches; the rest match the path exactly
  // (or a segment below it), so /api/healthcheck-of-mine could never sneak
  // through on /api/health.
  const isPublic = PUBLIC_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(p + "/")
  );
  if (isPublic) return NextResponse.next();
  // The landing route verifies the session itself and decides what to render.
  if (pathname === "/") return NextResponse.next();
  // Machine consumers authenticate with x-redsign-key; the envelope routes
  // verify it against the hashed store (edge middleware cannot reach Mongo).
  if (pathname.startsWith("/api/envelopes") && request.headers.get("x-redsign-key")) {
    return NextResponse.next();
  }

  const session = await readRedSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (isSender(session)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthorized — sign in at accounts.redbtn.io with a @redbtn.io account" },
      { status: 401 }
    );
  }

  const landing = new URL("/", request.url);
  const next = safeNextPath(pathname + request.nextUrl.search);
  if (next) landing.searchParams.set("next", next);
  return NextResponse.redirect(landing);
}

export const config = {
  // Everything except Next build assets and icons (gating /_next/static
  // serves the gate as CSS/JS to signed-out visitors — the redFinance lesson).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png).*)"],
};
