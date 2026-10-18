import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json, plus the browser extension build (HONEY_TARGET=extension, run by
 * apps/extension's build script): one page that the router drives, since an extension
 * popup can't serve a page per route.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  if (process.env.HONEY_TARGET !== 'extension') return base;
  return { ...base, web: { ...base.web, output: 'single' } };
};
