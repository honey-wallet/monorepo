import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DEMO_BALANCE_NOTICE, DEMO_DEPOSIT_NOTICE } from '../src/lib/demo-money-copy';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

it('uses plain disclosures that distinguish demo balances from real funds', () => {
  expect(DEMO_BALANCE_NOTICE).toMatch(/Demo only/i);
  expect(DEMO_BALANCE_NOTICE).toMatch(/no funds are held/i);
  expect(DEMO_DEPOSIT_NOTICE).toMatch(/Simulation only/i);
  expect(DEMO_DEPOSIT_NOTICE).toMatch(/no funds were deposited/i);
  expect(DEMO_DEPOSIT_NOTICE).toMatch(/balance was not changed/i);
});

it('labels demo savings balances and both simulated deposit outcomes', () => {
  const savings = source('../src/app/(wallet)/savings.tsx');
  const earn = source('../src/app/(savings)/earn/[symbol].tsx');
  const add = source('../src/app/(savings)/savings-add.tsx');
  const buy = source('../src/app/(money)/buy-cash.tsx');
  expect(savings).toContain('<DemoMoneyNotice />');
  expect(earn).toContain('<DemoMoneyNotice />');
  expect(earn).toContain('title="Demo deposit simulation"');
  expect(earn).toContain('no funds were deposited');
  expect(add).toContain('<DemoMoneyNotice />');
  expect(add).toContain('<DemoMoneyNotice deposit />');
  expect(add).toContain('title="Demo addition simulation"');
  expect(add).toContain('your wallet balance was not changed');
  expect(buy).toContain('if (!wallet.demo)');
  expect(buy).toContain('<DemoMoneyNotice deposit />');
  expect(buy).toContain("title={selling ? 'Demo sale simulation' : 'Demo purchase simulation'}");
  expect(buy).toContain('markDemoFunded()');
  expect(buy).not.toContain('markFunded(');
});

it('keeps Home balance and holdings clearly labeled while demo data is visible', () => {
  const home = source('../src/app/(wallet)/home.tsx');
  expect(home).toContain(
    'The balances and holdings shown here are illustrative examples, not real assets.',
  );
  expect(home).toContain('{empty ? null : (');
  expect(home).toContain('styles.demoDisclosure');
});

it('never marks onboarding funded from opening the receive screen', () => {
  const receive = source('../src/app/(money)/receive.tsx');
  const onboarding = source('../src/lib/onboarding.ts');
  expect(receive).toContain('if (wallet.demo)');
  expect(receive).not.toMatch(/markFunded|simulateDemoDeposit/);
  expect(onboarding).not.toContain('simulateDemoDeposit');
  expect(onboarding).not.toMatch(/arrived\. You're all set|Money arrived/);
  expect(onboarding).toContain("showToast('Demo balance updated')");
});
