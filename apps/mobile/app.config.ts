import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json, plus the browser extension build (HONEY_TARGET=extension, run by
 * apps/extension's build script): one page that the router drives, since an extension
 * popup can't serve a page per route.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  const channel = process.env.HONEY_UPDATE_CHANNEL;
  if (channel && process.env.HONEY_TARGET === 'extension')
    throw new Error('A native OTA release cannot use HONEY_TARGET=extension.');
  if (process.env.HONEY_TARGET === 'extension')
    return { ...base, web: { ...base.web, output: 'single' }, updates: { enabled: false } };

  const projectId = process.env.EAS_PROJECT_ID || base.extra?.eas?.projectId;
  if (
    projectId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
  )
    throw new Error('EAS_PROJECT_ID must be the UUID of the Honey Expo project.');
  if (channel && channel !== 'preview' && channel !== 'production')
    throw new Error('HONEY_UPDATE_CHANNEL must be preview or production.');

  if (channel) {
    if (!projectId)
      throw new Error('Set EAS_PROJECT_ID before building or publishing an OTA release.');
    if (
      process.env.EXPO_PUBLIC_TEST_MODE !== '0' ||
      process.env.EXPO_PUBLIC_E2E === '1' ||
      process.env.EXPO_PUBLIC_TARGET === 'extension'
    )
      throw new Error(
        'Native releases require EXPO_PUBLIC_TEST_MODE=0 and no extension/E2E target.',
      );
    for (const name of ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_AUTH_ORIGIN']) {
      const value = process.env[name];
      let url: URL;
      try {
        url = new URL(value ?? '');
      } catch {
        throw new Error(`Set ${name} to the HTTPS service URL for this release environment.`);
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
        throw new Error(`${name} must use HTTPS and cannot point to localhost.`);
    }
    if (!/^eip155:[1-9]\d*$/.test(process.env.EXPO_PUBLIC_AUTH_CHAIN_ID ?? ''))
      throw new Error(
        'Set EXPO_PUBLIC_AUTH_CHAIN_ID to the server relying-party chain (e.g. eip155:1).',
      );
  }

  return {
    ...base,
    runtimeVersion: { policy: 'fingerprint' },
    updates: {
      ...base.updates,
      enabled: !!projectId,
      ...(projectId ? { url: `https://u.expo.dev/${projectId}` } : {}),
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      ...(channel
        ? { requestHeaders: { ...base.updates?.requestHeaders, 'expo-channel-name': channel } }
        : {}),
    },
    ...(projectId ? { extra: { ...base.extra, eas: { ...base.extra?.eas, projectId } } } : {}),
  };
};
