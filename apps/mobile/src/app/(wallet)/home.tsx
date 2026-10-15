import { type Href, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap, Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import {
  BalanceAmount,
  EmptyState,
  HeaderIconButton,
  LabeledDivider,
  Sparkline,
  TokenIcon,
  TokenRow,
} from '@/components/wallet/parts';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import {
  BALANCE,
  BALANCE_CHANGE,
  BALANCE_HISTORY,
  formatUsd,
  handleFor,
  shortAddress,
  TOKENS,
} from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, LAYOUT_MOVE, lazy } from '@/theme/motion';

const ACTIONS: { label: string; icon: IconName; href: Href }[] = [
  { label: 'Send', icon: 'send', href: '/send' },
  { label: 'Receive', icon: 'receive', href: '/receive' },
  { label: 'Buy', icon: 'buy', href: '/buy' },
  { label: 'Sell', icon: 'sell', href: { pathname: '/buy', params: { mode: 'sell' } } },
];

const SECTIONS = ['Tokens', 'NFTs', 'Positions'] as const;

const tokenHref = (symbol: string): Href => ({ pathname: '/token/[symbol]', params: { symbol } });

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('Tokens');
  const [showHidden, setShowHidden] = useState(false);
  const wallet = useActiveWallet();
  const isMain = wallet.id === 'main';
  const { copied, copy: copyAddress } = useCopy(wallet.address, 'Address copied');

  const changePct = (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;
  const { hideBalance } = useSettings();
  const changeColor = BALANCE_CHANGE < 0 ? c.error : c.success;
  const hidden = TOKENS.filter((t) => t.hidden);
  const visible = TOKENS.filter((t) => !t.hidden);

  const open = (href: Href) => {
    tap();
    router.push(href);
  };

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.root}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
        }}
      >
        <StatusBar style="auto" />

        {/* Profile, wallet switcher and shortcuts */}
        <View style={[styles.row, styles.gutter]}>
          <View style={styles.identity}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Switch wallet"
              scaleTo={0.94}
              onPress={() => open('/wallets')}
            >
              <Swap id={wallet.id} size={48}>
                {isMain ? (
                  <Avatar
                    name={wallet.label}
                    size={48}
                    uri={profile.photo}
                    seed={profile.avatarSeed}
                  />
                ) : (
                  <Avatar name={wallet.label} size={48} seed={wallet.id} />
                )}
              </Swap>
            </PressableScale>
            <View style={styles.flex}>
              <View style={styles.nameRow}>
                <HandleName
                  name={wallet.label}
                  handle={isMain ? handleFor(profile.name) : undefined}
                />
                <PressableScale
                  accessibilityLabel="Switch wallet"
                  hitSlop={10}
                  scaleTo={0.85}
                  onPress={() => open('/wallets')}
                >
                  <Icon name="chevronDown" size={13} color={c.textSecondary} />
                </PressableScale>
              </View>
              <Pressable onPress={copyAddress} hitSlop={6} style={styles.addressRow}>
                <TextSwap text={shortAddress(wallet.address)} style={styles.address} />
                <IconSwap name={copied ? 'check' : 'copy'} size={13} color={c.textSecondary} />
              </Pressable>
            </View>
          </View>
          <View style={styles.shortcuts}>
            <HeaderIconButton
              bare
              icon="bell"
              label="Notifications"
              onPress={() => router.push('/notifications')}
            />
            <HeaderIconButton bare icon="scan" label="Scan" onPress={() => router.push('/scan')} />
            <HeaderIconButton
              bare
              icon="settings"
              label="Settings"
              onPress={() => router.push('/settings')}
            />
          </View>
        </View>

        {/* Balance and today's change */}
        <View style={[styles.row, styles.gutter, styles.balanceRow]}>
          <View style={styles.flex}>
            {/* Tap the balance to hide or show it. */}
            <BalanceAmount style={styles.balance} fractionStyle={styles.cents} />
            <PressableScale
              style={styles.changeRow}
              hitSlop={6}
              scaleTo={0.98}
              onPress={() => open('/portfolio')}
            >
              <Icon name={BALANCE_CHANGE < 0 ? 'down' : 'up'} size={9} color={changeColor} />
              <Text style={styles.changeText}>
                <Text style={styles.changeAmount}>
                  {hideBalance ? HIDDEN_AMOUNT : formatUsd(Math.abs(BALANCE_CHANGE))} (
                  {Math.abs(changePct).toFixed(2)}%)
                </Text>{' '}
                today
              </Text>
              <Icon name="chevronRight" size={11} color={c.textSecondary} />
            </PressableScale>
          </View>
          <PressableScale
            accessibilityLabel="Portfolio"
            scaleTo={0.97}
            onPress={() => open('/portfolio')}
          >
            <Sparkline data={BALANCE_HISTORY} width={116} height={60} />
          </PressableScale>
        </View>

        {/* Send / Receive / Buy / Sell */}
        <View style={[styles.actions, styles.gutter]}>
          {ACTIONS.map((action) => (
            <PressableScale
              key={action.label}
              accessibilityRole="button"
              onPress={() => open(action.href)}
              style={styles.action}
            >
              <Icon name={action.icon} size={22} color={c.accentText} />
              <Text style={styles.actionLabel}>{action.label}</Text>
            </PressableScale>
          ))}
        </View>

        {/* Promoted feature */}
        <PressableScale
          onPress={() => open({ pathname: '/earn/[symbol]', params: { symbol: 'USDC' } })}
          scaleTo={0.98}
          style={[styles.promo, styles.gutterMargin]}
        >
          <Text style={styles.promoText}>
            Earn with a <Text style={styles.promoAccent}>Honey Jar</Text>
          </Text>
          <View style={styles.coins}>
            {TOKENS.slice(0, 3).map((t, i) => (
              <View key={t.symbol} style={[styles.coin, i > 0 && styles.coinOverlap]}>
                <TokenIcon symbol={t.symbol} size={26} />
              </View>
            ))}
          </View>
          <Icon name="chevronRight" size={13} color={c.textSecondary} />
        </PressableScale>

        {/* Tokens / NFTs / Positions */}
        <View style={[styles.sections, styles.gutter]}>
          {SECTIONS.map((name) => (
            <PressableScale
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === name }}
              hitSlop={8}
              onPress={() => {
                tap();
                setSection(name);
              }}
            >
              <Text style={[styles.section, section === name && styles.sectionActive]}>{name}</Text>
            </PressableScale>
          ))}
        </View>

        <ContentSwap id={section} index={SECTIONS.indexOf(section)}>
          <View style={styles.gutter}>
            {section === 'Tokens' && (
              <>
                {visible.map((token) => (
                  <TokenRow
                    key={token.symbol}
                    token={token}
                    onPress={() => open(tokenHref(token.symbol))}
                  />
                ))}
                {hidden.length > 0 && (
                  <>
                    <LabeledDivider
                      label={`Hidden tokens (${hidden.length})`}
                      open={showHidden}
                      onPress={() => setShowHidden((v) => !v)}
                    />
                    {/* Bleeds with the rows so the accordion doesn't clip their highlight. */}
                    <View style={styles.bleed}>
                      <Accordion open={showHidden}>
                        <View style={styles.gutter}>
                          {hidden.map((token) => (
                            <TokenRow
                              key={token.symbol}
                              token={token}
                              onPress={() => open(tokenHref(token.symbol))}
                            />
                          ))}
                        </View>
                      </Accordion>
                    </View>
                  </>
                )}
              </>
            )}
            {section === 'NFTs' && (
              <EmptyState
                icon="image"
                title="No NFTs yet"
                hint="Collectibles you own will show up here."
              />
            )}
            {section === 'Positions' && (
              <EmptyState
                icon="layers"
                title="No open positions"
                hint="Liquidity and staking positions will show up here."
              />
            )}
          </View>
        </ContentSwap>
      </ScrollView>
      {/* Keeps scrolled content from running under the status bar. */}
      <View style={[styles.statusCover, { height: insets.top }]} />
    </View>
  );
}

const handleIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: -6 }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);
const handleOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1 },
    100: { opacity: 0, easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

/**
 * The wallet name. Tapping it reveals the Honey handle suffix (like Uniswap's
 * ".uni.eth"): the suffix slides in while the row eases to its new width, then
 * tucks away again after a few seconds.
 */
function HandleName({ name, handle }: { name: string; handle?: string }) {
  const styles = useStyles();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), 4000);
    return () => clearTimeout(timer);
  }, [shown]);
  const suffix = handle?.slice(name.trim().length) ?? '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={handle ? `${name}, show handle` : name}
      disabled={!handle}
      hitSlop={6}
      onPress={() => {
        tap();
        setShown((v) => !v);
      }}
      style={styles.handlePress}
    >
      <Animated.View layout={LAYOUT_MOVE} style={styles.handleRow}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {shown && suffix ? (
          <Animated.Text
            entering={handleIn()}
            exiting={handleOut()}
            style={[styles.name, styles.handle]}
          >
            {suffix}
          </Animated.Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  gutter: {
    paddingHorizontal: 18,
  },
  bleed: {
    marginHorizontal: -18,
  },
  gutterMargin: {
    marginHorizontal: 18,
  },
  flex: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: c.canvas,
  },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    flexShrink: 1,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  handlePress: {
    flexShrink: 1,
  },
  handleRow: {
    flexDirection: 'row',
  },
  handle: {
    color: c.textSecondary,
  },
  addressRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
  },
  address: {
    color: c.textSecondary,
    fontSize: 15,
  },
  shortcuts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  balanceRow: {
    marginTop: 16,
    alignItems: 'flex-end',
  },
  balance: {
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
  },
  cents: {
    color: c.textSecondary,
  },
  changeRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
  },
  changeAmount: {
    color: c.text,
    opacity: 0.85,
  },
  changeText: {
    color: c.textSecondary,
    fontSize: 15,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 8,
  },
  action: {
    flex: 1,
    height: 82,
    padding: 12,
    borderRadius: 18,
    justifyContent: 'space-between',
    backgroundColor: c.accentSurface,
  },
  actionLabel: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '500',
  },
  promo: {
    // A solid card on the page, like every other card (no outline).
    marginTop: 12,
    height: 56,
    paddingHorizontal: 16,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.card,
  },
  promoText: {
    flex: 1,
    color: c.text,
    fontSize: 15,
  },
  promoAccent: {
    color: c.accentText,
    fontWeight: '500',
  },
  coins: {
    flexDirection: 'row',
  },
  coin: {
    borderRadius: 15,
    borderWidth: 2,
    borderColor: c.canvas,
  },
  coinOverlap: {
    marginLeft: -9,
  },
  sections: {
    marginTop: 22,
    marginBottom: 4,
    flexDirection: 'row',
    gap: 20,
  },
  section: {
    color: c.textSecondary,
    fontSize: 17,
    fontWeight: '500',
  },
  sectionActive: {
    color: c.text,
  },
}));
