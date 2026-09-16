import { nextOr } from "./nextPath";

function configuredOrigin(value: string | undefined, fallback: string): string {
  try {
    const url = new URL(value || fallback);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

const APP_ORIGIN = configuredOrigin(
  process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL,
  "https://sign.redbtn.io",
);

const ACCOUNTS_ORIGIN = configuredOrigin(
  process.env.ACCOUNTS_URL,
  "https://accounts.redbtn.io",
);

/**
 * The Accounts sign-in URL for a visitor who should come back to `next`.
 *
 * Accounts implements `/?next=<absolute https URL>` on the ROOT path and
 * drops anything that is not first-party. The return URL is built from the
 * CONFIGURED origin, never the request host — behind redrouter-proxy the
 * container sees its own bind address, not the public domain.
 */
export function accountsSignInUrl(next?: string | null): string {
  const returnUrl = new URL(nextOr(next), APP_ORIGIN + "/").toString();
  const accountsUrl = new URL(ACCOUNTS_ORIGIN);
  accountsUrl.searchParams.set("next", returnUrl);
  return accountsUrl.toString();
}
