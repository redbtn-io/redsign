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

// Client IP for the audit trail (v0.2).
//
// v0 recorded only the first X-Forwarded-For value. sign.redbtn.io sits behind
// Cloudflare and then redrouter-proxy and then traefik, and each hop appends,
// so the first value is whatever the outermost proxy was told: spoofable by
// the client sending its own X-Forwarded-For. CF-Connecting-IP is set by
// Cloudflare from the real TCP peer and cannot be spoofed through it, so it
// wins when present. The whole forwarded chain is kept verbatim beside it,
// because an audit trail that shows only the answer cannot be checked.
export function clientIp(headers: { get(name: string): string | null }): {
  ip: string | null;
  chain: string | null;
  source: "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip" | null;
} {
  const cf = firstHeaderValue(headers.get("cf-connecting-ip"));
  const xff = headers.get("x-forwarded-for");
  const real = firstHeaderValue(headers.get("x-real-ip"));
  const chainParts: string[] = [];
  if (cf) chainParts.push(`cf-connecting-ip=${cf}`);
  if (xff) chainParts.push(`x-forwarded-for=${xff.trim()}`);
  if (real) chainParts.push(`x-real-ip=${real}`);
  const chain = chainParts.length ? chainParts.join("; ").slice(0, 500) : null;
  if (cf) return { ip: cf, chain, source: "cf-connecting-ip" };
  const first = firstHeaderValue(xff);
  if (first) return { ip: first, chain, source: "x-forwarded-for" };
  if (real) return { ip: real, chain, source: "x-real-ip" };
  return { ip: null, chain, source: null };
}
