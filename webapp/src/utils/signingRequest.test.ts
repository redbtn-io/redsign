import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInMemorySigningRequestTokenStore,
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
