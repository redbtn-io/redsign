import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

// redAuth gate, redSuite convention (same recipe as redFinance): a valid
// platform `red_session` JWT (HS256, shared JWT_SECRET, domain-wide
// .redbtn.io cookie) with an @redbtn.io email gets sender access.
//
// Exempt: /sign/<token> + /api/sign/* (public signer links, Phase 3).
// AUTH_BYPASS=1 disables the gate for CI/e2e only — never set in prod.

const PUBLIC_PREFIXES = ["/sign/", "/api/sign/"];

const INTERSTITIAL = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>redSign — sign in</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; background: #0f0f11; color: #e4e4e7;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { text-align: center; padding: 32px; max-width: 420px; }
  h1 { font-size: 20px; margin-bottom: 8px; } h1 span { color: #ef4444; }
  p { color: #a1a1aa; font-size: 14px; line-height: 1.6; }
  a.btn { display: inline-block; margin-top: 18px; background: #ef4444; color: #fff; text-decoration: none;
          padding: 11px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; }
</style></head>
<body><div class="box">
  <h1>red<span>Sign</span></h1>
  <p>Sign in at app.redbtn.io with your <strong>@redbtn.io</strong> account, then come back and reload. (If you followed a signing link, ask the sender for a fresh one.)</p>
  <a class="btn" href="https://app.redbtn.io">Sign in at app.redbtn.io</a>
</div></body></html>`;

export async function middleware(request: NextRequest) {
  if (process.env.AUTH_BYPASS === "1") return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  // Machine consumers authenticate with x-redsign-key; the envelope routes
  // verify it against the hashed store (edge middleware can't reach Mongo).
  if (pathname.startsWith("/api/envelopes") && request.headers.get("x-redsign-key")) {
    return NextResponse.next();
  }

  // Fail closed: no secret configured means nobody gets in.
  const secret = (process.env.JWT_SECRET ?? "").replace(/^"|"$/g, "");
  const token = request.cookies.get("red_session")?.value;
  if (secret && token) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ["HS256"],
      });
      const email = String(payload.email ?? "").toLowerCase();
      if (email.endsWith("@redbtn.io")) return NextResponse.next();
    } catch {
      // invalid or expired — fall through to the gate
    }
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "unauthorized — sign in at app.redbtn.io with a @redbtn.io account" },
      { status: 401 }
    );
  }
  return new NextResponse(INTERSTITIAL, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export const config = {
  // Everything except Next build assets and icons (gating /_next/static
  // serves the interstitial as CSS/JS to signed-out visitors — the
  // redFinance lesson).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png).*)"],
};
