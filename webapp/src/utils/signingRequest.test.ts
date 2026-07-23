import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInMemorySigningRequestTokenStore,
  markSigningRequestTokenUsed,
  getSigningRequestTokenState,
} from './signingRequest.ts';

test('rejects malformed signing-link tokens', () => {
  const store = createInMemorySigningRequestTokenStore();
  const state = getSigningRequestTokenState(
    '?doc=%2Ffiles%2Fcontract.pdf&token=invalid-token-format',
    1_700_000_000_000,
    store,
  );

  assert.equal(state.status, 'malformed');
  assert.equal(state.token, undefined);
});

test('marks token as duplicate after it is consumed', () => {
  const store = createInMemorySigningRequestTokenStore();
  const now = 1_700_000_000_000;
  const tokenId = 'token1234.1700000001000';
  const search = `?doc=%2Ffiles%2Fcontract.pdf&token=${tokenId}`;

  const firstState = getSigningRequestTokenState(search, now, store);
  assert.equal(firstState.status, 'valid');
  assert.equal(firstState.token, 'token1234');

  markSigningRequestTokenUsed(firstState.token, store);

  const duplicateState = getSigningRequestTokenState(search, now, store);
  assert.equal(duplicateState.status, 'duplicate');
  assert.equal(duplicateState.token, 'token1234');
});

test('keeps a valid token available until explicit signing completion', () => {
  const store = createInMemorySigningRequestTokenStore();
  const now = 1_700_000_000_000;
  const search = '?doc=%2Ffiles%2Fcontract.pdf&token=token1234.1700000001000';

  // Evaluating the token state on page load must not consume it.
  const pageLoadState = getSigningRequestTokenState(search, now, store);
  assert.equal(pageLoadState.status, 'valid');
  assert.equal(getSigningRequestTokenState(search, now, store).status, 'valid');

  // The signer consumes it only after the explicit completion callback.
  markSigningRequestTokenUsed(pageLoadState.token!, store);
  assert.equal(getSigningRequestTokenState(search, now, store).status, 'duplicate');
});
