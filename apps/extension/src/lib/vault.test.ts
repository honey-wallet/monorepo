import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from './storage';
import { AUTO_LOCK_MS, createVault } from './vault';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function setup() {
  let time = 1_000;
  const local = memoryStore();
  const session = memoryStore();
  const vault = createVault(local, session, () => time);
  return { vault, local, session, tick: (ms: number) => (time += ms) };
}

describe('extension vault', () => {
  it('keeps only ciphertext on disk', async () => {
    const { vault, local } = setup();
    await vault.save(PHRASE, 'correct horse', [{ index: 0, label: 'Maya' }]);
    expect(JSON.stringify(await local.get('vault'))).not.toContain('abandon');
    expect(await vault.exists()).toBe(true);
  });

  it('unlocks with the right password only', async () => {
    const { vault } = setup();
    await vault.save(PHRASE, 'correct horse', []);
    await vault.lock();
    expect(await vault.unlocked()).toBeNull();
    expect(await vault.unlock('wrong password')).toBe(false);
    expect(await vault.unlock('correct horse')).toBe(true);
    expect(await vault.unlocked()).toBe(PHRASE);
  });

  it('locks itself after being idle', async () => {
    const { vault, tick } = setup();
    await vault.save(PHRASE, 'correct horse', []);
    tick(AUTO_LOCK_MS - 1);
    expect(await vault.unlocked()).toBe(PHRASE);
    tick(AUTO_LOCK_MS + 1);
    expect(await vault.unlocked()).toBeNull();
  });

  it('derives the same addresses as the phone', async () => {
    const { vault } = setup();
    await vault.save(PHRASE, 'correct horse', [{ index: 0, label: 'Maya' }]);
    const [account] = await vault.accounts(PHRASE);
    expect(account?.addresses.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });
});

it('expires an open popup session and notifies the UI without a getter', async () => {
  const { vault, session } = setup();
  await vault.save(PHRASE, 'correct horse', []);
  vi.useFakeTimers();
  try {
    // Reading refreshes the deadline and schedules the timer under the fake clock.
    await vault.unlocked();
    const locked = vi.fn();
    const unsubscribe = vault.onLock(locked);
    await vi.advanceTimersByTimeAsync(AUTO_LOCK_MS);
    expect(await session.get('unlocked')).toBeUndefined();
    expect(locked).toHaveBeenCalledOnce();
    unsubscribe();
  } finally {
    vi.useRealTimers();
  }
});
