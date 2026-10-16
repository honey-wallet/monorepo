import { type Href, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  Keyframe,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { FinishSetupCard, FundWalletCard } from '@/components/home/ActivationCard';
import {
  ApprovalsNudge,
  CARD_ICON,
  SharedWalletCard,
  useApprovalsNudgeShown,
} from '@/components/home/ApprovalsCard';
import { NftGallery } from '@/components/home/NftGallery';
import { TradesList, useHasTrades } from '@/components/home/PositionsList';
import { Icon, type IconName } from '@/components/Icon';
import { HoneyJar } from '@/components/logo/HoneyJar';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap, Swap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { Entrance, Rise } from '@/components/motion/Rise';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonList,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { Sticky, StickyArea } from '@/components/motion/Sticky';
import { SwipeDismiss } from '@/components/motion/SwipeDismiss';
import { TextSwap } from '@/components/motion/TextSwap';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
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
import { LOADS } from '@/lib/loads';
import { BALANCE_HISTORY, EARN, formatUsd, handleFor, shortAddress } from '@/lib/mock-wallet';
import { useMultisig, useNeedsMyApproval } from '@/lib/multisig';
import { useUnreadNotifications } from '@/lib/notifications';
import { setupComplete, useOnboarding } from '@/lib/onboarding';
import { useProfile } from '@/lib/profile';
import { HIDDEN_AMOUNT, updateSettings, useSettings } from '@/lib/settings';
import { useTabReselect } from '@/lib/tab-reselect';
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

const SECTIONS = ['Tokens', 'NFTs', 'Trades'] as const;

/** The tokens a Honey Jar earns on, best rate first. */
const EARN_BY_RATE = [...EARN].sort((a, b) => b.apy - a.apy);

const tokenHref = (symbol: string): Href => ({ pathname: '/token/[symbol]', params: { symbol } });

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('Tokens');
  const [promoOpen, setPromoOpen] = useState(false);
  // Earning lives on Savings; Home is balance, actions and what you hold, plus open
  // trades (the thing you check most), but only when there are some.
  const hasTrades = useHasTrades();
  const [showHidden, setShowHidden] = useState(false);
  const unread = useUnreadNotifications();
  const wallet = useActiveWallet();
  const isMain = wallet.id === 'main';
  const multisig = useMultisig(wallet.id);
  // Each wallet's balances arrive once; switching back to one shows them straight away.
  const loading = useFirstLoad(LOADS.balances(wallet.id));
  // The bell also lights up while a shared wallet is waiting for your approval.
  const needsMe = useNeedsMyApproval();
  const { copied, copy: copyAddress } = useCopy(wallet.address, 'Address copied');

  // The wallet in use: a shared wallet shows its own balances.
  const view = useWalletView();
  // A new wallet that hasn't had its first deposit yet.
  const empty = !!view.empty;
  // A new wallet has no trades yet, whatever the demo data says.
  const sections = SECTIONS.filter((s) => s !== 'Trades' || (hasTrades && !empty));
  // Switching to a shared wallet (which can't trade) hides Trades; fall back to Tokens.
  const shownSection = sections.includes(section) ? section : 'Tokens';
  // The promo lists Honey Jar rates, which come with Savings' Earn rates.
  const ratesLoading = useFirstLoad(LOADS.earnRates);
  const onboarding = useOnboarding();
  const nudgeShown = useApprovalsNudgeShown();
  const changePct = view.usd ? (view.change / (view.usd - view.change)) * 100 : 0;
  const { hideBalance, earnPromo } = useSettings();
  // Between the actions and the tabs, Home shows at most two cards, by priority:
  // what needs you (approvals), then getting set up (add money / finish setup), then
  // the Earn promo. Anything past two waits until one above it is done or dismissed.
  // Activation and the promo wait for balances: until then it's unknown whether the
  // wallet is empty, and the wrong card would show and then swap.
  const cards = (
    [
      (multisig || nudgeShown) && 'approvals',
      !loading && (empty || (isMain && !setupComplete(onboarding))) && 'activation',
      earnPromo && !loading && !ratesLoading && !empty && 'earn',
    ] as const
  )
    .filter((card): card is 'approvals' | 'activation' | 'earn' => !!card)
    .slice(0, 2);
  const changeColor = view.change < 0 ? c.error : c.success;
  const canvas = c.canvas;
  const divider = c.divider;
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
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Tapping Home again while it's open scrolls back to the top.
  useTabReselect('home', () => scrollRef.current?.scrollTo({ y: 0, animated: true }));
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  // Tied to the scroll 1:1 (no easing), so the swap can't lag the finger.
  const swap = () => {
    'worklet';
    return interpolate(scrollY.value, [SWAP_FROM, SWAP_TO], [0, 1], Extrapolation.CLAMP);
  };
  const addressShown = useAnimatedStyle(() => ({
    opacity: 1 - swap(),
    transform: [{ translateY: swap() * -4 }],
  }));
  const balanceShown = useAnimatedStyle(() => ({
    opacity: swap(),
    transform: [{ translateY: (1 - swap()) * 4 }],
  }));
  const pinnedEdge = useAnimatedStyle(() => ({
    borderBottomColor: interpolateColor(
      interpolate(scrollY.value, [0, 12], [0, 1], Extrapolation.CLAMP),
      [0, 1],
      [canvas, divider],
    ),
  }));

  return (
    <Entrance id="home">
      {/* The Tokens · NFTs · Trades row pins under the profile row. */}
      <StickyArea
        scrollY={scrollY}
        top={insets.top + HEADER_TOP + HEADER_ROW + HEADER_BOTTOM}
        style={styles.root}
      >
        <Animated.ScrollView
          ref={scrollRef}
          style={styles.root}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingTop: insets.top + HEADER_TOP,
            paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
          }}
        >
          <StatusBar style="auto" />

          {/* Room for the pinned header row above the balance */}
          <View style={{ height: HEADER_ROW }} />

          {/* Balance and today's change */}
          <Rise index={1}>
            <SkeletonReveal
              loading={loading}
              skeleton={
                <View style={[styles.row, styles.gutter, styles.balanceRow]}>
                  <View style={[styles.flex, styles.balanceSkeleton]}>
                    <SkeletonBar width={190} height={34} radius={10} />
                    <SkeletonBar width={150} height={14} />
                  </View>
                  <View style={styles.sparkSkeleton}>
                    <SkeletonChart height={60} inset={4} />
                  </View>
                </View>
              }
            >
              <View style={[styles.row, styles.gutter, styles.balanceRow]}>
                <View style={styles.flex}>
                  {/* Tap the balance to hide or show it. */}
                  <BalanceAmount style={styles.balance} fractionStyle={styles.cents} />
                  {/* A brand-new wallet has no day to compare with yet. */}
                  {empty ? null : (
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
                  )}
                </View>
                {empty ? null : (
                  <PressableScale
                    accessibilityLabel="Portfolio"
                    scaleTo={0.97}
                    onPress={() => openPortfolio()}
                  >
                    <Sparkline data={BALANCE_HISTORY} width={116} height={60} />
                  </PressableScale>
                )}
              </View>
            </SkeletonReveal>
          </Rise>

          {/* Send / Receive / Buy / Sell, rising one after another. An empty wallet keeps
              them too, so the layout is familiar from day one. */}
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

          {/* At most two cards here, the two that matter most (see `cards` above). A
              shared wallet's members, rule and what's waiting; elsewhere, a nudge if any
              of your shared wallets need you. */}
          {multisig ? (
            cards.includes('approvals') && (
              <Rise index={6} style={styles.gutterMargin}>
                <SharedWalletCard multisig={multisig} />
              </Rise>
            )
          ) : (
            // Mounted while closed, so it opens in once what's waiting has loaded.
            <View style={styles.gutterMargin}>
              <ApprovalsNudge open={cards.includes('approvals')} />
            </View>
          )}

          {/* Activation: an empty wallet is all about the first deposit; once there's
              money, finishing setup earns a fee credit. Gone when both are done. */}
          {/* Picked once balances load, so it opens in rather than shoving the tabs down. */}
          <Accordion open={cards.includes('activation')}>
            <Rise index={6} style={styles.card}>
              {empty ? <FundWalletCard /> : <FinishSetupCard />}
            </Rise>
          </Accordion>

          {/* Promoted feature, as Uniswap's: one slim outlined line that opens into the
              ways to earn. Swipe it away (or Hide it) and it stays gone. */}
          <Rise index={6}>
            <Accordion open={cards.includes('earn')}>
              <SwipeDismiss onDismiss={() => updateSettings({ earnPromo: false })}>
                {(dismiss) => (
                  <View style={[styles.promo, styles.gutterMargin]}>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityState={{ expanded: promoOpen }}
                      scaleTo={0.98}
                      onPress={() => {
                        tap();
                        setPromoOpen((v) => !v);
                      }}
                      style={styles.promoRow}
                    >
                      <View style={styles.promoIcon}>
                        <HoneyJar size={26} />
                      </View>
                      <Text style={styles.promoText}>
                        Earn with a <Text style={styles.promoAccent}>Honey Jar</Text>
                      </Text>
                      {/* Every token a Honey Jar can earn on, best rate first. */}
                      {/* Side by side, as Uniswap's, at the size of the faces above. */}
                      <View style={styles.coins}>
                        {EARN_BY_RATE.map((e, i) => (
                          <View key={e.symbol} style={[styles.coin, i > 0 && styles.coinOverlap]}>
                            <TokenIcon symbol={e.symbol} size={28} />
                          </View>
                        ))}
                      </View>
                      <AccordionChevron open={promoOpen} size={11} color={c.textSecondary} />
                    </PressableScale>
                    <Accordion open={promoOpen}>
                      <View style={styles.promoList}>
                        {EARN_BY_RATE.map((e) => (
                          <PressableRow
                            key={e.symbol}
                            accessibilityRole="button"
                            onPress={() =>
                              open({ pathname: '/earn/[symbol]', params: { symbol: e.symbol } })
                            }
                            style={styles.promoOption}
                          >
                            <TokenIcon symbol={e.symbol} size={28} />
                            <Text style={[styles.flex, styles.promoOptionText]}>{e.symbol}</Text>
                            <Text style={styles.promoAccent}>{e.apy.toFixed(2)}% APY</Text>
                            <Icon name="chevronRight" size={12} color={c.textSecondary} />
                          </PressableRow>
                        ))}
                        <PressableScale
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => {
                            tap();
                            dismiss();
                          }}
                          style={styles.promoHide}
                        >
                          <Text style={styles.promoHideText}>Hide this</Text>
                        </PressableScale>
                      </View>
                    </Accordion>
                  </View>
                )}
              </SwipeDismiss>
            </Accordion>
          </Rise>

          {/* Tokens / NFTs / Trades (only with open trades) */}
          <Rise index={7} style={styles.sectionsGap}>
            <Sticky id="sections">
              {/* The same tabs as Trade: the honey underline slides to the one picked. */}
              <View style={[styles.sections, styles.gutter]}>
                <UnderlineTabs options={sections} value={shownSection} onChange={setSection} />
              </View>
            </Sticky>
          </Rise>

          <ContentSwap id={shownSection} index={sections.indexOf(shownSection)}>
            {/* At least a screen's worth below the tabs, so they can always scroll up and
                pin under the profile row, however short the list. */}
            <View
              style={[
                styles.gutter,
                {
                  minHeight:
                    screenHeight -
                    (insets.top + HEADER_TOP + HEADER_ROW + HEADER_BOTTOM) -
                    TABS_ROW -
                    (insets.bottom + TAB_BAR_HEIGHT + 24),
                },
              ]}
            >
              {shownSection === 'Tokens' && (
                <SkeletonReveal loading={loading} skeleton={<SkeletonList count={5} />}>
                  {/* A new shared wallet starts empty: say how to fund it. */}
                  {/* A new wallet: the Add money card above is how tokens get here. */}
                  {visible.length === 0 && empty && (
                    <EmptyState
                      icon="receive"
                      title="No tokens yet"
                      hint="Tokens you buy or receive will show up here."
                    />
                  )}
                  {visible.length === 0 && !empty && (
                    <EmptyState
                      icon="receive"
                      title={hidden.length > 0 ? 'Every token is hidden' : 'Nothing here yet'}
                      hint={
                        hidden.length > 0
                          ? 'Open Hidden tokens below to see them.'
                          : multisig
                            ? `Send tokens on ${multisig.network.name} to this wallet's address.`
                            : 'Tokens you receive will show up here.'
                      }
                      action={
                        hidden.length > 0
                          ? undefined
                          : { label: 'Receive', onPress: () => router.push('/receive') }
                      }
                    />
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
                </SkeletonReveal>
              )}
              {/* The demo collectibles and positions belong to your own wallets (shared wallets
                  can't trade, so Trading never shows for them). */}
              {shownSection === 'NFTs' &&
                (multisig || empty ? (
                  <EmptyState
                    icon="image"
                    title="No NFTs yet"
                    hint="Collectibles you own will show up here."
                  />
                ) : (
                  <NftGallery />
                ))}
              {shownSection === 'Trades' && <TradesList />}
            </View>
          </ContentSwap>
        </Animated.ScrollView>
        {/* The profile row stays put while the page scrolls: switching wallets, the bell
            and settings are what this screen is for. It also keeps content from running
            under the status bar; a hairline appears once something is under it. */}
        <Animated.View style={[styles.pinned, { paddingTop: insets.top + HEADER_TOP }, pinnedEdge]}>
          {/* Profile, wallet switcher and shortcuts (above the balance, so tooltips overlap it) */}
          <Rise index={0}>
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
                  {/* The address; once the big balance has scrolled away, the balance
                        takes its place, so the total is never out of sight. */}
                  <View>
                    <Animated.View style={addressShown}>
                      <Pressable onPress={copyAddress} hitSlop={6} style={styles.addressRow}>
                        <TextSwap text={shortAddress(wallet.address)} style={styles.address} />
                        <IconSwap
                          name={copied ? 'check' : 'copy'}
                          size={13}
                          color={c.textSecondary}
                        />
                      </Pressable>
                    </Animated.View>
                    <Animated.Text
                      pointerEvents="none"
                      style={[styles.address, styles.headerBalance, balanceShown]}
                    >
                      {loading ? '' : hideBalance ? HIDDEN_AMOUNT : formatUsd(view.usd)}
                    </Animated.Text>
                  </View>
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
        </Animated.View>
      </StickyArea>
    </Entrance>
  );
}

