function defaultOrigin(): string | null {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin;
  }
  return null;
}

/**
 * Read the `doc` query param that tells the signer which document to load.
 *
 * The returned value flows straight into react-pdf's `<Document file={...}>`,
 * which fetches and renders it. To keep a signing link from being crafted to
 * display arbitrary attacker-controlled content under the redsign UI, `doc` is
 * restricted to **same-origin http(s) references** (the app's own hosted
 * documents). Cross-origin URLs, protocol-relative / backslash-obfuscated
 * off-origin URLs, userinfo-smuggled hosts, and non-http(s) schemes
 * (`javascript:`, `data:`, ...) are rejected and treated as "no document".
 *
 * @param search the raw `location.search` string (e.g. `?doc=/files/a.pdf`)
 * @param origin the trusted app origin to validate against; defaults to
 *   `window.location.origin`. If there is no trusted base origin, the value is
 *   refused rather than trusted.
 */
export function getPdfUrlFromQuery(
  search: string,
  origin: string | null = defaultOrigin(),
): string | null {
  const raw = new URLSearchParams(search).get('doc');
  if (!raw) return null;
  if (!origin) return null;

  let resolved: URL;
  try {
    resolved = new URL(raw, origin);
  } catch {
    return null;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  if (resolved.origin !== origin) return null;
  if (!resolved.pathname.toLowerCase().endsWith('.pdf')) return null;

  return raw;
}
