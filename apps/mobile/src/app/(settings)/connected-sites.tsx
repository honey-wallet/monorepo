import type { Site } from '@honey-wallet/extension/protocol';
import { evmNetwork } from '@honey-wallet/keyring';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetRowSkeletons, SheetScreen } from '@/components/sheets/Sheet';
import { connectedSites, disconnectSite } from '@/lib/dapp';
import { tap } from '@/lib/haptics';
import { hostOf } from '@/lib/multisig';
import { isWeb } from '@/lib/platform';
import { showErrorToast, showToast } from '@/lib/toast';
import { isWalletConnectUri, pairWalletConnect } from '@/lib/walletconnect';
import { makeStyles } from '@/theme';

/**
 * The websites that can see a wallet, and a way to cut them off: Honey for Chrome's, or on
 * the phone the ones connected by WalletConnect (scan a site's code, or paste its link).
 */
export default function ConnectedSitesSheet() {
  const styles = useStyles();
  const [sites, setSites] = useState<Site[] | null>(null);
  useEffect(() => {
    void connectedSites().then((list) =>
      setSites([...list].sort((a, b) => b.connectedAt - a.connectedAt)),
    );
  }, []);

  const disconnect = async (site: Site) => {
    tap();
    await disconnectSite(site.origin);
    setSites((prev) => prev?.filter((s) => s.origin !== site.origin) ?? null);
    showToast('Site disconnected');
  };

  // A desktop site's WalletConnect link, copied ("Copy link" under its QR code).
  const pasteLink = async () => {
    tap();
    const text = (await Clipboard.getStringAsync()).trim();
    if (!isWalletConnectUri(text)) {
      showErrorToast('Copy the site’s link first');
      return;
    }
    showToast('Connecting…');
    pairWalletConnect(text).catch(() => showErrorToast('Link expired'));
  };

  return (
    <SheetScreen
      title="Connected sites"
      footer={
        isWeb ? undefined : (
          <PillButton label="Paste a WalletConnect link" variant="secondary" onPress={pasteLink} />
        )
      }
    >
      {sites === null ? (
        <SheetRowSkeletons count={3} icon={22} />
      ) : sites.length === 0 ? (
        <Text style={styles.empty}>
          {isWeb
            ? 'No sites yet. When you connect Honey to one, it shows here.'
            : 'No sites yet. Scan a site’s WalletConnect code with Honey’s scanner to connect.'}
        </Text>
      ) : (
        sites.map((site) => (
          <SheetRow
            key={site.origin}
            icon="globe"
            title={hostOf(site.origin)}
            subtitle={`${site.walletName} · ${
              site.evm ? (evmNetwork(site.chainId)?.name ?? `Chain ${site.chainId}`) : 'Solana'
            }`}
            accessory={
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${hostOf(site.origin)}`}
                onPress={() => disconnect(site)}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Disconnect</Text>
              </PressableScale>
            }
          />
        ))
      )}
      <View style={styles.gap} />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  empty: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: c.raised,
  },
  buttonText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  gap: {
    height: 8,
  },
}));
