import { type Href, router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { closeSheet, SheetHeader, SheetRow, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';
import { getProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { addWallet, demoAddress, nextWalletLabel } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type Page = 'main' | 'import' | 'hardware';
const ORDER: Page[] = ['main', 'import', 'hardware'];

type Option = { icon: IconName; title: string; hint: string; onPress: () => void };

/**
 * Add wallet, in one sheet whose pages slide side by side: create (a normal or a
 * burner wallet), import (recovery phrase or private key), watch, or connect hardware
 * (Ledger or Keystone).
 */
export default function AddWalletSheet() {
  const [page, setPage] = useState<Page>('main');
  const go = (next: Page) => () => setPage(next);
  const open = (href: Href) => () => router.push(href);

  const create = () => {
    addWallet({
      kind: 'wallet',
      label: nextWalletLabel(getProfile().name),
      address: demoAddress(),
      usd: 0,
    });
    showToast('New wallet created');
    closeSheet();
  };

  const pages: Record<Page, { title: string; options: Option[] }> = {
    main: {
      title: 'Add wallet',
      options: [
        {
          icon: 'plus',
          title: 'Create new wallet',
          hint: 'A new wallet on this device',
          onPress: create,
        },
        {
          icon: 'multisig',
          title: 'Create shared wallet',
          hint: 'Needs more than one approval to spend',
          onPress: () => leaveSheetTo('/multisig-new'),
        },
        {
          icon: 'flame',
          title: 'Create burner wallet',
          hint: "For sites you don't fully trust",
          onPress: open('/burner-wallet'),
        },
        {
          icon: 'arrowDown',
          title: 'Import existing wallet',
          hint: 'Recovery phrase or private key',
          onPress: go('import'),
        },
        {
          icon: 'binoculars',
          title: 'Watch an address',
          hint: 'Follow any wallet without spending from it',
          onPress: open('/watch-wallet'),
        },
        {
          icon: 'hardware',
          title: 'Connect hardware wallet',
          hint: 'Ledger or Keystone',
          onPress: go('hardware'),
        },
      ],
    },
    import: {
      title: 'Import existing wallet',
      options: [
        {
          icon: 'recovery',
          title: 'Recovery phrase',
          hint: '12 or 24 words, for every wallet made from it',
          onPress: open({ pathname: '/import-wallet', params: { kind: 'phrase' } }),
        },
        {
          icon: 'key',
          title: 'Private key',
          hint: 'A single wallet',
          onPress: open({ pathname: '/import-wallet', params: { kind: 'key' } }),
        },
      ],
    },
    hardware: {
      title: 'Connect hardware wallet',
      options: [
        {
          icon: 'hardware',
          title: 'Ledger',
          hint: 'Pair your Ledger over Bluetooth',
          onPress: open({ pathname: '/hardware-wallet', params: { device: 'ledger' } }),
        },
        {
          icon: 'qr',
          title: 'Keystone',
          hint: 'Scan your Keystone to connect',
          onPress: open({ pathname: '/hardware-wallet', params: { device: 'keystone' } }),
        },
      ],
    },
  };

  const current = pages[page];
  return (
    <SheetScreen>
      <ContentSwap id={page} index={ORDER.indexOf(page)}>
        <SheetHeader title={current.title} onBack={page === 'main' ? undefined : go('main')} />
        {current.options.map((o) => (
          <OptionRow key={o.title} option={o} />
        ))}
      </ContentSwap>
    </SheetScreen>
  );
}

function OptionRow({ option: o }: { option: Option }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <SheetRow
      title={o.title}
      subtitle={o.hint}
      leading={
        <View style={styles.icon}>
          <Icon name={o.icon} size={19} color={c.accentText} />
        </View>
      }
      accessory="chevron"
      onPress={() => {
        tap();
        o.onPress();
      }}
    />
  );
}

const useStyles = makeStyles((c) => ({
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
