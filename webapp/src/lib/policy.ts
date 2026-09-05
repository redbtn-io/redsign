import crypto from "node:crypto";

// v0.2 send-time and access-time policy: which webhook URLs may be registered,
// when an envelope stops being signable, and the optional per-signer access
// code. Pure (node builtins only) so it unit-tests under `node --test` with
// type stripping, same rule as lib/signing.ts.

// --- webhookUrl allowlist -------------------------------------------------
//
// v0 accepted any http(s) URL. That made the envelope API a small SSRF-ish
// egress primitive for anyone holding a consumer key, and it let a consumer
// register a plaintext http endpoint that would carry the envelope metadata in
// the clear. v0.2 requires https and an allowlisted host.
//
// The allowlist comes from REDSIGN_WEBHOOK_HOST_ALLOWLIST (comma separated).
// An entry starting with "." matches that domain and any subdomain of it;
// anything else must match the host exactly. The default keeps the estate
// working with no configuration: the redbtn suite.

export const DEFAULT_WEBHOOK_HOST_ALLOWLIST = [".redbtn.io"];

export function parseHostAllowlist(raw: string | undefined | null): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? entries : DEFAULT_WEBHOOK_HOST_ALLOWLIST;
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((entry) =>
    entry.startsWith(".") ? h === entry.slice(1) || h.endsWith(entry) : h === entry
  );
}

// null = acceptable, string = rejection reason (returned to the caller as the
// 400 body, so it has to be safe to show and specific enough to act on).
export function webhookUrlError(raw: string, allowlist: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "webhookUrl must be an absolute URL";
  }
  if (u.protocol !== "https:") return "webhookUrl must be https";
  if (u.username || u.password) return "webhookUrl must not embed credentials";
  // IP literals bypass the point of a host allowlist and are the usual shape
  // of an SSRF target, so they are refused even if an operator lists one.
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
    return "webhookUrl must name a host, not an IP address";
  }
  if (!hostAllowed(u.hostname, allowlist)) {
    return `webhookUrl host is not allowlisted (${u.hostname})`;
  }
  return null;
}

// --- envelope expiry ------------------------------------------------------
//
// NEW envelopes get an expiry; envelopes created before v0.2 have no
// expiresAt field and are therefore never expired. That asymmetry is
// deliberate and load bearing: retrofitting a default onto stored envelopes
// would silently kill signing links already in people's inboxes, including the
// pending W-9 envelope 6a96f5fad8f61708c97e7bc5.

export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

export function defaultExpiryDays(raw: string | undefined | null): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 && n <= MAX_EXPIRY_DAYS ? n : DEFAULT_EXPIRY_DAYS;
}

// Payload shapes accepted at creation:
//   omitted            -> now + defaultDays
//   null               -> no expiry (explicit opt out)
//   ISO-8601 string    -> that instant, must be in the future and within cap
//   { expiresInDays }  -> handled by the caller before this is called
// Throws on a value it cannot honour rather than silently falling back.
export function resolveExpiresAt(
  raw: unknown,
  now: Date,
  defaultDays: number = DEFAULT_EXPIRY_DAYS
): Date | null {
  if (raw === null) return null;
  if (raw === undefined) return new Date(now.getTime() + defaultDays * 86_400_000);
  if (typeof raw === "number" || typeof raw === "string") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error("expiresAt must be an ISO-8601 date");
    if (d.getTime() <= now.getTime()) throw new Error("expiresAt must be in the future");
    if (d.getTime() > now.getTime() + MAX_EXPIRY_DAYS * 86_400_000) {
      throw new Error(`expiresAt must be within ${MAX_EXPIRY_DAYS} days`);
    }
    return d;
  }
  throw new Error("expiresAt must be an ISO-8601 date or null");
}

export function expiresInDaysToDate(raw: unknown, now: Date): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EXPIRY_DAYS) {
    throw new Error(`expiresInDays must be 1..${MAX_EXPIRY_DAYS}`);
  }
  return new Date(now.getTime() + n * 86_400_000);
}

