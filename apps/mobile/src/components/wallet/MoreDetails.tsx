import { type ReactNode, useState } from 'react';
import { Accordion } from '@/components/motion/Accordion';
import { LabeledDivider } from '@/components/wallet/parts';
import { isWeb } from '@/lib/platform';

/**
 * Details most people don't need, folded under a "Details" rule (the Hidden tokens
 * pattern) in the browser extension's short popup, so a sheet fits without scrolling and
 * its buttons stay in view. On the phone there's room, so they simply show.
 *
 * Only for the advanced part: protocol, hashes, nonces, slippage, price impact, route
 * internals. What someone decides on (amount, recipient, network, signers, cost,
 * warnings) stays outside it.
 */
export function MoreDetails({
  label = 'Details',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!isWeb) return <>{children}</>;
  return (
    <>
      <LabeledDivider label={label} open={open} onPress={() => setOpen((v) => !v)} />
      <Accordion open={open}>{children}</Accordion>
    </>
  );
}
