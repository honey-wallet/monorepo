import { useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { DonutChart } from '@/components/charts/DonutChart';
import { Icon } from '@/components/Icon';
// import { HoneyRoll } from '@/components/logo/HoneyRoll';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { AvatarGroup } from '@/components/motion/AvatarGroup';
import { Checkbox } from '@/components/motion/Checkbox';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { IconSwap } from '@/components/motion/IconSwap';
import { LearnMore } from '@/components/motion/LearnMore';
import { LikeButton } from '@/components/motion/LikeButton';
import { MatrixLoader } from '@/components/motion/MatrixLoader';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { ModalDialog } from '@/components/motion/ModalDialog';
import { NotificationBadge } from '@/components/motion/NotificationBadge';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PanelReveal } from '@/components/motion/PanelReveal';
import { PlusMenuMorph } from '@/components/motion/PlusMenuMorph';
import { ReasoningStream } from '@/components/motion/ReasoningStream';
import { RESIZE } from '@/components/motion/resize';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { ShimmerText } from '@/components/motion/ShimmerText';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { SpinningCounter } from '@/components/motion/SpinningCounter';
import { StreamingText } from '@/components/motion/StreamingText';
import { SuccessBurst } from '@/components/motion/SuccessBurst';
import { TextMorph } from '@/components/motion/TextMorph';
import { TextSoftSwap } from '@/components/motion/TextSoftSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { ThinkingStates } from '@/components/motion/ThinkingStates';
import { TiltCard } from '@/components/motion/TiltCard';
import { Toggle } from '@/components/motion/Toggle';
import { Tooltip } from '@/components/motion/Tooltip';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { PushedScreen, SCREEN, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { describeFailure, FLOW_FAILURES } from '@/lib/outcomes';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/** Counts up every `ms`, so each demo replays on its own without taps. */
function useTick(ms: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

const pick = <T,>(list: readonly T[], tick: number) => list[tick % list.length];

const SECTIONS: { title: string; demos: (() => ReactNode)[] }[] = [
  {
    title: 'Numbers and text',
    demos: [
      NumberDemo,
      SpinningDemo,
      TextSwapDemo,
      TextMorphDemo,
      SoftSwapDemo,
      TextsRevealDemo,
      StreamingDemo,
    ],
  },
  {
    title: 'Status and loading',
    demos: [ShimmerDemo, ThinkingDemo, ReasoningDemo, MatrixDemo, SkeletonDemo],
  },
  {
    title: 'Feedback',
    demos: [SuccessDemo, FailureDemo, ShakeDemo, BadgeDemo, LikeDemo, ToastDemo],
  },
  {
    title: 'Controls',
    demos: [
      IconSwapDemo,
      ToggleDemo,
      CheckboxDemo,
      TabsDemo,
      UnderlineDemo,
      LearnMoreDemo,
      AvatarDemo,
      TooltipDemo,
      ClearDemo,
    ],
  },
  {
    title: 'Surfaces and layout',
    demos: [
      PageDemo,
      AccordionDemo,
      PanelDemo,
      ResizeDemo,
      DonutDemo,
      MenuDemo,
      PlusDemo,
      ModalDemo,
      TiltDemo,
    ],
  },
  // Out for now; the honey wheel lives on in components/logo/HoneyRoll.tsx.
  // { title: 'Just for fun', demos: [HoneyRollDemo] },
];

/**
 * Every animation in Honey, following animations.dev, each playing on a loop in its own
 * card. Opened from Settings → About. `?section=2` shows just one section (handy for
 * recording or checking a single group).
 */
export default function MotionGallery() {
  const styles = useStyles();
  const { section } = useLocalSearchParams<{ section?: string }>();
  const only = section === undefined ? undefined : Number(section);
  return (
    <PushedScreen title="Motion gallery" contentStyle={styles.screen}>
      {only === undefined && (
        <Text style={styles.intro}>
          Every animation in Honey, following animations.dev. Most replay on their own; the ones
          marked Tap or Drag are interactive.
        </Text>
      )}
      {SECTIONS.map(({ title, demos }, i) =>
        only === undefined || only === i ? (
          <View key={title} style={styles.content}>
            <Section title={title} />
            {demos.map((DemoCard) => (
              <DemoCard key={DemoCard.name} />
            ))}
          </View>
        ) : null,
      )}
    </PushedScreen>
  );
}

function Section({ title }: { title: string }) {
  const styles = useStyles();
  return <Text style={styles.section}>{title}</Text>;
}

/** A card with the recipe's name, an optional hint (Tap / Drag) and the demo. */
function Demo({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: 'Tap' | 'Drag' | 'Long-press';
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={styles.stage}>{children}</View>
    </View>
  );
}

// --- Numbers and text -------------------------------------------------------

function NumberDemo() {
  const styles = useStyles();
  const value = pick(['$2,357.35', '$2,361.08', '$2,349.90'], useTick(1800));
  return (
    <Demo title="Number change">
      <NumberPopIn value={value} style={styles.big} fractionStyle={styles.dim} />
    </Demo>
  );
}

function SpinningDemo() {
  const styles = useStyles();
  const value = pick(['$420.00', '$1,280.50', '$76.25'], useTick(2600));
  return (
    <Demo title="Rolling counter">
      <SpinningCounter value={value} style={styles.big} />
    </Demo>
  );
}

function TextSwapDemo() {
  const styles = useStyles();
  const text = pick(['Sending…', 'Sent to Honey.honey'], useTick(1600));
  return (
    <Demo title="Text swap">
      <TextSwap text={text} style={styles.body} />
    </Demo>
  );
}

function TextMorphDemo() {
  const styles = useStyles();
  const text = pick(['Save', 'Saved'], useTick(1400));
  return (
    <Demo title="Label morph">
      <TextMorph text={text} style={styles.body} />
    </Demo>
  );
}

function SoftSwapDemo() {
  const styles = useStyles();
  const text = pick(['$0.60 today', '$3.12 this week', '$14.81 this month'], useTick(1600));
  return (
    <Demo title="Soft crossfade">
      <TextSoftSwap text={text} style={styles.body} />
    </Demo>
  );
}

function TextsRevealDemo() {
  const styles = useStyles();
  const tick = useTick(2400);
  return (
    <Demo title="Text reveal">
      <TextsReveal
        id={String(tick)}
        first={
          <Text style={styles.title}>{pick(['Welcome back', 'Your jar is ready'], tick)}</Text>
        }
        second={<Text style={styles.dimBody}>A second line follows one step behind.</Text>}
      />
    </Demo>
  );
}

function StreamingDemo() {
  const styles = useStyles();
  const tick = useTick(3200);
  return (
    <Demo title="Word stream">
      <StreamingText
        key={tick}
        text="Swapped 0.002 ETH for 0.03 SOL. It lands in about a minute."
        style={styles.body}
        align="left"
      />
    </Demo>
  );
}

// --- Status and loading -----------------------------------------------------

function ShimmerDemo() {
  const styles = useStyles();
  return (
    <Demo title="Shimmer">
      <ShimmerText text="Finding best route" style={styles.body} />
    </Demo>
  );
}

function ThinkingDemo() {
  const styles = useStyles();
  const tick = useTick(9000);
  return (
    <Demo title="Status line">
      <ThinkingStates
        key={tick}
        states={['Preparing swap', 'Signing', 'Confirming on Ethereum']}
        style={styles.body}
      />
    </Demo>
  );
}

function ReasoningDemo() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <Demo title="Transcript">
      <View style={styles.inset}>
        <ReasoningStream
          background={c.raised}
          visibleLines={3}
          lines={[
            'Quoting 6 routes',
            'Best price via Uniswap',
            'Bridging with Across',
            'Simulating transaction',
            'No issues found',
          ]}
          textStyle={styles.small}
        />
      </View>
    </Demo>
  );
}

