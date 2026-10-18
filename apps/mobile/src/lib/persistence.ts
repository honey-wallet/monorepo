/**
 * Saving app state between launches. On the phone nothing is saved yet: the app stays
 * open, and its secrets are in the Keychain. The browser version is persistence.web.ts.
 */
export const persistence = {
  register(_key: string, _restore: (saved: unknown) => void) {},
  save(_key: string, _state: unknown) {},
  ready: Promise.resolve(),
  async clear() {},
};
