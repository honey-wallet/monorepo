// Node 22 strips erasable TS syntax; resolve the keyring's bundler-style relative imports.
// This changes module resolution only, never source, crypto, RPC or validation behavior.
import { registerHooks } from 'node:module';

const keyring = new URL('../../../keyring/src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        context.parentURL?.startsWith(keyring) &&
        /^\.\.?\/[^.]+$/.test(specifier)
      ) {
        return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
      }
      throw error;
    }
  },
});