function MatrixDemo() {
  const styles = useStyles();
  return (
    <Demo title="Dot loader">
      <View style={styles.row}>
        <MatrixLoader dot={4} gap={3} />
        <Text style={styles.dimBody}>Loading quotes</Text>
      </View>
    </Demo>
  );
}

function SkeletonDemo() {
  const styles = useStyles();
  const loading = useTick(1800) % 2 === 0;
  return (
    <Demo title="Skeleton and reveal">
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View style={styles.row}>
            <SkeletonBar width={40} height={40} radius={20} />
            <View style={styles.gap}>
              <SkeletonBar width={120} />
              <SkeletonBar width={80} height={12} />
            </View>
          </View>
        }
      >
        <View style={styles.row}>
          <TokenIcon symbol="ETH" size={40} />
          <View>
            <Text style={styles.body}>Ethereum</Text>
            <Text style={styles.dimSmall}>0.0042 ETH</Text>
          </View>
        </View>
      </SkeletonReveal>
    </Demo>
  );
}

// --- Feedback ---------------------------------------------------------------

function SuccessDemo() {
  const tick = useTick(2400);
  return (
    <Demo title="Success">
      <SuccessBurst key={tick} size={56} />
    </Demo>
  );
}

/** The failure page, cycling through the ways a send can fail. */
function FailureDemo() {
  const tick = useTick(5000);
  const kinds = FLOW_FAILURES.send;
  return (
    <Demo title="Failure">
      <View style={{ alignSelf: 'stretch' }}>
        <FailurePage
          key={tick}
          compact
          failure={describeFailure(pick(kinds, tick), 'send')}
          onRetry={() => {}}
          onClose={() => {}}
        />
      </View>
    </Demo>
  );
}

