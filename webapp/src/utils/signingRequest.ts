export type SigningRequestTokenStatus = 'missing' | 'malformed' | 'expired' | 'duplicate' | 'valid';

export type SigningRequestTokenState = {
  status: SigningRequestTokenStatus;
  token?: string;
};

export type SigningRequestTokenStore = {
  hasUsedToken: (tokenId: string) => boolean;
  markTokenUsed: (tokenId: string) => void;
};

type SignedRequestTokenClaims = {
  tokenId: string;
  expiresAtMs: number;
};

const TOKEN_STORE_PREFIX = 'redsign:signing-request-token';
const TOKEN_VALUE_PATTERN = /^[A-Za-z0-9_-]{8,128}\.\d+$/;
const DEFAULT_VALID_ID_TTL_SAFETY_MARGIN_MS = 0;

const noopStore: SigningRequestTokenStore = {
  hasUsedToken: () => false,
  markTokenUsed: () => undefined,
};

function getDefaultTokenStore(): SigningRequestTokenStore {
  if (typeof window === 'undefined' || !window.localStorage) return noopStore;

  return {
    hasUsedToken: (tokenId) => {
      try {
        return window.localStorage.getItem(storageKey(tokenId)) === '1';
      } catch {
        return false;
      }
    },
    markTokenUsed: (tokenId) => {
      try {
        window.localStorage.setItem(storageKey(tokenId), String(Date.now() + DEFAULT_VALID_ID_TTL_SAFETY_MARGIN_MS));
      } catch {
      }
    },
  };
}

function storageKey(tokenId: string): string {
  return `${TOKEN_STORE_PREFIX}:${tokenId}`;
}

function parseSigningRequestToken(raw: string): SignedRequestTokenClaims | null {
  if (!TOKEN_VALUE_PATTERN.test(raw)) return null;

  const [tokenId, expiresAtRaw] = raw.split('.');
  const parsedExpiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(parsedExpiresAt) || !Number.isInteger(parsedExpiresAt)) return null;

  const isSecondPrecision = expiresAtRaw.length <= 10;
  const expiresAtMs = isSecondPrecision ? parsedExpiresAt * 1000 : parsedExpiresAt;
  if (expiresAtMs <= DEFAULT_VALID_ID_TTL_SAFETY_MARGIN_MS) return null;

  return { tokenId, expiresAtMs };
}

export function getSigningRequestTokenState(
  search: string,
  now: number = Date.now(),
  store: SigningRequestTokenStore = getDefaultTokenStore(),
): SigningRequestTokenState {
  const token = new URLSearchParams(search).get('token');
  if (!token) return { status: 'missing' };

  const claims = parseSigningRequestToken(token);
  if (!claims) return { status: 'malformed' };

  if (claims.expiresAtMs <= now) return { status: 'expired', token: claims.tokenId };
  if (store.hasUsedToken(claims.tokenId)) return { status: 'duplicate', token: claims.tokenId };

  return { status: 'valid', token: claims.tokenId };
}

export function markSigningRequestTokenUsed(
  tokenId: string,
  store: SigningRequestTokenStore = getDefaultTokenStore(),
): void {
  store.markTokenUsed(tokenId);
}

export function createInMemorySigningRequestTokenStore(): SigningRequestTokenStore {
  const used = new Set<string>();

  return {
    hasUsedToken: (tokenId) => used.has(tokenId),
    markTokenUsed: (tokenId) => {
      used.add(tokenId);
    },
  };
}
