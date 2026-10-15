import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';

/**
 * Copies `value` with a tap and reports `copied` for a moment, so a copy icon can
 * swap to a check. Pass `toast` to also confirm with a toast.
 */
export function useCopy(value: string, toast?: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    tap();
    await Clipboard.setStringAsync(value);
    if (toast) showToast(toast);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return { copied, copy };
}
