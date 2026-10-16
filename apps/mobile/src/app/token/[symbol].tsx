import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ActionMenu } from '@/components/motion/ActionMenu';
import { LikeButton } from '@/components/motion/LikeButton';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PopoverMenu } from '@/components/motion/PopoverMenu';
import { PressableScale } from '@/components/motion/PressableScale';
import { RESIZE } from '@/components/motion/resize';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { ACTION_FOOTER_HEIGHT, ActionFooter } from '@/components/wallet/ActionFooter';
import { Description } from '@/components/wallet/Description';
import { PriceChart } from '@/components/wallet/PriceChart';
import { Change, EmptyState, PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { StatRow } from '@/components/wallet/Sheet';
import { toggleFavorite, useFavorites } from '@/lib/favorites';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  CHAINS,
  chainSymbol,
  formatCompactUsd,
  formatPrice,
  formatUsd,
  MARKET,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
  TOKEN_INFO,
  VAULTS,
} from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';
import { LAYOUT_MOVE } from '@/theme/motion';

const CHART_HEIGHT = 230;

export default function TokenScreen() {
  const { symbol = 'ETH' } = useLocalSearchParams<{ symbol: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const c = useTheme();
  const favorites = useFavorites();

  const market = MARKET.find((t) => t.symbol === symbol);
  const info = TOKEN_INFO[symbol];
  // What the wallet in use holds: none for a new wallet, its own for a shared one.
  const view = useWalletView();
  const held = view.tokens.find((t) => t.symbol === symbol && t.amount > 0);
  const vault = VAULTS[symbol];

  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const loading = useFirstLoad(LOADS.token(symbol));
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!market) {
    return (
      <PushedScreen title={held?.name ?? symbol} contentStyle={styles.gutter}>
        {held && (
          <>
            <Text style={styles.label}>Your balance</Text>
            <Text style={styles.balance}>
              {formatUsd(held.usd)}{' '}
              <Text style={styles.balanceAmount}>
                {held.amount.toLocaleString('en-US')} {symbol}
              </Text>
            </Text>
          </>
        )}
        <EmptyState
          icon="warning"
          title="No market data"
          hint={`Honey doesn't have prices for ${symbol} yet. It's hidden from your balance.`}
        />
      </PushedScreen>
    );
  }

  const data = series(symbol, range, market.price, range === '1D' ? market.change : undefined);
  const shown = scrub === null ? market.price : data[scrub];
  const change = ((shown - data[0]) / data[0]) * 100;

  return (
    <PushedScreen
      title={
        <>
          <TokenIcon symbol={symbol} size={18} />
          <Text style={styles.headerSymbol}>{symbol}</Text>
        </>
      }
      right={
        <>
          <ActionMenu
            bare
            actions={[
              {
                label: 'Share',
                icon: 'link',
                onPress: () => router.push({ pathname: '/share-token', params: { symbol, range } }),
              },
              ...(info
                ? [
                    {
                      label: `View on ${info.explorer.label}`,
                      icon: 'globe' as const,
                      onPress: () => Linking.openURL(info.explorer.url),
                    },
                  ]
                : []),
              {
                label: 'Hide token',
                icon: 'eyeSlash',
                onPress: () => showToast(`${symbol} hidden from your balance`),
              },
            ]}
          />
          <LikeButton liked={favorites.includes(symbol)} onToggle={() => toggleFavorite(symbol)} />
        </>
      }
      // More actions open above the grid button; the frame draws the overlay under
      // the footer, so the button stays on top and can swap to ✕.
      overlay={
        <PopoverMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          bottom={insets.bottom + ACTION_FOOTER_HEIGHT + 10}
          right={20}
          actions={[
            { label: 'Send', icon: 'send', onPress: () => router.push('/send') },
            { label: 'Receive', icon: 'qr', onPress: () => router.push('/receive') },
            {
              label: 'Buy with cash',
              icon: 'bank',
              onPress: () => router.push({ pathname: '/buy', params: { symbol } }),
            },
            {
              label: 'Sell for cash',
              icon: 'arrowUpCircle',
              onPress: () => router.push({ pathname: '/buy', params: { symbol, mode: 'sell' } }),
            },
          ]}
        />
      }
      footer={
        <ActionFooter
          actions={[
            {
              label: 'Buy',
              tone: 'primary',
              onPress: () => router.push({ pathname: '/buy', params: { symbol } }),
            },
            {
              label: 'Sell',
              tone: 'secondary',
              onPress: () => router.push({ pathname: '/buy', params: { symbol, mode: 'sell' } }),
            },
          ]}
          menu={{ open: menuOpen, onToggle: () => setMenuOpen((o) => !o) }}
        />
      }
    >
      {/* Price, following the finger while scrubbing */}
      <View style={styles.gutter}>
        <Text style={styles.name}>{market.name}</Text>
        {/* Pops in when it loads; follows the finger without replaying while scrubbing. */}
        {scrub === null ? (
          <NumberPopIn value={formatPrice(shown)} style={styles.price} />
        ) : (
          <Text style={styles.price}>{formatPrice(shown)}</Text>
        )}
        <View style={styles.changeRow}>
          <Change value={change} />
          <TextSwap text={scrub === null ? RANGE_LABEL[range] : ''} style={styles.changeLabel} />
        </View>
      </View>

      <SkeletonReveal loading={loading} skeleton={<SkeletonChart height={CHART_HEIGHT} />}>
        <PriceChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
      </SkeletonReveal>
      <View style={styles.ranges}>
        <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
      </View>

      {/* Your balance and where it lives */}
      {held && info && (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.label}>Your balance</Text>
          <Text style={styles.balance}>
            {formatUsd(held.usd)}{' '}
            <Text style={styles.balanceAmount}>
              {held.amount} {symbol}
            </Text>
          </Text>
          {/* One chain would only repeat the balance above. A shared wallet lives on one
              network, and these per-chain figures are your own wallet's. */}
          {info.holdings.length > 1 && !view.multisig && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showBreakdown }}
                onPress={() => {
                  tap();
                  setShowBreakdown((v) => !v);
                }}
                style={styles.breakdownHeader}
              >
                <Text style={styles.label}>Breakdown</Text>
                <AccordionChevron open={showBreakdown} size={12} color={c.textSecondary} />
              </Pressable>
              <Accordion open={showBreakdown}>
                {info.holdings.map((h) => (
                  <View key={h.chain} style={styles.holding}>
                    <TokenIcon symbol={chainSymbol(h.chain)} size={22} />
                    <Text style={styles.holdingUsd}>{formatUsd(h.usd)}</Text>
                    <Text style={styles.holdingChain}>{h.chain}</Text>
                    <Text style={styles.holdingAmount}>{h.amount}</Text>
                  </View>
                ))}
              </Accordion>
            </>
          )}
        </View>
      )}

      {/* Earn banner */}
      {/* Glides with the Breakdown above as it opens and closes. */}
      {vault && (
        <Animated.View layout={RESIZE}>
          <PressableScale
            scaleTo={0.98}
            onPress={() => {
              tap();
              router.push({ pathname: '/earn/[symbol]', params: { symbol } });
            }}
            style={[styles.earn, styles.gutterMargin]}
          >
            <View style={styles.earnIcon}>
              <Icon name="sparkles" size={18} color={c.accentText} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.earnTitle}>
                Earn <Text style={styles.accent}>{vault.apy.toFixed(2)}% APY</Text> on your {symbol}
              </Text>
              <Text style={styles.earnHint}>No lockup. Withdraw any time.</Text>
            </View>
            <Icon name="chevronRight" size={13} color={c.textSecondary} />
          </PressableScale>
        </Animated.View>
      )}

      {/* Performance */}
      {held && info && !view.multisig && (
        <Animated.View layout={RESIZE} style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Performance (all time)</Text>
          {/* The labels are ours; only the values wait, so the rows keep their height. */}
          <SkeletonReveal
            loading={loading}
            skeleton={PERFORMANCE_LABELS.map((label) => (
              <StatRow key={label} label={label} value={<SkeletonBar width={72} />} />
            ))}
          >
            <StatRow label="Average cost" value={formatPrice(info.performance.averageCost)} />
            <StatRow
              label="Unrealized return"
              value={<Signed value={info.performance.unrealized} />}
            />
            <StatRow label="Realized return" value={<Signed value={info.performance.realized} />} />
            <StatRow
              label="Total return"
              value={<Signed value={info.performance.unrealized + info.performance.realized} />}
            />
          </SkeletonReveal>
        </Animated.View>
      )}

      {/* About */}
      {info && (
        <Animated.View layout={LAYOUT_MOVE} style={[styles.section, styles.gutter]}>
          <Description title={`About ${market.name}`} text={info.about} loading={loading} />
        </Animated.View>
      )}

      {/* Stats */}
      {info && (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Stats</Text>
          <SkeletonReveal
            loading={loading}
            skeleton={STAT_LABELS.map(({ icon, label }) => (
              <StatRow
                key={label}
                icon={<Icon name={icon} size={15} color={c.textSecondary} />}
                label={label}
                value={<SkeletonBar width={72} />}
              />
            ))}
          >
            <Stat icon="pie" label="Market cap" value={formatCompactUsd(market.marketCap)} />
            <Stat
              icon="layers"
              label="Fully diluted valuation"
              value={formatCompactUsd(info.fdv)}
            />
            <Stat icon="chart" label="24h volume" value={formatCompactUsd(market.volume)} />
            <Stat icon="trendUp" label="52W high" value={formatPrice(info.high52)} />
            <Stat icon="trendDown" label="52W low" value={formatPrice(info.low52)} />
            <Stat
              icon="globe"
              label="Network"
              value={CHAINS.find((ch) => ch.name === market.chain)?.name ?? market.chain}
            />
          </SkeletonReveal>
        </View>
      )}

      {/* Links */}
      {info && (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Links</Text>
          <View style={styles.links}>
            <LinkPill icon="globe" label="Website" url={info.website} />
            <LinkPill icon="link" label={info.explorer.label} url={info.explorer.url} />
          </View>
        </View>
      )}
    </PushedScreen>
  );
}