function ShakeDemo() {
  const styles = useStyles();
  const { shake, style } = useErrorShake();
  const tick = useTick(1800);
  // biome-ignore lint/correctness/useExhaustiveDependencies: replays on each tick.
  useEffect(() => {
    if (tick) shake();
  }, [tick]);
  return (
    <Demo title="Error shake">
      <Animated.View style={[styles.field, style]}>
        <Text style={styles.body}>0.5 ETH</Text>
        <Text style={styles.error}>Not enough ETH</Text>
      </Animated.View>
    </Demo>
  );
}

function BadgeDemo() {
  const c = useTheme();
  const styles = useStyles();
  const show = useTick(1500) % 2 === 0;
  return (
    <Demo title="Notification badge">
      <View>
        <Icon name="bell" size={28} color={c.textSecondary} />
        {show && <NotificationBadge style={styles.badge} />}
      </View>
    </Demo>
  );
}

function LikeDemo() {
  const liked = useTick(1400) % 2 === 1;
  return (
    <Demo title="Favourite">
      <LikeButton liked={liked} onToggle={() => {}} size={30} />
    </Demo>
  );
}

function ToastDemo() {
  const [n, setN] = useState(1);
  return (
    <Demo title="Toast stack" hint="Tap">
      <PillButton
        label="Show a toast"
        onPress={() => {
          showToast(`Toast ${n}: saved`);
          setN(n + 1);
        }}
      />
    </Demo>
  );
}

// --- Controls ---------------------------------------------------------------

function IconSwapDemo() {
  const c = useTheme();
  const copied = useTick(1300) % 2 === 1;
  return (
    <Demo title="Icon swap">
      <IconSwap name={copied ? 'check' : 'copy'} size={28} color={c.text} />
    </Demo>
  );
}

function ToggleDemo() {
  const on = useTick(1300) % 2 === 1;
  return (
    <Demo title="Toggle">
      <Toggle value={on} onValueChange={() => {}} accessibilityLabel="Demo toggle" />
    </Demo>
  );
}

function CheckboxDemo() {
  const checked = useTick(1300) % 2 === 1;
  return (
    <Demo title="Checkbox">
      <Checkbox label="I've written it down somewhere safe" checked={checked} onChange={() => {}} />
    </Demo>
  );
}

const TABS = ['Swap', 'Perps', 'Predict'] as const;

