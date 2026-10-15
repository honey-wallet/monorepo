import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { Swap } from '@/components/motion/IconSwap';
import { MenuDropdown, type MenuOption } from '@/components/motion/MenuDropdown';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { Chip } from '@/components/wallet/Chip';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { Change, EmptyState, NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { TabScreen } from '@/components/wallet/TabScreen';
import { toggleFavorite, useFavorites } from '@/lib/favorites';
import { tap } from '@/lib/haptics';
import {
  CHAINS,
  type Chain,
  EARN,
  formatCompactUsd,
  formatPrice,
  MARKET,
  type MarketToken,
} from '@/lib/mock-wallet';
import { type SearchSort, useSectionPrefs } from '@/lib/section-prefs';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, LAYOUT_MOVE, lazy } from '@/theme/motion';

type Sort = SearchSort;

const SORTS: MenuOption<Sort>[] = [
  { value: 'volume', label: 'Volume (24H)', icon: 'chart' },
  { value: 'marketCap', label: 'Market cap', icon: 'pie' },
  { value: 'gainers', label: 'Price increase (24H)', icon: 'trendUp' },
  { value: 'losers', label: 'Price decrease (24H)', icon: 'trendDown' },
];

const SORT_LABEL: Record<Sort, string> = {
  volume: 'Volume',
  marketCap: 'Market cap',
  gainers: 'Gainers',
  losers: 'Losers',
};

const COMPARE: Record<Sort, (a: MarketToken, b: MarketToken) => number> = {
  volume: (a, b) => b.volume - a.volume,
  marketCap: (a, b) => b.marketCap - a.marketCap,
  gainers: (a, b) => b.change - a.change,
  losers: (a, b) => a.change - b.change,
};

const CHAIN_ORDER: (Chain | 'All')[] = ['All', ...CHAINS.map((ch) => ch.name)];

function openToken(symbol: string) {
  tap();
  router.push({ pathname: '/token/[symbol]', params: { symbol } });
}

const removeOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: 0.9 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