/** A dollar amount with a coloured up/down triangle, e.g. ▼ $3.73. */
function Signed({ value }: { value: number }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.signed}>
      {value !== 0 && (
        <Icon name={value < 0 ? 'down' : 'up'} size={9} color={value < 0 ? c.error : c.success} />
      )}
      <Text style={styles.statValue}>{formatUsd(Math.abs(value))}</Text>
    </View>
  );
}

const PERFORMANCE_LABELS = ['Average cost', 'Unrealized return', 'Realized return', 'Total return'];

/** The Stats rows' icons and labels, for the skeleton (keep in step with the rows above). */
const STAT_LABELS: { icon: IconName; label: string }[] = [
  { icon: 'pie', label: 'Market cap' },
  { icon: 'layers', label: 'Fully diluted valuation' },
  { icon: 'chart', label: '24h volume' },
  { icon: 'trendUp', label: '52W high' },
  { icon: 'trendDown', label: '52W low' },
  { icon: 'globe', label: 'Network' },
];

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const c = useTheme();
  return (
    <StatRow
      icon={<Icon name={icon} size={15} color={c.textSecondary} />}
      label={label}
      value={value}
    />
  );
}

function LinkPill({ icon, label, url }: { icon: IconName; label: string; url: string }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      onPress={() => {
        tap();
        Linking.openURL(url);
      }}
      style={styles.link}
    >
      <Icon name={icon} size={15} color={c.text} />
      <Text style={styles.linkLabel}>{label}</Text>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  gutter: {
    paddingHorizontal: 20,
  },
  gutterMargin: {
    marginHorizontal: 20,
  },
  // A quiet ticker, as in Uniswap; the full name and price below carry the page.
  headerSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  name: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  price: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    letterSpacing: -0.6,
  },
  changeRow: {
    marginTop: 2,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 28,
  },
  label: {
    color: c.textSecondary,
    fontSize: 16,
  },
  heading: {
    marginBottom: 10,
    color: c.textSecondary,
    fontSize: 15,
  },
  balance: {
    marginTop: 4,
    color: c.text,
    fontSize: 26,
    fontWeight: '500',
  },
  balanceAmount: {
    color: c.textSecondary,
    fontSize: 17,
  },
  breakdownHeader: {
    marginTop: 18,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  holding: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  holdingUsd: {
    color: c.text,
    fontSize: 16,
  },
  holdingChain: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  holdingAmount: {
    color: c.textSecondary,
    fontSize: 15,
  },
  earn: {
    // A solid card on the page, like every other card (no outline).
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: c.card,
  },
  earnIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  earnTitle: {
    color: c.text,
    fontSize: 15,
  },
  earnHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
  accent: {
    color: c.accentText,
    fontWeight: '500',
  },
  signed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    color: c.text,
    fontSize: 16,
  },
  links: {
    flexDirection: 'row',
    gap: 8,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: c.raised,
  },
  linkLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
}));