function TabsDemo() {
  const value = pick(TABS, useTick(1200));
  return (
    <Demo title="Tabs">
      <SegmentedTabs options={TABS} value={value} onChange={() => {}} />
    </Demo>
  );
}

function UnderlineDemo() {
  const value = pick(TABS, useTick(1200));
  return (
    <Demo title="Underline tabs">
      <View style={{ alignSelf: 'stretch' }}>
        <UnderlineTabs options={TABS} value={value} onChange={() => {}} />
      </View>
    </Demo>
  );
}

function LearnMoreDemo() {
  const c = useTheme();
  const styles = useStyles();
  const active = useTick(1000) % 2 === 1;
  return (
    <Demo title="Link press">
      <LearnMore label="How perps work" active={active} color={c.accentText} style={styles.body} />
    </Demo>
  );
}

function AvatarDemo() {
  const lifted = useTick(1000) % 2 === 1;
  return (
    <Demo title="Avatar lift">
      <AvatarGroup lifted={lifted}>
        {['ETH', 'BTC', 'SOL', 'USDC'].map((s) => (
          <TokenIcon key={s} symbol={s} size={36} />
        ))}
      </AvatarGroup>
    </Demo>
  );
}

function TooltipDemo() {
  const c = useTheme();
  const visible = useTick(1400) % 2 === 1;
  return (
    <Demo title="Tooltip">
      <View style={{ alignItems: 'center', paddingBottom: 36 }}>
        <Icon name="scan" size={26} color={c.textSecondary} />
        <Tooltip label="Scan" visible={visible} />
      </View>
    </Demo>
  );
}

function ClearDemo() {
  const [value, setValue] = useState('wrapped bitcoin');
  return (
    <Demo title="Search clear" hint="Tap">
      <View style={{ alignSelf: 'stretch' }}>
        <SearchField value={value} onChangeText={setValue} placeholder="Search tokens" />
      </View>
    </Demo>
  );
}

// --- Surfaces and layout ----------------------------------------------------

function PageDemo() {
  const styles = useStyles();
  const tick = useTick(1500);
  const page = tick % 3;
  return (
    <Demo title="Page crossfade">
      <ContentSwap id={String(page)} index={page}>
        <Text style={styles.title}>
          {['1. Pick a market', '2. Go long or short', '3. Set your size'][page]}
        </Text>
      </ContentSwap>
    </Demo>
  );
}

function AccordionDemo() {
  const styles = useStyles();
  const c = useTheme();
  const open = useTick(1500) % 2 === 1;
  return (
    <Demo title="Accordion">
      <View style={{ alignSelf: 'stretch' }}>
        <View style={styles.rowBetween}>
          <Text style={styles.body}>Breakdown</Text>
          <AccordionChevron open={open} size={14} color={c.textSecondary} />
        </View>
        <Accordion open={open}>
          <Text style={[styles.dimBody, { paddingTop: 8 }]}>$10.54 on Ethereum · 0.0042 ETH</Text>
        </Accordion>
      </View>
    </Demo>
  );
}

function PanelDemo() {
  const styles = useStyles();
  const open = useTick(1600) % 2 === 1;
  return (
    <Demo title="Panel reveal">
      <View style={[styles.inset, { height: 92, justifyContent: 'flex-end' }]}>
        <PanelReveal open={open}>
          <Text style={styles.body}>Route · Uniswap</Text>
          <Text style={styles.dimSmall}>Network cost $0.42 · Slippage 5.5%</Text>
        </PanelReveal>
      </View>
    </Demo>
  );
}

function ResizeDemo() {
  const styles = useStyles();
  const big = useTick(1500) % 2 === 1;
  return (
    <Demo title="Card resize">
      <Animated.View layout={RESIZE} style={[styles.inset, { width: big ? 240 : 150 }]}>
        <Text style={styles.body}>Total return</Text>
        {big && <Text style={styles.dimSmall}>Unrealized $3.04 · Realized $11.77</Text>}
      </Animated.View>
    </Demo>
  );
}

