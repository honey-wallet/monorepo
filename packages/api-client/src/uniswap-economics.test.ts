import { expect, it } from 'vitest';
import { swapFixture } from './fixtures/swaps';
import fixture from './fixtures/uniswap-economics.json';
import type { SwapAuthority } from './types';
import { swapAuthorityFromQuote, validateSwapEconomics } from './uniswap-economics';

it('proves declared spend and receive bounds for split and mixed-protocol calls', () => {
  for (const f of fixture.valid)
    expect(validateSwapEconomics(f.policy as SwapAuthority, f.call, fixture.now), f.name).toEqual(
      f.expected,
    );
});
it('rejects hidden spending, unapproved fees, weak receive floors and lost refunds', () => {
  for (const f of fixture.invalid)
    expect(
      () => validateSwapEconomics(f.policy as SwapAuthority, f.call, fixture.now),
      f.name,
    ).toThrow();
});
it('requires the exact live deadline and never renews authority at review time', () => {
  const f = fixture.valid[0];
  if (!f) throw new Error('fixture');
  expect(() => validateSwapEconomics(f.policy as SwapAuthority, f.call, fixture.now + 300)).toThrow(
    'deadline',
  );
  expect(() =>
    validateSwapEconomics(f.policy as SwapAuthority, f.call, fixture.now - 1800),
  ).toThrow('deadline');
});

it('derives public immutable authority from the reviewed quote without inventing fee permission', () => {
  const { configuration, quote } = swapFixture();
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const policy = swapAuthorityFromQuote(quote, configuration, quote.signer, {
    deadline,
    maximumFeeRoundingRaw: '0',
  });
  expect(policy.maximumInputRaw).toBe(quote.amountInRaw);
  expect(policy.minimumOutputRaw).toBe(quote.minimumOutputRaw);
  expect(policy.deadline).toBe(deadline);
  expect(policy.fees.map((f) => f.maximumRoundingRaw)).toEqual(['0']);
  const tokens = [...policy.tokens];
  configuration.tokens.reverse();
  expect(policy.tokens).toEqual(tokens);
  expect(() =>
    swapAuthorityFromQuote({ ...quote, expiresAtMs: Date.now() - 1 }, configuration, quote.signer, {
      deadline,
      maximumFeeRoundingRaw: '0',
    }),
  ).toThrow();
  expect(() =>
    swapAuthorityFromQuote(quote, configuration, configuration.router, {
      deadline,
      maximumFeeRoundingRaw: '0',
    }),
  ).toThrow();
});

it('checks the accepted four-fee schedule against concrete integer balances and rounding', () => {
  const schedule = fixture.valid.find((f) => f.name === 'four_ordered_full_precision_fees');
  if (!schedule) throw new Error('fixture');
  validateSwapEconomics(schedule.policy as SwapAuthority, schedule.call, fixture.now);
  const rates = fixture.feeStress.rates.map(BigInt),
    bps = fixture.feeStress.grossBps.map(BigInt),
    rounding = fixture.feeStress.rounding.map(BigInt);
  // Independent concrete evaluation: no affine bounds or verifier helpers.
  for (let gross = 0n; gross <= 150000n; gross++) {
    let balance = gross;
    rates.forEach((rate, i) => {
      const paid = (balance * rate) / 10n ** 18n;
      if (paid > (gross * (bps[i] ?? 0n)) / 10000n + (rounding[i] ?? 0n))
        throw new Error(`fee ${i} at ${gross}`);
      balance -= paid;
    });
    if (
      gross >= BigInt(fixture.feeStress.grossMinimum) &&
      balance < BigInt(schedule.expected.guaranteedOutputRaw)
    )
      throw new Error(`minimum at ${gross}`);
  }
});
