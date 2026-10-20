import type { ConfigContext, ExpoConfig } from 'expo/config';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import configure from '../app.config';

const projectId = '11111111-2222-4333-8444-555555555555';
const base: ExpoConfig = { name: 'Honey Wallet', slug: 'honey-wallet', web: { output: 'static' } };
const config = (value = base) => configure({ config: value } as ConfigContext);
const variables = [
  'EAS_PROJECT_ID',
  'HONEY_UPDATE_CHANNEL',
  'HONEY_TARGET',
  'EXPO_PUBLIC_TEST_MODE',
  'EXPO_PUBLIC_E2E',
  'EXPO_PUBLIC_TARGET',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_AUTH_ORIGIN',
  'EXPO_PUBLIC_AUTH_CHAIN_ID',
];

beforeEach(() => {
  for (const name of variables) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

function release(channel = 'preview') {
  vi.stubEnv('EAS_PROJECT_ID', projectId);
  vi.stubEnv('HONEY_UPDATE_CHANNEL', channel);
  vi.stubEnv('EXPO_PUBLIC_TEST_MODE', '0');
  vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://api.honey.example');
  vi.stubEnv('EXPO_PUBLIC_AUTH_ORIGIN', 'https://wallet.honey.example');
  vi.stubEnv('EXPO_PUBLIC_AUTH_CHAIN_ID', 'eip155:1');
}

it('allows unlinked local development while keeping remote updates disabled', () => {
  expect(config().updates?.enabled).toBe(false);
  expect(config().updates?.url).toBeUndefined();
  expect(config().web?.output).toBe('static');
});

it.each(['preview', 'production'])(
  'routes the %s binary to the same project/channel as its updates',
  (channel) => {
    release(channel);
    const result = config();
    expect(result.updates).toMatchObject({
      enabled: true,
      url: `https://u.expo.dev/${projectId}`,
      requestHeaders: { 'expo-channel-name': channel },
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    });
    expect(result.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(result.extra?.eas?.projectId).toBe(projectId);
  },
);

it('supports a project linked in app.json and preserves other extra config', () => {
  const result = config({ ...base, extra: { keep: 'value', eas: { projectId } } });
  expect(result.extra).toEqual({ keep: 'value', eas: { projectId } });
  expect(result.updates?.enabled).toBe(true);
});

it('keeps the extension independent from native OTA settings', () => {
  vi.stubEnv('HONEY_TARGET', 'extension');
  vi.stubEnv('EAS_PROJECT_ID', 'not-a-project');
  expect(config().web?.output).toBe('single');
  expect(config().updates?.enabled).toBe(false);
});

it('does not export an extension bundle as a native OTA release', () => {
  release();
  vi.stubEnv('HONEY_TARGET', 'extension');
  expect(config).toThrow('native OTA release cannot');
});

it('refuses release builds with missing or malformed project IDs or wrong channels', () => {
  release();
  vi.stubEnv('EAS_PROJECT_ID', undefined);
  expect(config).toThrow('Set EAS_PROJECT_ID');
  vi.stubEnv('EAS_PROJECT_ID', 'wrong');
  expect(config).toThrow('UUID');
  vi.stubEnv('EAS_PROJECT_ID', projectId);
  vi.stubEnv('HONEY_UPDATE_CHANNEL', 'prod');
  expect(config).toThrow('preview or production');
});

it.each([
  ['EXPO_PUBLIC_TEST_MODE', '1'],
  ['EXPO_PUBLIC_TEST_MODE', undefined],
  ['EXPO_PUBLIC_E2E', '1'],
  ['EXPO_PUBLIC_TARGET', 'extension'],
])('refuses a release contaminated by %s=%s', (name, value) => {
  release();
  vi.stubEnv(name as string, value);
  expect(config).toThrow('Native releases require');
});

it.each([
  ['EXPO_PUBLIC_API_URL', undefined],
  ['EXPO_PUBLIC_API_URL', 'http://localhost:8080'],
  ['EXPO_PUBLIC_AUTH_ORIGIN', 'https://localhost'],
  ['EXPO_PUBLIC_AUTH_ORIGIN', 'https://user:password@example.com'],
  ['EXPO_PUBLIC_AUTH_CHAIN_ID', '1'],
])('refuses a release with broken service configuration %s', (name, value) => {
  release();
  vi.stubEnv(name as string, value);
  expect(config).toThrow();
});
