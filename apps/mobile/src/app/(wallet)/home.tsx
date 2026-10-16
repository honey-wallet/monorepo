import { type Href, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  Keyframe,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { AvatarGroup } from '@/components/motion/AvatarGroup';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap, Swap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { Entrance, Rise } from '@/components/motion/Rise';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { ApprovalsNudge, SharedWalletCard } from '@/components/wallet/ApprovalsCard';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import {
  BalanceAmount,
  EmptyState,
  LabeledDivider,
  Sparkline,
  TokenIcon,
  TokenRow,
} from '@/components/wallet/parts';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { BALANCE_HISTORY, formatUsd, handleFor, shortAddress, TOKENS } from '@/lib/mock-wallet';
import { useMultisig, useNeedsMyApproval } from '@/lib/multisig';
import { useUnreadNotifications } from '@/lib/notifications';
import { useProfile } from '@/lib/profile';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { useWalletView } from '@/lib/wallet-view';
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
  const [promoPressed, setPromoPressed] = useState(false);
  const unread = useUnreadNotifications();
  const wallet = useActiveWallet();
  const isMain = wallet.id === 'main';
  const multisig = useMultisig(wallet.id);
  // The bell also lights up while a shared wallet is waiting for your approval.
  const needsMe = useNeedsMyApproval();
  const { copied, copy: copyAddress } = useCopy(wallet.address, 'Address copied');

  // The wallet in use: a shared wallet shows its own balances.
  const view = useWalletView();
  const changePct = view.usd ? (view.change / (view.usd - view.change)) * 100 : 0;
  const { hideBalance } = useSettings();
  const changeColor = view.change < 0 ? c.error : c.success;
  const hidden = view.tokens.filter((t) => t.hidden);
  const visible = view.tokens.filter((t) => !t.hidden);

  const open = (href: Href) => {
    tap();
    router.push(href);
  };

  // A shared wallet's balance details live on its own page.
  const openPortfolio = () =>
    multisig ? open({ pathname: '/multisig/[id]', params: { id: wallet.id } }) : open('/portfolio');

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  return (
    <Entrance id="home">
      <View style={styles.root}>
        <Animated.ScrollView
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
          }}
        >
          <StatusBar style="auto" />

          {/* Profile, wallet switcher and shortcuts (above the balance, so tooltips overlap it) */}
          <Rise index={0} style={styles.header}>
            <View style={[styles.row, styles.gutter]}>
              <View style={styles.identity}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Switch wallet"
                  scaleTo={0.97}
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
                      scaleTo={0.97}
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
                <HeaderShortcut
                  icon="bell"
                  label="Notifications"
                  badge={unread || needsMe.length > 0}
                  onPress={() => router.push('/notifications')}
                />
                <HeaderShortcut icon="scan" label="Scan" onPress={() => router.push('/scan')} />
                <HeaderShortcut
                  icon="settings"
                  label="Settings"
                  onPress={() => router.push('/settings')}
                />
              </View>
            </View>
          </Rise>

          {/* Balance and today's change */}
          <Rise index={1}>
            <View style={[styles.row, styles.gutter, styles.balanceRow]}>
              <View style={styles.flex}>
                {/* Tap the balance to hide or show it. */}
                <BalanceAmount style={styles.balance} fractionStyle={styles.cents} />
                <PressableScale
                  style={styles.changeRow}
                  hitSlop={6}
                  scaleTo={0.98}
                  onPress={() => openPortfolio()}
                >
                  <Icon name={view.change < 0 ? 'down' : 'up'} size={9} color={changeColor} />
                  <Text style={styles.changeText}>
                    <Text style={styles.changeAmount}>
                      {hideBalance ? HIDDEN_AMOUNT : formatUsd(Math.abs(view.change))} (
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
                onPress={() => openPortfolio()}
              >
                <Sparkline data={BALANCE_HISTORY} width={116} height={60} />
              </PressableScale>
            </View>
          </Rise>

          {/* Send / Receive / Buy / Sell, rising one after another */}
          <View style={[styles.actions, styles.gutter]}>
            {ACTIONS.map((action, i) => (
              <Rise key={action.label} index={2 + i} style={styles.flex}>
                <PressableScale
                  accessibilityRole="button"
                  onPress={() => open(action.href)}
                  style={styles.action}
                >
                  <Icon name={action.icon} size={22} color={c.accentText} />
                  <Text style={styles.actionLabel}>{action.label}</Text>
                </PressableScale>
              </Rise>
            ))}
          </View>

          {/* A shared wallet's members, rule and what's waiting; elsewhere, a nudge if any
              of your shared wallets need you. */}
          {multisig ? (
            <Rise index={6} style={styles.gutterMargin}>
              <SharedWalletCard multisig={multisig} />
            </Rise>
          ) : (
            <View style={styles.gutterMargin}>
              <ApprovalsNudge />
            </View>
          )}

          {/* Promoted feature */}
          <Rise index={6}>
            <PressableScale
              onPress={() => open({ pathname: '/earn/[symbol]', params: { symbol: 'USDC' } })}
              onPressIn={() => setPromoPressed(true)}
              onPressOut={() => setPromoPressed(false)}
              scaleTo={0.98}
              style={[styles.promo, styles.gutterMargin]}
            >
              <Text style={styles.promoText}>
                Earn with a <Text style={styles.promoAccent}>Honey Jar</Text>
              </Text>
              {/* The coins lift with a falloff while the row is held. */}
              <AvatarGroup lifted={promoPressed}>
                {TOKENS.slice(0, 3).map((t, i) => (
                  <View key={t.symbol} style={[styles.coin, i > 0 && styles.coinOverlap]}>
                    <TokenIcon symbol={t.symbol} size={26} />
                  </View>
                ))}
              </AvatarGroup>
              <Icon name="chevronRight" size={13} color={c.textSecondary} />
            </PressableScale>
          </Rise>

          {/* Tokens / NFTs / Positions */}
          <Rise index={7}>
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
                  <Text style={[styles.section, section === name && styles.sectionActive]}>
                    {name}
                  </Text>
                </PressableScale>
              ))}
            </View>
          </Rise>

          <ContentSwap id={section} index={SECTIONS.indexOf(section)}>
            <View style={styles.gutter}>
              {section === 'Tokens' && (
                <>
                  {/* A new shared wallet starts empty: say how to fund it. */}
                  {visible.length === 0 && (
                    <>
                      <EmptyState
                        icon="receive"
                        title="Nothing here yet"
                        hint={
                          multisig
                            ? `Send tokens on ${multisig.network.name} to this wallet's address.`
                            : 'Tokens you receive will show up here.'
                        }
                      />
                      <PillButton
                        label="Receive"
                        variant="secondary"
                        onPress={() => open('/receive')}
                      />
                    </>
                  )}
                  {visible.map((token, i) => (
                    <Rise key={token.symbol} index={8 + i}>
                      <TokenRow token={token} onPress={() => open(tokenHref(token.symbol))} />
                    </Rise>
                  ))}
                  {hidden.length > 0 && (
                    <Rise index={8 + visible.length}>
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
                    </Rise>
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
        </Animated.ScrollView>
        {/* Keeps scrolled content from running under the status bar. */}
        <View style={[styles.statusCover, { height: insets.top }]} />
        <CompactBalance scrollY={scrollY} top={insets.top} />
      </View>
    </Entrance>
  );
}

/** Scroll distance over which the compact balance fades in, as the big one passes under the status bar. */
const COMPACT_FROM = 70;
const COMPACT_TO = 110;

/**
 * Once the big balance scrolls away, a slim bar with the total settles in at the top
 * (fading in and dropping the last 4px), so the number is never out of sight. It
 * follows the scroll directly, so it can't lag the finger.
 */
function CompactBalance({
  scrollY,
  top,
}: {
  scrollY: ReturnType<typeof useSharedValue<number>>;
  top: number;
}) {
  const styles = useStyles();
  const { hideBalance } = useSettings();
  const { usd } = useWalletView();
  const shown = useAnimatedStyle(() => {
    const p = interpolate(scrollY.value, [COMPACT_FROM, COMPACT_TO], [0, 1], Extrapolation.CLAMP);
    return { opacity: p };
  });
  const content = useAnimatedStyle(() => {
    const p = interpolate(scrollY.value, [COMPACT_FROM, COMPACT_TO], [0, 1], Extrapolation.CLAMP);
    return { transform: [{ translateY: (1 - p) * -4 }] };
  });
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.compact, { paddingTop: top, height: top + COMPACT_BAR }, shown]}
    >
      <Animated.Text style={[styles.compactAmount, content]}>
        {hideBalance ? HIDDEN_AMOUNT : formatUsd(usd)}
      </Animated.Text>
    </Animated.View>
  );
}

const COMPACT_BAR = 40;

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
  compact: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.canvas,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  compactAmount: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
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
  header: {
    zIndex: 2,
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
