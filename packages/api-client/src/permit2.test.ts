import { expect, it } from 'vitest';
import fixture from './fixtures/permit2.json';
import { swapFixture } from './fixtures/swaps';
import { permit2TypedData, validateEmbeddedPermit, validatePermit2Quote } from './permit2';
import { decodeUniswapRouterCall } from './uniswap-router';

it('reconstructs only the pinned PermitSingle types/domain/message', () => {
  expect(JSON.parse(permit2TypedData(fixture.terms, fixture.now))).toEqual(fixture.typedData);
  for (const changes of [
    { amountRaw: '0' },
    { amountRaw: ((1n << 160n) - 1n).toString() },
    { amountRaw: '01' },
    { nonce: (1n << 48n).toString() },
    { expiration: `${fixture.now + 2592001}` },
    { sigDeadline: `${fixture.now}` },
    { sigDeadline: `${fixture.now + 1801}` },
    { expiration: `${fixture.now + 1}` },
    { permit2: `0x${'0'.repeat(40)}` },
    { chainId: '0' },
    { chainId: '9007199254740992' },
  ])
    expect(() => permit2TypedData({ ...fixture.terms, ...changes }, fixture.now)).toThrow();
});
it('binds permit authority to the actual wallet and current reviewed quote', () => {
  const { configuration, quote } = swapFixture();
  const now = Math.floor(Date.now() / 1000);
  const terms = {
    ...fixture.terms,
    owner: quote.signer,
    permit2: configuration.permit2,
    spender: configuration.router,
    token: quote.tokenIn,
    amountRaw: quote.amountInRaw,
    sigDeadline: `${now + 600}`,
    expiration: `${now + 3600}`,
  };
  expect(() => validatePermit2Quote(terms, configuration, quote, quote.signer)).not.toThrow();
  for (const changes of [
    { owner: configuration.router },
    { spender: quote.signer },
    { permit2: configuration.router },
    { token: quote.tokenOut },
    { amountRaw: '2' },
    { chainId: '10' },
  ]) {
    expect(() =>
      validatePermit2Quote({ ...terms, ...changes }, configuration, quote, quote.signer),
    ).toThrow();
  }
  expect(() =>
    validatePermit2Quote(
      terms,
      configuration,
      { ...quote, expiresAtMs: Date.now() - 1 },
      quote.signer,
    ),
  ).toThrow();
});

it('checks the embedded signature matches the wallet output and persisted terms', () => {
  const execution = decodeUniswapRouterCall(fixture.calldata);
  const check = (e = execution, terms = fixture.terms, sig = fixture.signature) =>
    validateEmbeddedPermit(e, terms, sig, fixture.now);
  expect(() => check()).not.toThrow();
  expect(() => check(execution, { ...fixture.terms, nonce: '8' })).toThrow();
  expect(() => check(execution, fixture.terms, fixture.highS)).toThrow();
  expect(() => check({ ...execution, deadline: `${fixture.now + 601}` })).toThrow();
  expect(() => check({ ...execution, commands: [...execution.commands].reverse() })).toThrow();
  expect(() =>
    check({ ...execution, commands: [...execution.commands, ...execution.commands] }),
  ).toThrow();
  const absent = { ...execution, commands: execution.commands.slice(1) };
  expect(() => check(absent)).toThrow();
  expect(() => validateEmbeddedPermit(absent, null, null, fixture.now)).not.toThrow();
  expect(() => validateEmbeddedPermit(execution, null, null, fixture.now)).toThrow();
});