/** Search, after Uniswap: favourites, stablecoins and top tokens until you type. */
export default function SearchScreen() {
  const styles = useStyles();
  const c = useTheme();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const favorites = useFavorites();
  // Start from Search settings, and follow them when they change.
  const prefs = useSectionPrefs();
  const [chain, setChain] = useState<Chain | 'All'>(prefs.searchNetwork ?? 'All');
  const [sort, setSort] = useState<Sort>(prefs.searchSort);
  useEffect(() => setChain(prefs.searchNetwork ?? 'All'), [prefs.searchNetwork]);
  useEffect(() => setSort(prefs.searchSort), [prefs.searchSort]);
  const q = query.trim().toLowerCase();

  const results = MARKET.filter(
    (t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q),
  );
  const top = MARKET.filter((t) => chain === 'All' || t.chain === chain).sort(COMPARE[sort]);

  return (
    <TabScreen>
      <View style={styles.top}>
        <View style={styles.flex}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search tokens" />
        </View>
        <HeaderActions
          settingsLabel="Search settings"
          onSettings={() =>
            router.push({ pathname: '/section-settings', params: { section: 'search' } })
          }
        />
      </View>

      <ContentSwap id={q ? 'results' : 'browse'}>
        {q ? (
          <View style={styles.section}>
            {results.map((token) => (
              <MarketRow key={token.symbol} token={token} />
            ))}
            {results.length === 0 && (
              <EmptyState
                icon="search"
                title="No matches"
                hint={`Nothing found for “${query.trim()}”.`}
              />
            )}
          </View>
        ) : (
          <>
            {prefs.searchShowFavorites && (
              <>
                <View style={[styles.header, styles.section]}>
                  <TextSwap
                    text={editing ? 'Edit favorite tokens' : 'Favorite tokens'}
                    style={styles.heading}
                  />
                  <PressableScale
                    accessibilityLabel={editing ? 'Done editing' : 'Edit favorites'}
                    hitSlop={10}
                    scaleTo={0.9}
                    onPress={() => {
                      tap();
                      setEditing((v) => !v);
                    }}
                  >
                    {editing ? (
                      <Text style={styles.done}>Done</Text>
                    ) : (
                      <Text style={styles.more}>•••</Text>
                    )}
                  </PressableScale>
                </View>
                <View style={styles.favorites}>
                  {favorites
                    .map((symbol) => MARKET.find((t) => t.symbol === symbol))
                    .filter((token): token is MarketToken => Boolean(token))
                    .map((token) => (
                      <Animated.View
                        key={token.symbol}
                        exiting={removeOut()}
                        layout={LAYOUT_MOVE}
                        style={styles.favoriteCell}
                      >
                        <PressableScale
                          disabled={editing}
                          onPress={() => openToken(token.symbol)}
                          style={styles.favorite}
                        >
                          <View style={styles.favoriteName}>
                            <TokenIcon symbol={token.symbol} size={22} />
                            <Text style={styles.favoriteSymbol}>{token.symbol}</Text>
                          </View>
                          <Text style={styles.favoritePrice} numberOfLines={1}>
                            {formatPrice(token.price)}
                          </Text>
                          <Change value={token.change} size={15} />
                        </PressableScale>
                        {editing && (
                          <PressableScale
                            accessibilityLabel={`Remove ${token.symbol} from favorites`}
                            hitSlop={8}
                            scaleTo={0.85}
                            onPress={() => {
                              tap();
                              toggleFavorite(token.symbol);
                            }}
                            style={styles.remove}
                          >
                            <Swap id="remove" size={22}>
                              <Icon name="minusCircle" size={22} color={c.textSecondary} />
                            </Swap>
                          </PressableScale>
                        )}
                      </Animated.View>
                    ))}
                </View>
                {favorites.length === 0 && (
                  <EmptyState
                    icon="heart"
                    title="No favorites yet"
                    hint="Tap the heart on any token to keep it here."
                  />
                )}
              </>
            )}

            {prefs.searchShowEarn && (
              <>
                <Text style={[styles.heading, styles.section]}>Start earning</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.bleed}
                  contentContainerStyle={styles.carousel}
                >
                  {EARN.map(({ symbol, apy }) => (
                    <PressableScale
                      key={symbol}
                      onPress={() => {
                        tap();
                        router.push({ pathname: '/earn/[symbol]', params: { symbol } });
                      }}
                      style={styles.stable}
                    >
                      <TokenIcon symbol={symbol} size={40} />
                      <View>
                        <Text style={styles.stableSymbol}>{symbol}</Text>
                        <Text style={styles.stableMeta}>{apy.toFixed(2)}% APY</Text>
                      </View>
                    </PressableScale>
                  ))}
                </ScrollView>
              </>
            )}

            <View style={[styles.header, styles.section]}>
              <Text style={styles.heading}>Top tokens</Text>
              <MenuDropdown
                options={SORTS}
                value={sort}
                onChange={setSort}
                triggerLabel={SORT_LABEL[sort]}
              />
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.bleed}
              contentContainerStyle={styles.chips}
            >
              <Chip
                label="All"
                leading={<NetworkGrid size={22} />}
                selected={chain === 'All'}
                onPress={() => setChain('All')}
              />
              {CHAINS.map((ch) => (
                <Chip
                  key={ch.name}
                  label={ch.name}
                  leading={<TokenIcon symbol={ch.symbol} size={22} />}
                  selected={chain === ch.name}
                  onPress={() => setChain(ch.name)}
                />
              ))}
            </ScrollView>

            <ContentSwap id={`${chain}-${sort}`} index={CHAIN_ORDER.indexOf(chain)}>
              {top.map((token, i) => (
                <MarketRow key={token.symbol} token={token} rank={i + 1} />
              ))}
            </ContentSwap>
          </>
        )}
      </ContentSwap>
    </TabScreen>
  );
}

function MarketRow({ token, rank }: { token: MarketToken; rank?: number }) {
  const styles = useStyles();
  return (
    <PressableRow onPress={() => openToken(token.symbol)} style={styles.row}>
      {rank ? <Text style={styles.rank}>{rank}</Text> : null}
      <TokenIcon symbol={token.symbol} size={40} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {token.name}
        </Text>
        <Text style={styles.rowMeta}>{formatCompactUsd(token.volume)} Vol</Text>
      </View>
      <View style={styles.rowEnd}>
        <Text style={styles.rowTitle}>{formatPrice(token.price)}</Text>
        <Change value={token.change} />
      </View>
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  flex: {
    flex: 1,
  },
  section: {
    marginTop: 24,
  },
  // Horizontal rows run to the screen edges while their first card lines up with the gutter.
  bleed: {
    marginHorizontal: -18,
    marginTop: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: {
    color: c.textSecondary,
    fontSize: 17,
  },
  more: {
    color: c.textSecondary,
    fontSize: 18,
    letterSpacing: 1,
  },
  favorites: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  favoriteCell: {
    width: '48.8%',
  },
  remove: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  done: {
    color: c.accentText,
    fontSize: 16,
    fontWeight: '600',
  },
  favorite: {
    padding: 14,
    gap: 6,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  favoriteName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  favoriteSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  favoritePrice: {
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
  },
  carousel: {
    paddingHorizontal: 18,
    gap: 8,
  },
  stable: {
    // A solid card on the page, like every other card (no outline).
    width: 210,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  stableSymbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  stableMeta: {
    marginTop: 2,
    color: c.accentText,
    fontSize: 14,
  },
  chips: {
    paddingHorizontal: 18,
    gap: 8,
    paddingBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  rank: {
    width: 18,
    color: c.textSecondary,
    fontSize: 15,
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowMeta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
}));
