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