/** The pinned profile row: space above it (under the status bar), its height, below. */
const HEADER_TOP = 12;
const HEADER_ROW = 48;
const HEADER_BOTTOM = 10;
/** The Tokens · NFTs · Trades row's height. */
const TABS_ROW = 52;
/** Scroll range over which the address under the name turns into the balance, as the
 * big balance passes under the pinned row. */
const SWAP_FROM = 30;
const SWAP_TO = 70;

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
  card: {
    marginTop: 12,
    marginHorizontal: 18,
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
  pinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
    paddingBottom: HEADER_BOTTOM,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: c.canvas,
  },
  headerBalance: {
    position: 'absolute',
    top: 2,
    left: 0,
    color: c.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
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
  // The same footprint as the balance and today's change, so nothing jumps on reveal.
  balanceSkeleton: {
    height: 67,
    justifyContent: 'center',
    gap: 10,
  },
  sparkSkeleton: {
    width: 116,
    height: 60,
    justifyContent: 'center',
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
  // One line that opens into the ways to earn, on the same filled card as the
  // approvals one above it.
  promo: {
    marginTop: 12,
    borderRadius: 20,
    backgroundColor: c.card,
    overflow: 'hidden',
  },
  promoIcon: {
    width: CARD_ICON,
    height: CARD_ICON,
    borderRadius: CARD_ICON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  // Same padding and gap as the approvals card, so the two read as a pair.
  coins: {
    flexDirection: 'row',
  },
  coin: {
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.card,
  },
  coinOverlap: {
    marginLeft: -10,
  },
  promoRow: {
    height: CARD_ICON + 28,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  promoText: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  promoAccent: {
    color: c.honey,
    fontSize: 16,
    fontWeight: '500',
  },
  promoList: {
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.divider,
  },
  promoOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  promoOptionText: {
    color: c.text,
    fontSize: 16,
  },
  promoHide: {
    alignSelf: 'center',
    paddingVertical: 6,
  },
  promoHideText: {
    color: c.textSecondary,
    fontSize: 14,
  },
  // The gap above sits outside the pinned row, so the pinned copy is just the tabs.
  // The tabs carry their own space above the label (46pt rows), so only a little more
  // here keeps the gap above them in step with the 12pt between the cards.
  sectionsGap: {
    marginTop: 4,
  },
  sections: {
    paddingBottom: 8,
  },
}));
