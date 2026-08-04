// Dependency-free HTTP header helpers (unit-testable under node --test,
// which cannot resolve the extensionless imports lib/db.ts pulls in).

// Proxy chains (redrouter-proxy -> traefik) append to forwarded headers, so
// X-Forwarded-Proto can arrive as "https,http" and X-Forwarded-Host as a
// comma list. Only the first (client-facing) value is meaningful — using the
// raw header verbatim produced signing links like "https,http://sign...".
export function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0].trim();
  return first || null;
}

// Client-facing origin for minting absolute signing links, derived from the
// forwarded headers (first value wins, per above). Takes anything Headers-like
// so it works with NextRequest.headers and plain fetch Headers alike.
export function publicBase(headers: { get(name: string): string | null }): string {
  const proto = firstHeaderValue(headers.get("x-forwarded-proto")) ?? "https";
  const host =
    firstHeaderValue(headers.get("x-forwarded-host")) ??
    firstHeaderValue(headers.get("host")) ??
    "sign.redbtn.io";
  return `${proto}://${host}`;
}
