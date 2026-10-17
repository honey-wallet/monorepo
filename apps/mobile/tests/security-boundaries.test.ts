import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  seed: vi.fn(),
  draft: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: native.auth, isAuthenticatingOwner: () => false }));
vi.mock('expo-secure-store', () => ({ getItemAsync: native.read, setItemAsync: native.write }));
vi.mock('@/lib/settings', () => ({ updateSettings: vi.fn() }));
vi.mock('@/lib/vault', () => ({ readPrimaryMnemonic: native.seed, draftMnemonic: native.draft }));

import { appLock, appVisibility, loadAppLock, setAppLock, unlockApp } from '@/lib/app-lock';
import { createPhraseAccess } from '@/lib/phrase-access';

beforeEach(() => {
  vi.resetAllMocks();
  native.auth.mockResolvedValue(true);
  native.write.mockResolvedValue(undefined);
  native.read.mockResolvedValue('true');
  native.seed.mockResolvedValue('stored secret');
  native.draft.mockReturnValue('new draft');
  appLock.set({ loaded: false, enabled: false, unlocked: false, busy: false, error: false });
  appVisibility('active');
});

describe('phrase provenance', () => {
  it('never reads the saved phrase before authentication or after denial', async () => {
    const access = createPhraseAccess(false);
    expect(native.seed).not.toHaveBeenCalled();
    native.auth.mockResolvedValue(false);
    expect(await access.read()).toBeNull();
    expect(native.seed).not.toHaveBeenCalled();
  });
  it('does not let a changed mode bypass authentication', async () => {
    const access = createPhraseAccess(false);
    // Even mutation of the exposed value cannot change the captured provenance.
    access.isDraft = true;
    native.auth.mockResolvedValue(false);
    expect(await access.read()).toBeNull();
    expect(native.seed).not.toHaveBeenCalled();
  });
  it('keeps fresh onboarding drafts separate from stored secrets', async () => {
    expect(await createPhraseAccess(true).read()).toEqual({ phrase: 'new draft' });
    expect(native.auth).not.toHaveBeenCalled();
    expect(native.seed).not.toHaveBeenCalled();
  });
  it('discards authentication completed after backgrounding or unmount', async () => {
    let finish!: (value: boolean) => void;
    native.auth.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const access = createPhraseAccess(false);
    const pending = access.read();
    access.cancel();
    finish(true);
    expect(await pending).toBeNull();
    expect(native.seed).not.toHaveBeenCalled();
  });
  it('reads a saved phrase after successful authentication', async () => {
    expect(await createPhraseAccess(false).read()).toEqual({ phrase: 'stored secret' });
    expect(native.auth.mock.invocationCallOrder[0]).toBeLessThan(
      native.seed.mock.invocationCallOrder[0],
    );
  });
});

describe('persistent app protection', () => {
  it('starts closed, stays locked after hydration and cancelled authentication', async () => {
    expect(appLock.get().unlocked).toBe(false);
    await loadAppLock();
    expect(appLock.get()).toMatchObject({ loaded: true, enabled: true, unlocked: false });
    native.auth.mockResolvedValue(false);
    await unlockApp();
    expect(appLock.get().unlocked).toBe(false);
  });
  it('unlocks with authentication and locks on background', async () => {
    await loadAppLock();
    await unlockApp();
    expect(appLock.get().unlocked).toBe(true);
    appVisibility('background');
    expect(appLock.get().unlocked).toBe(false);
    appVisibility('active');
    expect(appLock.get().unlocked).toBe(false);
  });
  it('does not accept an authentication result after backgrounding', async () => {
    await loadAppLock();
    let finish!: (value: boolean) => void;
    native.auth.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = unlockApp();
    appVisibility('background');
    appVisibility('active');
    finish(true);
    await pending;
    expect(appLock.get().unlocked).toBe(false);
  });
  it('allows the authentication dialog inactive/active cycle', async () => {
    await loadAppLock();
    native.auth.mockImplementation(async () => {
      appVisibility('inactive');
      appVisibility('active');
      return true;
    });
    await unlockApp();
    expect(appLock.get().unlocked).toBe(true);
  });
  it('fails closed on storage read failure and preserves protection on write failure', async () => {
    native.read.mockRejectedValue(new Error('locked'));
    await loadAppLock();
    expect(appLock.get()).toMatchObject({ loaded: false, unlocked: false, error: true });
    native.read.mockResolvedValue('true');
    await loadAppLock();
    native.write.mockRejectedValue(new Error('disk'));
    await expect(setAppLock(false)).rejects.toThrow('disk');
    expect(appLock.get().enabled).toBe(true);
  });
  it('persists a confirmed choice and reloads locked', async () => {
    await loadAppLock();
    await setAppLock(true);
    expect(native.write).toHaveBeenCalledWith('honey.app-lock', 'true');
    await loadAppLock();
    expect(appLock.get().unlocked).toBe(false);
  });
});
