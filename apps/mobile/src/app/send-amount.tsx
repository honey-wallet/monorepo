import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  applyKey,
  Keypad,
  PercentChips,
  TypedAmount,
  trimNumber,
} from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SHEET, SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import {
  chainSymbol,
  formatBalance,
  formatUsd,
  marketOf,
  RECENT_RECIPIENTS,
  shortAddress,
  TOKENS,
} from '@/lib/mock-wallet';
import { showDemoToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

type Page = 'amount' | 'review';
const PAGES: Page[] = ['amount', 'review'];
type Unit = 'usd' | 'token';
const WALLET_TOKENS = TOKENS.filter((t) => !t.hidden);

/** Who a send goes to: a saved label, or a shortened address. */
function describeRecipient(to: string) {
  const known = RECENT_RECIPIENTS.find(
    (r) => r.label === to || r.address.toLowerCase() === to.toLowerCase(),
  );
  if (known?.label) return { title: known.label, subtitle: shortAddress(known.address, 8, 6) };
  const long = to.length > 18;
  return { title: long ? shortAddress(to, 8, 6) : to || 'Unknown', subtitle: null };
}

/** Send, step two: how much of which token, then a review before sending. */
export default function SendAmountSheet() {
  const { to = '', symbol: initial = 'USDC' } = useLocalSearchParams<{
    to?: string;
    symbol?: string;
  }>();
  const styles = useStyles();
  const c = useTheme();
  const [symbol, setSymbol] = useState(
    WALLET_TOKENS.some((t) => t.symbol === initial) ? initial : 'USDC',
  );
  const [unit, setUnit] = useState<Unit>('usd');
  const [amount, setAmount] = useState('');
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState<Page>('amount');
  const [area, setArea] = useState(0);

  const token = WALLET_TOKENS.find((t) => t.symbol === symbol) ?? WALLET_TOKENS[0];
  const price = token.usd / token.amount;
  const value = Number(amount) || 0;
  const tokenValue = unit === 'usd' ? value / price : value;
  const usdValue = unit === 'usd' ? value : value * price;
  const insufficient = tokenValue > token.amount * (1 + 1e-9);
  const ready = value > 0 && !insufficient;
  const label = !value ? 'Enter an amount' : insufficient ? 'Insufficient balance' : 'Review';

  const recipient = describeRecipient(to);
  const chain = marketOf(symbol)?.chain ?? 'Ethereum';

  const go = (next: Page) => {
    tap();
    setPage(next);
  };

  const flipUnit = () => {
    tap();
    setPicking(false);
    if (value) setAmount(unit === 'usd' ? trimNumber(tokenValue, 8) : trimNumber(usdValue, 2));
    setUnit(unit === 'usd' ? 'token' : 'usd');
  };

  const pick = (next: string) => {
    tap();
    setSymbol(next);
    setAmount('');
    setPicking(false);
  };

  const send = () => {
    showDemoToast('nothing was sent');
    router.dismissAll();
  };

  return (
    // Each page keeps its own button so it slides in with that page's content.
    <SheetScreen
      title={page === 'review' ? 'Review send' : 'Send'}
      size="fill"
      onBack={() => {
        if (page === 'review') go('amount');
        else {
          tap();
          closeSheet();
        }
      }}
    >
      <View style={styles.flex} onLayout={(e) => setArea(e.nativeEvent.layout.height)}>
        <ContentSwap id={page} index={PAGES.indexOf(page)}>
          <View style={{ height: area }}>
            {page === 'amount' ? (
              <>
                <View style={styles.toCard}>
                  <Text style={styles.toLabel}>To</Text>
                  <Avatar name={recipient.title} size={32} seed={to} />
                  <View style={styles.flex}>
                    <Text style={styles.toTitle} numberOfLines={1}>
                      {recipient.title}
                    </Text>
                    {recipient.subtitle ? (
                      <Text style={styles.toSubtitle}>{recipient.subtitle}</Text>
                    ) : null}
                  </View>
                </View>

                <View style={styles.tokenBar}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Token: ${symbol}. Change token`}
                    accessibilityState={{ expanded: picking }}
                    onPress={() => {
                      tap();
                      setPicking((v) => !v);
                    }}
                    style={styles.pill}
                  >
                    <TokenIcon symbol={symbol} size={26} />
                    <Text style={styles.pillLabel}>{symbol}</Text>
                    <AccordionChevron open={picking} size={12} color={c.textSecondary} />
                  </PressableScale>
                  <TextSwap
                    text={`Balance: ${formatBalance(token.amount)} ${symbol}`}
                    style={styles.balance}
                  />
                </View>
                <Accordion open={picking}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chooser}
                  >
                    {WALLET_TOKENS.map((t) => (
                      <PressableScale
                        key={t.symbol}
                        accessibilityRole="button"
                        accessibilityState={{ selected: t.symbol === symbol }}
                        onPress={() => pick(t.symbol)}
                        style={[styles.choice, t.symbol === symbol && styles.choiceActive]}
                      >
                        <TokenIcon symbol={t.symbol} size={22} />
                        <Text style={styles.choiceLabel}>{t.symbol}</Text>
                      </PressableScale>
                    ))}
                  </ScrollView>
                </Accordion>

                <View style={styles.amountArea}>
                  <View style={styles.amountRow}>
                    <TypedAmount
                      value={amount}
                      prefix={unit === 'usd' ? '$' : ''}
                      size={amount.length > 9 ? 40 : 56}
                    />
                    {unit === 'token' ? <Text style={styles.unit}>{symbol}</Text> : null}
                  </View>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel="Switch between dollars and token"
                    hitSlop={10}
                    onPress={flipUnit}
                    style={styles.convert}
                  >
                    <Icon name="expand" size={13} color={c.textSecondary} />
                    <TextSwap
                      text={
                        unit === 'usd'
                          ? `${formatBalance(tokenValue)} ${symbol}`
                          : formatUsd(usdValue)
                      }
                      style={styles.convertLabel}
                    />
                  </PressableScale>
                </View>

                <PercentChips
                  balance={unit === 'usd' ? token.usd : token.amount}
                  decimals={unit === 'usd' ? 2 : 8}
                  onPick={setAmount}
                  style={styles.shares}
                />
                <Keypad
                  onKey={(key) => setAmount((a) => applyKey(a, key, unit === 'usd' ? 2 : 8))}
                />
                <PillButton
                  label={label}
                  disabled={!ready}
                  onPress={() => go('review')}
                  style={styles.cta}
                />
              </>
            ) : (
              <>
                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>You're sending</Text>
                  <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
                    {formatBalance(tokenValue)} {symbol}
                  </Text>
                  <View style={styles.summaryUsd}>
                    <TokenIcon symbol={symbol} size={20} />
                    <Text style={styles.summaryUsdLabel}>{formatUsd(usdValue)}</Text>
                  </View>
                </View>
                <View style={styles.rule} />
                <View style={styles.rows}>
                  <StatRow
                    label="To"
                    value={
                      <View style={styles.inline}>
                        <Avatar name={recipient.title} size={20} seed={to} />
                        <Text style={styles.rowValue}>{recipient.title}</Text>
                      </View>
                    }
                  />
                  <StatRow
                    label="Network"
                    value={
                      <View style={styles.inline}>
                        <TokenIcon symbol={chainSymbol(chain)} size={18} />
                        <Text style={styles.rowValue}>{chain}</Text>
                      </View>
                    }
                  />
                  <StatRow label="Network cost" value="<$0.01" />
                  <StatRow
                    label="Total"
                    value={<Text style={styles.total}>{formatUsd(usdValue)}</Text>}
                  />
                </View>
                <View style={styles.flex} />
                <Text style={styles.note}>
                  Sends can't be undone. Check the address before you send.
                </Text>
                <PillButton label="Send" onPress={send} style={styles.cta} />
              </>
            )}
          </View>
        </ContentSwap>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  toCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
  },
  toLabel: {
    color: c.textSecondary,
    fontSize: 16,
  },
  toTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  toSubtitle: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  tokenBar: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.divider,
  },
  pillLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  balance: {
    color: c.textSecondary,
    fontSize: 14,
  },
  chooser: {
    gap: 8,
    paddingTop: 10,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 18,
    backgroundColor: c.raised,
  },
  choiceActive: {
    backgroundColor: c.accentSurface,
  },
  choiceLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  amountArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unit: {
    color: c.textSecondary,
    fontSize: 28,
    fontWeight: '500',
  },
  convert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  convertLabel: {
    color: c.textSecondary,
    fontSize: 16,
  },
  shares: {
    marginBottom: 6,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
  summary: {
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 26,
    gap: 6,
  },
  summaryLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  summaryAmount: {
    color: c.text,
    fontSize: 44,
    fontWeight: '500',
    letterSpacing: -1,
  },
  summaryUsd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  summaryUsdLabel: {
    color: c.textSecondary,
    fontSize: 17,
  },
  rule: {
    height: 1,
    backgroundColor: c.divider,
  },
  rows: {
    paddingTop: 12,
    gap: 4,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowValue: {
    color: c.text,
    fontSize: 16,
  },
  total: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  note: {
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
