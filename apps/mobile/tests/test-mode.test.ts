import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { bunkToggle, NOT_AVAILABLE, TEST_MODE } from '../src/lib/test-mode';

it('is off by default', () => {
  expect(TEST_MODE).toBe(process.env.EXPO_PUBLIC_TEST_MODE === '1');
});

it('keeps Bunk mode off outside test mode', () => {
  expect(bunkToggle(true, false)).toEqual({ enabled: false, toast: NOT_AVAILABLE });
  expect(bunkToggle(false, false).enabled).toBe(false);
});

it('lets test mode turn Bunk mode on and off', () => {
  expect(bunkToggle(true, true)).toEqual({ enabled: true, toast: 'Bunk mode on' });
  expect(bunkToggle(false, true).enabled).toBe(false);
});

it('never shows a saved "on" value outside test mode', () => {
  const screen = readFileSync(
    fileURLToPath(new URL('../src/app/(settings)/bunk-mode.tsx', import.meta.url)),
    'utf8',
  );
  expect(screen).toContain('stored && TEST_MODE');
});