// An envelope with no expiresAt (every envelope created before v0.2) is never
// expired. Only a set, past expiry closes the door.
export function isExpired(
  envelope: { expiresAt?: Date | string | null },
  now: Date = new Date()
): boolean {
  const raw = envelope.expiresAt;
  if (raw == null) return false;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

// Why a signing link does not open. Every one of these answers 404 to the
// caller: the body's `error` distinguishes them for the page without the
// endpoint confirming live envelopes to a token guesser.
export type TokenBlock = "voided" | "expired";

export function tokenBlock(
  envelope: { status?: unknown; expiresAt?: Date | string | null },
  now: Date = new Date()
): TokenBlock | null {
  if (envelope.status === "voided") return "voided";
  if (isExpired(envelope, now)) return "expired";
  return null;
}

// --- optional signer access code -----------------------------------------
//
// A second factor for the signing link: the sender gives the code to the
// signer out of band, so an intercepted or forwarded link is not enough on its
// own. Stored as HMAC-SHA256 keyed by the signer's own token, so the stored
// digest is useless to anyone who does not already hold the link, and a short
// human code is not brute forceable from a database dump alone.

export const MIN_ACCESS_CODE_LEN = 4;
export const MAX_ACCESS_CODE_LEN = 32;

export function normalizeAccessCode(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

export function accessCodeError(raw: unknown): string | null {
  const code = normalizeAccessCode(raw);
  if (code.length < MIN_ACCESS_CODE_LEN) {
    return `accessCode must be at least ${MIN_ACCESS_CODE_LEN} characters`;
  }
  if (code.length > MAX_ACCESS_CODE_LEN) {
    return `accessCode must be at most ${MAX_ACCESS_CODE_LEN} characters`;
  }
  return null;
}

export function hashAccessCode(token: string, raw: unknown): string {
  return crypto.createHmac("sha256", token).update(normalizeAccessCode(raw), "utf8").digest("hex");
}

export function accessCodeMatches(
  signer: { token?: string | null; accessCodeHash?: string | null },
  provided: unknown
): boolean {
  if (!signer.accessCodeHash) return true; // no code configured
  if (!signer.token || provided == null || provided === "") return false;
  const expected = Buffer.from(signer.accessCodeHash);
  const got = Buffer.from(hashAccessCode(signer.token, provided));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// --- platform consumers and the org assertion ----------------------------
//
// A platform consumer (consumers.platform === true) is a multi-tenant caller:
// one credential, many orgs. redOffice is the first. Its envelopes must name
// the tenant they belong to, because the completed webhook and the audit trail
// are how the tenant's records get claimed on the other side. A platform
// envelope with no metadata.orgId is refused at creation.
//
// Non-platform consumers (redFinance today) are single tenant: their orgId, if
// any, lives on the consumer row and no per-envelope assertion is required.

export const ORG_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function metadataOrgId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).orgId;
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? s : null;
}

export function orgIdError(orgId: string | null): string | null {
  if (orgId === null) return null;
  return ORG_ID_RE.test(orgId) ? null : "orgId is not a valid org id";
}

export function platformOrgIdError(
  consumer: { platform?: boolean; orgId?: string | null } | null,
  metadata: unknown
): string | null {
  if (!consumer?.platform) return null;
  const orgId = metadataOrgId(metadata);
  if (!orgId) {
    return "metadata.orgId is required for platform consumers";
  }
  if (!ORG_ID_RE.test(orgId)) return "metadata.orgId is not a valid org id";
  return null;
}

// --- who an envelope belongs to, and which tenant a caller is acting for ---
//
// Three separable questions, kept pure here so they are unit tested rather
// than re-derived in seven route files:
//
//   1. what orgId does a NEW envelope get?          resolveEnvelopeOrgId
//   2. may this caller read THIS envelope?          envelopeAccessDenial
//   3. how is a LIST or a bulk write narrowed?      orgScopeFilter
//
// The identity shape is structural on purpose: lib/apiauth.ts owns ApiIdentity
// and imports next/server, which cannot be imported by `node --test`.

export type Actor =
  | { kind: "sender"; email?: string }
  | { kind: "consumer"; name: string; platform?: boolean; orgId?: string | null };

export type Denial = { status: number; error: string };

// A consumer only ever sees the envelopes it created; @redbtn.io senders see
// everything (there is exactly one sender tenant in v0.2).
export function ownsEnvelopeFor(actor: Actor, envelope: { createdBy?: unknown }): boolean {
  if (actor.kind === "sender") return true;
  return envelope.createdBy === `consumer:${actor.name}`;
}

export function envelopeOrgId(envelope: { orgId?: unknown }): string | null {
  return typeof envelope.orgId === "string" && envelope.orgId ? envelope.orgId : null;
}

// The tenant a new envelope is attributed to.
//
// A pinned single-tenant consumer (--org-id) is authoritative: its own row
// wins over anything in the request body, and an assertion that disagrees is
// refused rather than quietly ignored, because "wrong tenant" and "no tenant"
// are both wrong on an audit record. A platform consumer is the opposite case:
// the row names no tenant, so the request must, and the assertion is
// validated. Everyone else may attribute an envelope freely, but the value
// still has to be a well formed org id before it reaches the database.
export function resolveEnvelopeOrgId(
  actor: Actor,
  metadata: unknown
): { orgId: string | null; error: null } | { orgId: null; error: string } {
  const asserted = metadataOrgId(metadata);
  const shapeErr = orgIdError(asserted);
  if (shapeErr) return { orgId: null, error: "metadata.orgId is not a valid org id" };

  if (actor.kind === "consumer") {
    if (actor.platform) {
      const err = platformOrgIdError(actor, metadata);
      if (err) return { orgId: null, error: err };
      return { orgId: asserted, error: null };
    }
    const pinned = actor.orgId ?? null;
    if (pinned) {
      if (asserted && asserted !== pinned) {
        return {
          orgId: null,
          error: `metadata.orgId does not match this consumer's org (${pinned})`,
        };
      }
      return { orgId: pinned, error: null };
    }
  }
  return { orgId: asserted, error: null };
}

// May this caller read this envelope, given the org it says it is acting for?
//
// `requested` is the ?orgId= query parameter (null when absent). Ownership is
// checked first and answers 404, never 403: a consumer must not be able to
// probe for the existence of another consumer's envelope ids.
//
// A platform consumer holds one credential for many tenants, so createdBy
// alone is not a tenant boundary — it MUST name the tenant it is acting for
// and the envelope must belong to that tenant. A pinned consumer is checked
// against its pin, except on envelopes stored before v0.2, which carry no
// orgId at all and stay readable by the consumer that created them.
export function envelopeAccessDenial(
  actor: Actor,
  envelope: { createdBy?: unknown; orgId?: unknown },
  requested: string | null
): Denial | null {
  if (!ownsEnvelopeFor(actor, envelope)) return { status: 404, error: "not found" };
  if (orgIdError(requested)) return { status: 400, error: "orgId is not a valid org id" };

  const envOrg = envelopeOrgId(envelope);
  if (actor.kind === "consumer" && actor.platform) {
    if (!requested) {
      return { status: 400, error: "orgId query parameter is required for platform consumers" };
    }
    if (envOrg !== requested) return { status: 404, error: "not found" };
    return null;
  }

  const pinned = actor.kind === "consumer" ? actor.orgId ?? null : null;
  if (pinned && envOrg && envOrg !== pinned) return { status: 404, error: "not found" };
  if (requested && envOrg !== requested) return { status: 404, error: "not found" };
  return null;
}

// Mongo filter fragment for a list or a scoped write. Same rules as
// envelopeAccessDenial, expressed as a query: a platform consumer must name a
// tenant, a pinned consumer is confined to its pin (plus its own pre-v0.2
// envelopes, which have no orgId), and anyone may narrow to one org.
export function orgScopeFilter(
  actor: Actor,
  requested: string | null
): { filter: Record<string, unknown>; error: null } | { filter: null; error: Denial } {
  if (orgIdError(requested)) {
    return { filter: null, error: { status: 400, error: "orgId is not a valid org id" } };
  }
  if (actor.kind === "consumer" && actor.platform) {
    if (!requested) {
      return {
        filter: null,
        error: { status: 400, error: "orgId query parameter is required for platform consumers" },
      };
    }
    return { filter: { orgId: requested }, error: null };
  }
  const pinned = actor.kind === "consumer" ? actor.orgId ?? null : null;
  if (pinned) {
    if (requested && requested !== pinned) {
      return {
        filter: null,
        error: { status: 400, error: `orgId does not match this consumer's org (${pinned})` },
      };
    }
    // null covers the envelopes this consumer created before it was pinned.
    return { filter: { orgId: { $in: [pinned, null] } }, error: null };
  }
  return { filter: requested ? { orgId: requested } : {}, error: null };
}

// HOOK, deliberately inert in v0.2.
//
// The next version validates the asserted orgId against redOffice's directory
// endpoint (redSign never connects to the redorg database itself; it asks
// redOffice over HTTP — see the tenancy design). The call belongs here:
//
//   const res = await fetch(`${process.env.REDOFFICE_DIRECTORY_URL}/api/orgs/${orgId}`,
//     { headers: { "x-redsign-key": process.env.REDOFFICE_DIRECTORY_KEY }, signal: AbortSignal.timeout(3000) });
//
// with a short positive cache, and a fail-closed answer for platform
// consumers. It is NOT wired up yet: redOffice does not exist at this commit,
// and a fetch to an unset URL would either fail open (worthless) or break
// every platform send (worse). The shape is fixed here so turning it on is one
// function body, not a redesign of the call sites.
export type OrgAssertion = { ok: true } | { ok: false; reason: string };

export async function assertOrgForConsumer(
  consumerName: string,
  orgId: string
): Promise<OrgAssertion> {
  void consumerName;
  void orgId;
  // Intentionally not calling anything yet: the directory does not exist at
  // this commit, and configuring a URL alone must not start enforcing a
  // contract the directory has not agreed to serve.
  return { ok: true };
}
