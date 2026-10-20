import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Share, Text, useWindowDimensions, View } from 'react-native';
import { ChartStyleButton } from '@/components/charts/ChartStyleButton';
import { ProbabilityChart } from '@/components/charts/ProbabilityChart';
import { Icon } from '@/components/Icon';
import { LikeButton } from '@/components/motion/LikeButton';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { SkeletonChart, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { ActionFooter } from '@/components/sheets/ActionFooter';
import { Description } from '@/components/sheets/Description';
import { MarketIcon } from '@/components/trade/PredictFeed';
import type { Side } from '@/components/trade/TradeForm';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { EmptyState, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatCompactUsd } from '@/lib/mock-wallet';
import {
  chartLines,
  leadChance,
  marketRules,
  PREDICT_RANGE_LABEL,
  PREDICT_RANGES,
  type PredictMarket,
  type PredictRange,
  predictMarket,
  relatedMarkets,
  toggleSaved,
  useSavedMarkets,
} from '@/lib/predict';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import { formatShare, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles, radius, useTheme } from '@/theme';

const CHART_HEIGHT = 236;
const GUTTER = 20;

/** "<1%" under one percent, as Polymarket writes it; otherwise a whole percentage. */
const pct = (v: number) => (v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

function openOrder(market: PredictMarket, side: Side, outcome?: string) {
  tap();
  router.push({
    pathname: '/predict-order',
    params: { id: market.id, side, ...(outcome ? { outcome } : {}) },
  });
}

/**
 * One prediction market, after Polymarket's market page: what it's asking, the chance
 * (or each answer's) and how it moved, each answer with its Buy Yes / Buy No, the
 * rules, and related markets. A single question keeps Buy Yes / Buy No pinned below.
 */
function PredictMarketScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const c = useTheme();
  const { width } = useWindowDimensions();
  const { predictPrice } = useTradePrefs();
  const saved = useSavedMarkets();
  const [range, setRange] = useState<PredictRange>('All');
  const [scrub, setScrub] = useState<number | null>(null);
  const [stacked, setStacked] = useState(false);
  const market = predictMarket(id);
  // The price history and rules come with the market page; the feed only had the chance.
  const loading = useFirstLoad(LOADS.predict(id));

  if (!market) {
    return (
      <PushedScreen title="Market" fallback="/trade" contentStyle={styles.gutter}>
        <EmptyState
          icon="search"
          title="Market not found"
          hint="It may have closed."
          action={{ label: 'Browse markets', onPress: () => router.replace('/trade') }}
        />
      </PushedScreen>
    );
  }

  const lines = chartLines(market, range);
  const related = relatedMarkets(market);
  const at = (data: number[]) => (scrub === null ? data[data.length - 1] : data[scrub]);
  const price = (p: number) => formatShare(p, predictPrice);
  const isSaved = saved.includes(market.id);
  const sides: [Side, Side] = market.kind === 'updown' ? ['Up', 'Down'] : ['Yes', 'No'];
  const title = market.kind === 'updown' ? `${market.question} ${market.window}` : market.question;

  // The single-line chance, and how far it moved over the range.
  const main = lines[0].data;
  const moved = at(main) - main[0];

  return (
    <PushedScreen
      title={
        <>
          <MarketIcon market={market} size={20} />
          <Text style={styles.headerTitle}>{market.category}</Text>
        </>
      }
      fallback="/trade"
      right={
        <View style={styles.headerActions}>
          <HeaderShortcut
            icon="share"
            label="Share market"
            onPress={() =>
              Share.share({ message: `${title} ${pct(leadChance(market))} on Honey` }).catch(
                () => {},
              )
            }
          />
          <LikeButton liked={isSaved} onToggle={() => toggleSaved(market.id)} size={22} />
        </View>
      }
      footer={
        market.kind === 'multi' ? undefined : (
          <ActionFooter
            actions={[
              {
                label: `Buy ${sides[0]} ${price(market.yes)}`,
                tone: 'up',
                onPress: () => openOrder(market, sides[0]),
              },
              {
                label: `Buy ${sides[1]} ${price(1 - market.yes)}`,
                tone: 'down',
                onPress: () => openOrder(market, sides[1]),
              },
            ]}
          />
        )
      }
    >
      <View style={styles.gutter}>
        {/* What it's asking */}
        <Text style={styles.question}>{title}</Text>

        {/* A single question's chance; a multi-answer market labels its lines instead */}
        {market.kind === 'multi' ? null : (
          <View style={styles.chanceRow}>
            {scrub === null ? (
              <NumberPopIn value={pct(at(main))} style={styles.chance} />
            ) : (
              <Text style={styles.chance}>{pct(at(main))}</Text>
            )}
            <Text style={styles.chanceLabel}>chance</Text>
            {Math.abs(moved) >= 0.005 ? (
              <View style={styles.moved}>
                <Icon
                  name={moved < 0 ? 'down' : 'up'}
                  size={9}
                  color={moved < 0 ? c.error : c.success}
                />
                <Text style={[styles.movedText, { color: moved < 0 ? c.error : c.success }]}>
                  {Math.round(Math.abs(moved) * 100)}%
                </Text>
              </View>
            ) : null}
          </View>
        )}

        {/* Volume and end, with the chart's style at the end of the line above it */}
        <View style={styles.metaRow}>
          <Text style={[styles.flex, styles.kicker]}>
            {formatCompactUsd(market.volume)} Vol.
            {market.kind === 'updown' ? ' · Live' : ` · Ends ${market.ends}`}
          </Text>
          {lines.length > 1 ? (
            <ChartStyleButton
              to={stacked ? 'line' : 'stacked'}
              label={stacked ? 'Show lines' : 'Show each answer’s share'}
              onPress={() => setStacked((s) => !s)}
            />
          ) : null}
        </View>
      </View>

      <View style={styles.chart}>
        <SkeletonReveal
          loading={loading}
          skeleton={<SkeletonChart height={CHART_HEIGHT} inset={0} />}
        >
          <ProbabilityChart
            lines={lines}
            width={width - GUTTER * 2}
            height={CHART_HEIGHT}
            range={range}
            stacked={stacked}
            scrub={scrub}
            onScrub={setScrub}
          />
        </SkeletonReveal>
      </View>

      <View style={styles.ranges}>
        <SegmentedTabs
          bare
          options={PREDICT_RANGES}
          value={range}
          onChange={setRange}
          labels={PREDICT_RANGE_LABEL}
        />
      </View>

      {/* Each answer in one card: its chance, then Yes / No with their prices */}
      {market.kind === 'multi' ? (
        <View style={[styles.gutter, styles.section]}>
          <View style={styles.outcomes}>
            {market.outcomes.map((o, i) => (
              <View key={o.id} style={[styles.outcome, i > 0 && styles.outcomeRule]}>
                <View style={styles.flex}>
                  <Text style={styles.outcomeLabel} numberOfLines={1}>
                    {o.label}
                  </Text>
                  <Text style={styles.outcomeMeta}>
                    {formatCompactUsd(market.volume * (o.yes * 0.8 + 0.08))} Vol.
                  </Text>
                </View>
                <Text style={[styles.outcomePct, o.yes < 0.01 && styles.muted]}>{pct(o.yes)}</Text>
                <BuyButton
                  side="Yes"
                  detail={price(o.yes)}
                  onPress={() => openOrder(market, 'Yes', o.id)}
                />
                <BuyButton
                  side="No"
                  detail={price(1 - o.yes)}
                  onPress={() => openOrder(market, 'No', o.id)}
                />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={[styles.gutter, styles.section]}>
        <Description title="Rules" text={marketRules(market)} loading={loading} />
      </View>

      {/* Nothing related: leave the section out rather than show a label over nothing. */}
      {related.length ? (
        <View style={[styles.gutter, styles.section]}>
          <Text style={styles.sectionLabel}>Related</Text>
          {related.map((m) => (
            <PressableRow
              key={m.id}
              accessibilityRole="button"
              onPress={() => {
                tap();
                router.push({ pathname: '/predict/[id]', params: { id: m.id } });
              }}
              style={styles.related}
            >
              <MarketIcon market={m} size={36} />
              <Text style={[styles.flex, styles.relatedText]} numberOfLines={2}>
                {m.question}
              </Text>
              <Text style={styles.relatedPct}>{pct(leadChance(m))}</Text>
            </PressableRow>
          ))}
        </View>
      ) : null}
    </PushedScreen>
  );
}

/** Yes 87¢ in green, No 14¢ in red, as small tinted pills. */
function BuyButton({ side, detail, onPress }: { side: Side; detail: string; onPress: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const color = side === 'Yes' || side === 'Up' ? c.success : c.error;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Buy ${side} at ${detail}`}
      scaleTo={0.97}
      onPress={onPress}
      style={[styles.buy, { backgroundColor: `${color}1A` }]}
    >
      <Text style={[styles.buyLabel, { color }]} numberOfLines={1}>
        {side} {detail}
      </Text>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  gutter: {
    paddingHorizontal: GUTTER,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  headerTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  metaRow: {
    marginTop: 6,
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  kicker: {
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  question: {
    marginTop: 8,
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 30,
    letterSpacing: -0.3,
  },
  chanceRow: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  chance: {
    color: c.text,
    fontSize: 34,
    fontWeight: '600',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  chanceLabel: {
    color: c.textSecondary,
    fontSize: 17,
  },
  moved: {
    marginLeft: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  movedText: {
    fontSize: 15,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  chart: {
    marginTop: 16,
    paddingHorizontal: GUTTER,
  },
  ranges: {
    marginTop: 10,
    paddingHorizontal: GUTTER - 8,
  },
  outcomes: {
    ...radius(20),
    backgroundColor: c.card,
  },
  outcome: {
    minHeight: 64,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  outcomeRule: {
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  outcomeLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  outcomeMeta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  outcomePct: {
    marginRight: 4,
    color: c.text,
    fontSize: 19,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  muted: {
    color: c.textSecondary,
  },
  buy: {
    width: 76,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buyLabel: {
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  section: {
    marginTop: 28,
  },
  sectionLabel: {
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 15,
  },
  related: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  relatedText: {
    color: c.text,
    fontSize: 15,
    lineHeight: 20,
  },
  relatedPct: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
}));

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PredictMarketRoute() {
  return useTradeModeAllowed('Predict') ? <PredictMarketScreen /> : <Redirect href="/trade" />;
}
