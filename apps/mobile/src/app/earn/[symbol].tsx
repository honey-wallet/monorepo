import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { SHEET, SheetHeader, SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { finishDemo, SuccessPage } from '@/components/wallet/SuccessPage';
import { success, tap } from '@/lib/haptics';
import { formatCompactUsd, formatUsd, shortAddress, TOKENS, VAULTS } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';

/** Earn sheet after Uniswap's: headline rate, vault facts, details on demand, Deposit. */
export default function EarnSheet() {
  const { symbol = 'USDC' } = useLocalSearchParams<{ symbol: string }>();
  const styles = useStyles();
  const c = useTheme();
  const [more, setMore] = useState(false);
  const [depositing, setDepositing] = useState(false);
  // What was just deposited, shown on the closing page.
  const [deposited, setDeposited] = useState<string | null>(null);
  const vault = VAULTS[symbol];
  if (!vault) return null;

  return (
    // Each page ends with its own main button, so the buttons swap with the pages.
    <SheetScreen>
      <ContentSwap
        id={deposited ? 'done' : depositing ? 'deposit' : 'info'}
        index={deposited ? 2 : depositing ? 1 : 0}
      >
        {deposited ? (
          <SuccessPage
            title="Deposited"
            detail={`${deposited} ${symbol} is now earning ${vault.apy.toFixed(2)}% APY.`}
            onDone={() => finishDemo('nothing was deposited')}
          />
        ) : depositing ? (
          <DepositPage
            symbol={symbol}
            apy={vault.apy}
            onBack={() => setDepositing(false)}
            onDeposit={(amount) => {
              success();
              setDeposited(amount);
            }}
          />
        ) : (
          <View>
            <View style={styles.hero}>
              <TokenIcon symbol={symbol} size={52} />
              <TextsReveal
                id={symbol}
                align="center"
                first={<Text style={styles.title}>Earn with {symbol}</Text>}
                second={
                  <Text style={styles.subtitle}>Earn returns on your {symbol} with no lockup</Text>
                }
              />
            </View>

            <View style={styles.grid}>
              <View style={[styles.cell, styles.cellRight, styles.cellBottom]}>
                <Text style={styles.cellLabel}>Current APY</Text>
                <Text style={[styles.cellValue, styles.accent]}>{vault.apy.toFixed(2)}%</Text>
              </View>
              <View style={[styles.cell, styles.cellBottom]}>
                <Text style={styles.cellLabel}>Exposure</Text>
                <View style={styles.exposure}>
                  {vault.exposure.map((s, i) => (
                    <View key={s} style={[styles.exposureCoin, i > 0 && styles.overlap]}>
                      <TokenIcon symbol={s} size={24} />
                    </View>
                  ))}
                </View>
              </View>
              <View style={[styles.cell, styles.cellRight]}>
                <Text style={styles.cellLabel}>Total deposits</Text>
                <Text style={styles.cellValue}>{formatCompactUsd(vault.deposits)}</Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Liquidity</Text>
                <Text style={styles.cellValue}>{formatCompactUsd(vault.liquidity)}</Text>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: more }}
              onPress={() => {
                tap();
                setMore((v) => !v);
              }}
              style={styles.more}
            >
              <View style={styles.rule} />
              <TextSwap text={more ? 'Show less' : 'Show more'} style={styles.moreLabel} />
              <AccordionChevron open={more} size={11} color={c.textSecondary} />
              <View style={styles.rule} />
            </Pressable>

            <Accordion open={more}>
              <View style={styles.details}>
                <StatRow label="Curator" value={vault.curator} />
                <StatRow
                  label="Vault"
                  value={
                    <Pressable
                      onPress={() =>
                        Linking.openURL(`https://etherscan.io/address/${vault.address}`)
                      }
                      style={styles.inline}
                    >
                      <Text style={styles.detailValue}>{shortAddress(vault.address)}</Text>
                      <Icon name="link" size={13} color={c.textSecondary} />
                    </Pressable>
                  }
                />
                <StatRow label="Deployed" value={vault.deployed} />
              </View>
              <Text style={styles.disclaimer}>
                Rates change over time and aren't guaranteed. Deposits are lent out and can lose
                value.
              </Text>
            </Accordion>

            <PillButton
              label="Deposit"
              onPress={() => {
                tap();
                setDepositing(true);
              }}
              style={styles.deposit}
            />
          </View>
        )}
      </ContentSwap>
    </SheetScreen>
  );
}

/** Second page of the sheet: how much to put in, with the yearly estimate. */
function DepositPage({
  symbol,
  apy,
  onBack,
  onDeposit,
}: {
  symbol: string;
  apy: number;
  onBack: () => void;
  onDeposit: (amount: string) => void;
}) {
  const styles = useStyles();
  const [amount, setAmount] = useState('');
  const balance = TOKENS.find((t) => t.symbol === symbol)?.amount ?? 0;
  const value = Number(amount) || 0;
  const tooMuch = value > balance;

  return (
    <View>
      <SheetHeader title={`Deposit ${symbol}`} onBack={onBack} />
      <View style={styles.depositAmount}>
        <TypedAmount value={amount} size={48} />
        <TextSwap
          text={
            value
              ? `≈ ${formatUsd((value * apy) / 100)} a year at ${apy.toFixed(2)}% APY`
              : `Balance: ${balance} ${symbol}`
          }
          style={[styles.depositHint, tooMuch && styles.error]}
        />
      </View>
      {balance > 0 ? (
        <PercentChips
          balance={balance}
          only={['25%', '50%', 'Max']}
          onPick={setAmount}
          style={styles.shares}
        />
      ) : (
        <PillButton
          label={`Buy ${symbol}`}
          variant="secondary"
          onPress={() => {
            tap();
            router.replace({ pathname: '/buy-cash', params: { symbol } });
          }}
          style={styles.shares}
        />
      )}
      <Keypad onKey={(key) => setAmount((v) => applyKey(v, key, 6))} />
      <PillButton
        label={
          !value
            ? 'Enter an amount'
            : tooMuch
              ? `Not enough ${symbol}`
              : `Deposit ${amount} ${symbol}`
        }
        disabled={!value || tooMuch}
        onPress={() => onDeposit(amount)}
        style={styles.deposit}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  hero: {
    alignItems: 'center',
    gap: 14,
  },
  title: {
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  grid: {
    marginTop: 22,
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
  },
  cell: {
    width: '50%',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 6,
  },
  cellRight: {
    borderRightWidth: 1,
    borderColor: c.divider,
  },
  cellBottom: {
    borderBottomWidth: 1,
    borderColor: c.divider,
  },
  cellLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  cellValue: {
    color: c.text,
    fontSize: 24,
    fontWeight: '500',
  },
  accent: {
    color: c.accentText,
  },
  exposure: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
  },
  exposureCoin: {
    borderRadius: 14,
    borderWidth: 2,
    borderColor: c.card,
  },
  overlap: {
    marginLeft: -8,
  },
  more: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  rule: {
    flex: 1,
    height: 1,
    backgroundColor: c.divider,
  },
  moreLabel: {
    marginLeft: 6,
    color: c.textSecondary,
    fontSize: 15,
  },
  details: {
    paddingTop: 6,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailValue: {
    color: c.text,
    fontSize: 16,
  },
  disclaimer: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  depositAmount: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 18,
  },
  depositHint: {
    color: c.textSecondary,
    fontSize: 15,
  },
  error: {
    color: c.error,
  },
  shares: {
    marginBottom: 6,
  },
  deposit: {
    marginTop: SHEET.footerGap,
  },
}));
