import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { NetworkBadge, networkLabel } from '@/components/wallet/MultisigParts';
import { LabeledRule, TokenIcon } from '@/components/wallet/parts';
import { useCopy } from '@/lib/copy';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { useMultisig } from '@/lib/multisig';
import { isWeb } from '@/lib/platform';
import { useProfile } from '@/lib/profile';
import { type ReceiveAddress, receiveAddresses } from '@/lib/receive';
import { isFixtureWallet, isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/** Receive sheet: your address to copy or show as a QR code. */
export default function ReceiveSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  // The wallet in use: a shared wallet receives at its own address, on its own network.
  const wallet = useActiveWallet();
  const multisig = useMultisig(wallet.id);
  const isMain = isMainWallet(wallet);
  const { copied, copy } = useCopy(wallet.address);
  const [showExchange, setShowExchange] = useState(false);
  // Wallets with keys here have an address per chain; list them all, labelled.
  const list = receiveAddresses(wallet);
  const perChain = !multisig && list.length > 1;

  if (isFixtureWallet(wallet))
    return (
      <SheetScreen title={demoLabel('Demo wallet', 'Receive crypto')}>
        <Text style={{ color: c.text }}>Create or import a wallet before receiving funds.</Text>
      </SheetScreen>
    );

  return (
    <SheetScreen title="Receive crypto">
      <SheetText lead>
        {multisig
          ? `Only send tokens on ${multisig.network.name} to this shared wallet. Tokens sent on another network can't be recovered.`
          : perChain
            ? // review: shorter in the 600px-tall extension popup, so the exchange steps fit.
              isWeb
              ? 'Pick the network you’re sending on. Each has its own address.'
              : 'Which network are you sending on? Each one has its own address.'
            : 'Fund your wallet by transferring crypto from another wallet or account'}
      </SheetText>

      {perChain ? (
        // The network first, then its address and QR code (My QR), so the address you
        // copy is the right one. Before: every chain's address listed here (AddressRow).
        <View style={styles.firstCard}>
          <ChainPicker
            entries={list}
            onPick={(chain) => router.push({ pathname: '/my-qr', params: { chain } })}
          />
        </View>
      ) : (
        <View style={[styles.card, styles.firstCard]}>
          {multisig ? (
            <NetworkBadge network={multisig.network} size={44} />
          ) : isMain ? (
            <Avatar name={profile.name} size={44} uri={profile.photo} seed={profile.avatarSeed} />
          ) : (
            <Avatar name={wallet.label} size={44} seed={wallet.id} />
          )}
          <View style={styles.flex}>
            <Text style={styles.name}>{wallet.label}</Text>
            <Text style={styles.address}>
              {multisig ? `${networkLabel(multisig)} · ` : ''}
              {shortAddress(wallet.address, 6, 4)}
            </Text>
          </View>
          <PressableScale
            accessibilityLabel="Copy address"
            scaleTo={0.97}
            onPress={copy}
            style={styles.round}
          >
            <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
          </PressableScale>
          <PressableScale
            accessibilityLabel="Show QR code"
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push('/my-qr');
            }}
            style={styles.round}
          >
            <Icon name="qr" size={15} color={c.text} />
          </PressableScale>
        </View>
      )}

      <LabeledRule label="From an account" />
      {/* The card holds the fill: PressableRow paints its own pressed background. */}
      <View style={styles.exchangeCard}>
        <PressableRow
          accessibilityState={{ expanded: showExchange }}
          onPress={() => {
            tap();
            setShowExchange((v) => !v);
          }}
          style={[styles.exchangeRow, isWeb && styles.exchangeRowWeb]}
        >
          <View style={[styles.exchange, isWeb && styles.exchangeWeb]}>
            <Icon name="bank" size={18} color={c.accentText} />
          </View>
          <Text style={[styles.name, styles.flex]}>From an exchange</Text>
          <AccordionChevron open={showExchange} size={13} color={c.textSecondary} />
        </PressableRow>
      </View>
      <Accordion open={showExchange}>
        <View style={[styles.steps, isWeb && styles.stepsWeb]}>
          {(isWeb
            ? // review: one line each in the 600px-tall extension popup, so the steps fit
              // without scrolling; same meaning as the phone's.
              [
                perChain
                  ? 'Pick a network above and copy its address.'
                  : 'Copy your Honey address.',
                'Withdraw to it from your exchange.',
                'Pick the same network and confirm.',
              ]
            : [
                perChain
                  ? 'Pick the network you’ll withdraw on above, then copy its address.'
                  : 'Copy your Honey address.',
                'In your exchange, choose Withdraw and paste it as the destination.',
                'Pick the matching network, then confirm. Funds usually arrive in minutes.',
              ]
          ).map((step, i) => (
            <View key={step} style={styles.step}>
              <Text style={styles.stepNumber}>{i + 1}</Text>
              <Text style={[styles.stepText, styles.flex]}>{step}</Text>
            </View>
          ))}
          {perChain ? null : (
            <PillButton
              label={copied ? 'Copied' : 'Copy address'}
              variant="secondary"
              onPress={copy}
            />
          )}
        </View>
      </Accordion>
    </SheetScreen>
  );
}

/** One chain's address: logo, name, short address, copy and QR. */
// biome-ignore lint/correctness/noUnusedVariables: the per-chain list's row, before the network picker
function AddressRow({ entry }: { entry: ReceiveAddress }) {
  const styles = useStyles();
  const c = useTheme();
  const { copied, copy } = useCopy(entry.address);
  return (
    <View style={styles.row}>
      <TokenIcon symbol={entry.symbol} size={36} />
      <View style={styles.flex}>
        <Text style={styles.name}>{entry.title}</Text>
        <Text style={styles.address}>{shortAddress(entry.address, 6, 4)}</Text>
      </View>
      <PressableScale
        accessibilityLabel={`Copy ${entry.title} address`}
        scaleTo={0.97}
        onPress={copy}
        style={styles.round}
      >
        <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
      </PressableScale>
      <PressableScale
        accessibilityLabel={`Show ${entry.title} QR code`}
        scaleTo={0.97}
        onPress={() => {
          tap();
          router.push({ pathname: '/my-qr', params: { chain: entry.family } });
        }}
        style={styles.round}
      >
        <Icon name="qr" size={15} color={c.text} />
      </PressableScale>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  list: {
    paddingVertical: 4,
    paddingHorizontal: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  firstCard: {
    marginTop: 8,
  },
  name: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  address: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  steps: {
    paddingTop: 14,
    gap: 12,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 22,
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 13,
    fontWeight: '600',
  },
  stepText: {
    color: c.text,
    fontSize: 15,
    lineHeight: 21,
  },
  exchangeCard: {
    ...radius(20),
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  exchangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  // review: a tighter exchange row and steps in the extension popup.
  exchangeRowWeb: {
    paddingVertical: 10,
  },
  exchangeWeb: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  stepsWeb: {
    paddingTop: 10,
    gap: 8,
  },
  exchange: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
