import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  module: {
    supportsAlternateIcons: true,
    getAppIconName: vi.fn<() => string | null>(),
    setAlternateAppIcon: vi.fn<(name: string | null) => Promise<string | null>>(),
  },
  available: true,
}));
vi.mock('expo', () => ({
  requireOptionalNativeModule: () => (mock.available ? mock.module : null),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mock.available = true;
  mock.module.supportsAlternateIcons = true;
});

describe('installed app icon', () => {
  it('reads the persisted OS selection on startup instead of resetting it', async () => {
    mock.module.getAppIconName.mockReturnValue('Graphite');
    const icons = await import('../src/lib/app-icon');
    expect(icons.getAppIcon()).toBe('Graphite');
    expect(mock.module.setAlternateAppIcon).not.toHaveBeenCalled();
  });

  it('waits for the OS and passes null when restoring Honey', async () => {
    let finish: (name: string | null) => void = () => {};
    mock.module.setAlternateAppIcon.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const icons = await import('../src/lib/app-icon');
    const completed = vi.fn();
    const pending = icons.changeAppIcon(null).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(mock.module.setAlternateAppIcon).toHaveBeenCalledWith(null);
    finish(null);
    await pending;
    expect(completed).toHaveBeenCalledWith(null);
  });

  it('propagates a failed native change without reporting a new icon', async () => {
    mock.module.setAlternateAppIcon.mockRejectedValue(new Error('OS refused'));
    mock.module.getAppIconName.mockReturnValue('Midnight');
    const icons = await import('../src/lib/app-icon');
    await expect(icons.changeAppIcon('Graphite')).rejects.toThrow('OS refused');
    expect(icons.getAppIcon()).toBe('Midnight');
  });

  it('loads safely without the native module in Expo Go or web', async () => {
    mock.available = false;
    const icons = await import('../src/lib/app-icon');
    expect(icons.supportsAppIcons).toBe(false);
    expect(icons.getAppIcon()).toBe(null);
    await expect(icons.changeAppIcon('Graphite')).rejects.toThrow('unavailable');
  });

  it('accepts an applied icon even if the OS confirmation callback fails', async () => {
    mock.module.setAlternateAppIcon.mockRejectedValue(new Error('Alert unavailable'));
    mock.module.getAppIconName.mockReturnValue('Midnight');
    const icons = await import('../src/lib/app-icon');
    await expect(icons.changeAppIcon('Midnight')).resolves.toBe('Midnight');
  });

  it('honors devices that do not support alternate icons', async () => {
    mock.module.supportsAlternateIcons = false;
    const icons = await import('../src/lib/app-icon');
    await expect(icons.changeAppIcon('Midnight')).rejects.toThrow('unavailable');
    expect(mock.module.setAlternateAppIcon).not.toHaveBeenCalled();
  });
});
