import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SuccessCheck } from '@/components/motion/SuccessCheck';
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
import { SearchField } from '@/components/wallet/SearchField';
import { closeSheet, SHEET, SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { TokenList } from '@/components/wallet/TokenList';
import { useCopy } from '@/lib/copy';
import { success, tap } from '@/lib/haptics';
import {
  type Chain,
  chainSymbol,
  formatBalance,
  formatUsd,
  HOLDINGS,
  RECENT_RECIPIENTS,
  shortAddress,
} from '@/lib/mock-wallet';
import { showDemoToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

type Page = 'pick' | 'amount' | 'review' | 'sent';
/** In slide order: the token list sits to the left of the amount, so it opens from there. */
const PAGES: Page[] = ['pick', 'amount', 'review', 'sent'];
type Unit = 'usd' | 'token';
/** What you can send: one choice per token per network you hold it on, largest first. */
const SENDABLE = HOLDINGS.filter((h) => h.amount > 0);

/** Who a send goes to: a saved label, or a shortened address, plus the full address to copy. */
function describeRecipient(to: string) {
  const known = RECENT_RECIPIENTS.find(
    (r) => r.label === to || r.address.toLowerCase() === to.toLowerCase(),
  );
  if (known?.label) {
    return {
      title: known.label,
      subtitle: shortAddress(known.address, 8, 6),
      address: known.address,
    };
  }
  const long = to.length > 18;
  return { title: long ? shortAddress(to, 8, 6) : to || 'Unknown', subtitle: null, address: to };
}

/** Send, step two: how much of which token, then a review before sending. */
export default function SendAmountSheet() {
  const { to = '', symbol: initial = 'USDC' } = useLocalSearchParams<{
    to?: string;
    symbol?: string;
  }>();
  const styles = useStyles();
  const c = useTheme();
  // The largest holding of the requested token, so its network is the sensible default.
  const [picked, setPicked] = useState(() => {
    const first = SENDABLE.find((h) => h.symbol === initial) ?? SENDABLE[0];
    return { symbol: first.symbol, chain: first.chain };
  });
  const { symbol, chain } = picked;
  const [unit, setUnit] = useState<Unit>('usd');
  const [amount, setAmount] = useState('');
  const [page, setPage] = useState<Page>('amount');
  const [area, setArea] = useState(0);

  const token = SENDABLE.find((h) => h.symbol === symbol && h.chain === chain) ?? SENDABLE[0];
  const price = token.usd / token.amount;
  const value = Number(amount) || 0;
  const tokenValue = unit === 'usd' ? value / price : value;
  const usdValue = unit === 'usd' ? value : value * price;
  const insufficient = tokenValue > token.amount * (1 + 1e-9);
  const ready = value > 0 && !insufficient;
  const label = !value ? 'Enter an amount' : insufficient ? 'Insufficient balance' : 'Review';

  const recipient = describeRecipient(to);
  const { copied, copy } = useCopy(recipient.address);

  const go = (next: Page) => {
    tap();
    setPage(next);
  };

  const flipUnit = () => {
    tap();
    if (value) setAmount(unit === 'usd' ? trimNumber(tokenValue, 8) : trimNumber(usdValue, 2));
    setUnit(unit === 'usd' ? 'token' : 'usd');
  };

  // The token list is a page of this sheet rather than a sheet over it: a sheet
  // stacked on a full-height sheet leaves it stretched under the status bar on iOS 26.
  const [query, setQuery] = useState('');
  const choose = (next: { symbol: string; chain: Chain }) => {
    tap();
    setPicked(next);
    setAmount('');
    setQuery('');
    setPage('amount');
  };

  const send = () => {
    success();
    setPage('sent');
  };

  const finish = () => {
    tap();
    showDemoToast('nothing was sent');
    router.dismissAll();
  };

  return (
    // Each page keeps its own button so it slides in with that page's content.
    <SheetScreen
      title={page === 'review' ? 'Review send' : page === 'pick' ? 'Choose token' : 'Send'}
      size="fill"
      onBack={() => {
        if (page === 'review' || page === 'pick') go('amount');
        else if (page === 'sent') finish();
        else {
          tap();
          closeSheet();
        }
      }}
    >
      <View style={styles.flex} onLayout={(e) => setArea(e.nativeEvent.layout.height)}>
        <ContentSwap id={page} index={PAGES.indexOf(page)}>
          <View style={{ height: area }}>
            {page === 'pick' ? (
              <>
                <SearchField
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search your tokens"
                  style={styles.pickSearch}
                />
                <ScrollView
                  style={styles.flex}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <TokenList query={query} sending onChoose={choose} />
                </ScrollView>
              </>
            ) : page === 'amount' ? (
              <>
                <View style={styles.toCard}>
                  <Text style={styles.toLabel}>To</Text>
                  <Avatar name={recipient.title} size={32} seed={to} />
                  <View style={styles.flex}>
                    <Text style={styles.toTitle} numberOfLines={1}>
                      {recipient.title}
                    </Text>
                    {/* Swaps to a confirmation for a moment after copying. */}
                    {recipient.subtitle || copied ? (
                      <View style={styles.toSubtitleLine}>
                        <TextSwap
                          text={copied ? 'Address copied' : (recipient.subtitle ?? '')}
                          style={[styles.toSubtitle, copied && styles.toCopied]}
                        />
                      </View>
                    ) : null}
                  </View>
                  {recipient.address ? (
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={copied ? 'Address copied' : 'Copy address'}
                      hitSlop={8}
                      onPress={copy}
                      style={styles.copy}
                    >
                      <IconSwap
                        name={copied ? 'check' : 'copy'}
                        size={15}
                        color={copied ? c.success : c.textSecondary}
                      />
                    </PressableScale>
                  ) : null}
                </View>

                <View style={styles.tokenBar}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Sending ${symbol} on ${chain}. Change token or network`}
                    onPress={() => {
                      tap();
                      setPage('pick');
                    }}
                    style={styles.pill}
                  >
                    <TokenIcon symbol={symbol} chain={chain} size={26} ring={c.sheet} />
                    <View>
                      <Text style={styles.pillLabel}>{symbol}</Text>
                      <Text style={styles.pillChain}>{chain}</Text>
                    </View>
                    <Icon name="chevronDown" size={12} color={c.textSecondary} />
                  </PressableScale>
                  {/* Tapping the balance sends all of it, like Max. */}
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Balance ${formatBalance(token.amount)} ${symbol}`}
                    accessibilityHint="Enters your whole balance"
                    hitSlop={10}
                    onPress={() => {
                      tap();
                      setAmount(
                        unit === 'usd' ? trimNumber(token.usd, 2) : trimNumber(token.amount, 8),
                      );
                    }}
                  >
                    <TextSwap
                      text={`Balance: ${formatBalance(token.amount)} ${symbol}`}
                      style={styles.balance}
                    />
                  </PressableScale>
                </View>

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
            ) : page === 'sent' ? (
              // A rare, earned moment: the check draws on, then the details follow.
              <>
                <View style={styles.flex} />
                <View style={styles.sent}>
                  <SuccessCheck />
                  <Text style={styles.sentTitle} accessibilityRole="header">
                    Sent
                  </Text>
                  <Text style={styles.sentDetail}>
                    {formatBalance(tokenValue)} {symbol} on {chain} to {recipient.title}
                  </Text>
                </View>
                <View style={styles.flex} />
                <PillButton label="Done" onPress={finish} style={styles.cta} />
              </>
            ) : (
              <>
                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>You're sending</Text>
                  <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
                    {formatBalance(tokenValue)} {symbol}
                  </Text>
                  <View style={styles.summaryUsd}>
                    <TokenIcon symbol={symbol} chain={chain} size={20} ring={c.sheet} />
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
  pickSearch: {
    marginBottom: 12,
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
  // Fixed height, so the outgoing and incoming text overlap rather than stack.
  toSubtitleLine: {
    marginTop: 1,
    height: 18,
  },
  toCopied: {
    color: c.success,
  },
  copy: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  toSubtitle: {
    position: 'absolute',
    left: 0,
    top: 0,
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
    // Two lines: the token, and the network it's sent from.
    height: 46,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: c.divider,
  },
  pillLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  pillChain: {
    color: c.textSecondary,
    fontSize: 12,
  },
  balance: {
    color: c.textSecondary,
    fontSize: 14,
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
  sent: {
    alignItems: 'center',
  },
  sentTitle: {
    marginTop: 16,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
  },
  sentDetail: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  note: {
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
