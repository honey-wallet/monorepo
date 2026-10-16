import { router } from 'expo-router';
import { Linking, Text } from 'react-native';
import { PushedScreen } from '@/components/wallet/parts';
import { makeStyles } from '@/theme';

const TERMS_URL = 'https://honeywallet.app/terms';
const PRIVACY_URL = 'https://honeywallet.app/privacy';

/** Plain-language disclosures about what Honey is, and isn't. */
export default function DisclosuresScreen() {
  const styles = useStyles();

  const link = (label: string, onPress: () => void) => (
    <Text style={styles.link} onPress={onPress} accessibilityRole="link">
      {label}
    </Text>
  );

  return (
    <PushedScreen title="Disclosures" fallback="/settings" contentStyle={styles.content}>
      <Text style={styles.heading}>Self-custody</Text>
      <Text style={styles.body}>
        Honey is a self-custodial wallet. Your private keys and recovery phrase are created and
        stored on your device, and Honey's servers never receive, hold or have access to them. Honey
        can't move, freeze or recover your funds, and can't reverse a transaction once it's sent. If
        you lose your recovery phrase and your device, nobody — including Honey — can restore your
        wallet.
      </Text>

      <Text style={styles.heading}>What Honey is not</Text>
      <Text style={styles.body}>
        Honey is software that helps you prepare and sign transactions on public blockchains. It
        isn't a bank, broker-dealer, exchange, money transmitter or investment adviser, and nothing
        in the app is financial, legal or tax advice. Balances in Honey aren't deposits and aren't
        covered by any deposit insurance or investor protection scheme. Some assets and features may
        not be available where you live.
      </Text>

      <Text style={styles.heading}>Risk</Text>
      <Text style={styles.body}>
        Crypto assets are volatile: prices can move sharply and you can lose some or all of what you
        hold. Past performance doesn't predict future results. Only use money you can afford to
        lose, and check every address and amount before you confirm.
      </Text>

      <Text style={styles.heading}>Network fees</Text>
      <Text style={styles.body}>
        Every on-chain transaction pays a network fee to the blockchain's validators, not to Honey.
        Fees change with network demand and are charged even if a transaction fails. Estimates shown
        before you confirm can differ from the final fee.
      </Text>

      <Text style={styles.heading}>Third-party protocols</Text>
      <Text style={styles.body}>
        Swaps, Honey Jars and connected apps may use smart contracts and services run by third
        parties. Honey doesn't own or control them and can't guarantee their security, availability
        or results. Smart contracts can contain bugs, and interacting with them is at your own risk.
      </Text>

      <Text style={styles.heading}>Honey Jars</Text>
      <Text style={styles.body}>
        Yields shown for Honey Jars are variable, estimated from recent on-chain rates, and are not
        guaranteed. Rates can fall to zero, and the value of what you deposit can go down as well as
        up.
      </Text>

      <Text style={styles.heading}>Quantum resistance</Text>
      <Text style={styles.body}>
        When Honey describes itself as quantum-resistant, it refers to a key-rotation design that
        lets your wallet move to new signature schemes as they become available. It doesn't
        guarantee security against every current or future attack, and the underlying blockchains
        may not yet support post-quantum signatures.
      </Text>

      <Text style={styles.heading}>More</Text>
      <Text style={styles.body}>
        For the full terms, read our {link('Terms of Service', () => Linking.openURL(TERMS_URL))}{' '}
        and {link('Privacy Policy', () => Linking.openURL(PRIVACY_URL))}. Questions?{' '}
        {link('Contact us', () => router.push('/contact'))}.
      </Text>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  heading: {
    marginTop: 18,
    marginBottom: 6,
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  body: {
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 23,
  },
  link: {
    color: c.accentText,
    fontWeight: '500',
  },
}));
