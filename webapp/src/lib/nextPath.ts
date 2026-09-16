/**
 * Post-sign-in return paths ("next") — open-redirect defense.
 *
 * A `next` value travels through the landing page and the accounts.redbtn.io
 * sign-in URL, so it must never be able to name another origin. Only same-app
 * relative paths survive; anything else is dropped.
 */

const MAX_NEXT_LENGTH = 512;

// NUL–US and DEL — header-splitting and log-forging territory.
const CONTROL_CHARS = /[-]/;

/** A safe same-app relative path, or null when the value is unusable. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > MAX_NEXT_LENGTH) return null;
  if (CONTROL_CHARS.test(raw)) return null;
  // A single leading slash means "this app". `//host` and `/\host` are how
  // browsers sneak an absolute URL through a path check.
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

/** The safe next path, or the fallback when none was provided or valid. */
export function nextOr(raw: string | null | undefined, fallback = "/"): string {
  return safeNextPath(raw) ?? fallback;
}
