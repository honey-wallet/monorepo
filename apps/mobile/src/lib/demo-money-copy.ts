export const DEMO_BALANCE_NOTICE =
  'Demo only. Balances and positions are examples; no funds are held in this wallet.';
export const DEMO_DEPOSIT_NOTICE =
  'Simulation only. No funds were deposited and your wallet balance was not changed.';

/** Demo and "preview only" labels are hidden unless the build sets EXPO_PUBLIC_SHOW_DEMO_LABELS=1. */
export const SHOW_DEMO_LABELS = process.env.EXPO_PUBLIC_SHOW_DEMO_LABELS === '1';

/** `label` when demo labels are shown, otherwise the plain wording. */
export const demoLabel = <T>(label: string, plain: T): string | T =>
  SHOW_DEMO_LABELS ? label : plain;