function DonutDemo() {
  const tick = useTick(1800);
  const sets = [
    [40, 30, 20, 10],
    [15, 25, 25, 35],
    [55, 10, 25, 10],
  ];
  const colors = ['#627EEA', '#F7931A', '#14F195', '#2775CA'];
  const values = pick(sets, tick);
  return (
    <Demo title="Donut chart">
      <DonutChart
        size={120}
        thickness={12}
        segments={values.map((v, i) => ({ id: String(i), value: v, color: colors[i] }))}
      />
    </Demo>
  );
}

function MenuDemo() {
  const [value, setValue] = useState<'volume' | 'cap' | 'gain'>('volume');
  return (
    <Demo title="Dropdown" hint="Tap">
      <MenuDropdown
        options={[
          { value: 'volume', label: 'Volume' },
          { value: 'cap', label: 'Market cap' },
          { value: 'gain', label: 'Price increase' },
        ]}
        value={value}
        onChange={setValue}
        triggerLabel={{ volume: 'Volume', cap: 'Market cap', gain: 'Price increase' }[value]}
      />
    </Demo>
  );
}

function PlusDemo() {
  const c = useTheme();
  return (
    <Demo title="Plus menu morph" hint="Tap">
      <View style={{ height: 190, alignSelf: 'stretch', alignItems: 'flex-end' }}>
        <PlusMenuMorph
          label="Add"
          title="Add to savings"
          items={[
            {
              label: 'New jar',
              leading: <Icon name="target" size={20} color={c.accentText} />,
              onPress: () => {},
            },
            {
              label: 'Earn with USDC',
              leading: <TokenIcon symbol="USDC" size={24} />,
              onPress: () => {},
            },
          ]}
        />
      </View>
    </Demo>
  );
}

function ModalDemo() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <Demo title="Modal" hint="Tap">
      <PillButton label="Open modal" onPress={() => setOpen(true)} />
      <ModalDialog visible={open} onRequestClose={() => setOpen(false)}>
        <Text style={styles.title}>Review swap</Text>
        <Text style={[styles.dimBody, { marginVertical: 12 }]}>
          Scales up from 0.96 over a dimmed backdrop.
        </Text>
        <PillButton label="Close" onPress={() => setOpen(false)} />
      </ModalDialog>
    </Demo>
  );
}

function TiltDemo() {
  const styles = useStyles();
  return (
    <Demo title="Tilt" hint="Drag">
      <TiltCard radius={20}>
        <View style={styles.tilt}>
          <Text style={styles.title}>Honey.honey</Text>
          <Text style={styles.dimSmall}>Drag across the card</Text>
        </View>
      </TiltCard>
    </Demo>
  );
}

// --- Just for fun -------------------------------------------------------------

// function HoneyRollDemo() {
//   return (
//     <Demo title="Honey wheel">
//       <HoneyRoll width={170} />
//     </Demo>
//   );
// }

const useStyles = makeStyles((c) => ({
  screen: {
    gap: 10,
    paddingHorizontal: SCREEN.gutter,
  },
  content: {
    gap: 10,
  },
  intro: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  section: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    padding: 16,
    gap: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  hint: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    overflow: 'hidden',
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 12,
    fontWeight: '600',
  },
  stage: {
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  big: {
    color: c.text,
    fontSize: 34,
    fontWeight: '500',
    letterSpacing: -0.6,
  },
  dim: {
    color: c.textSecondary,
  },
  title: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  body: {
    color: c.text,
    fontSize: 16,
  },
  dimBody: {
    color: c.textSecondary,
    fontSize: 15,
  },
  small: {
    color: c.textSecondary,
    fontSize: 13,
  },
  dimSmall: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
  error: {
    color: c.error,
    fontSize: 13,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gap: {
    gap: 6,
  },
  inset: {
    alignSelf: 'stretch',
    padding: 12,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  field: {
    alignSelf: 'stretch',
    padding: 12,
    gap: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.error,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  tilt: {
    width: 240,
    height: 140,
    padding: 18,
    justifyContent: 'flex-end',
    borderRadius: 20,
    backgroundColor: c.accentSurface,
  },
}));
