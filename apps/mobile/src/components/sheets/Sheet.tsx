import { router } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonRow } from '@/components/motion/Skeleton';
import { TRAY_CLOSE, useInTray } from '@/components/sheets/Tray';
import { useActiveMultisig } from '@/lib/multisig';
import { goBackOr, leaveSheetTo } from '@/lib/navigation';
import { AVAILABLE_TRADE_MODES, useSettings } from '@/lib/settings';
import { makeStyles, useTheme } from '@/theme';

/**
 * Standard sheet spacing. Every bottom sheet uses these, so sheets line up with
 * each other: same gap under the grabber, same gutters, same space above the
 * home indicator.
 */
/** In a tray, the header row's top: centres it on the close button. */
const TRAY_HEADER_TOP = TRAY_CLOSE.top + TRAY_CLOSE.size / 2 - 22;
const TRAY_BOTTOM = 20;

export const SHEET = {
  /** Space between the grabber and the title row. */
  top: 24,
  gutter: 20,
  /** Space above the home indicator (added to the bottom safe-area inset). */
  bottom: 6,
  /** Space between the content and the footer buttons. */
  footerGap: 20,
} as const;

type SheetScreenProps = {
  /** Shown in the standard header. Omit when pages draw their own (e.g. nested pages). */
  title?: string;
  onBack?: () => void;
  /** A bare icon button at the header's right, e.g. Share. */
  right?: ReactNode;
  /**
   * `fit` (default) sizes to the content, for `fitToContents` sheets. `fill` takes the
   * sheet's full height and pins the footer to the bottom, for fixed-detent sheets.
   */
  size?: 'fit' | 'fill';
  /** Scroll the content under a pinned title (long lists). */
  scroll?: boolean;
  /** With `scroll`: extra content pinned under the title, e.g. a search field. */
  sticky?: ReactNode;
  /** Buttons at the bottom, e.g. a `PillButton`; wrap several in a row yourself. */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/**
 * The frame every sheet uses: grabber gap, title, gutters, content, footer and the
 * bottom safe area. Sheets only supply their content.
 */
export function SheetScreen({
  title,
  onBack,
  right,
  size = 'fit',
  scroll,
  sticky,
  footer,
  contentStyle,
  children,
}: SheetScreenProps) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const inTray = useInTray();
  // A tray sizes itself to its content and scrolls when it must, so inside one every
  // sheet is a fitted one: no full-height fill, no scroll root of its own.
  const fill = !inTray && (size === 'fill' || !!scroll);
  const clear = useStatusBarClearance(fill);
  const header = title ? <SheetHeader title={title} onBack={onBack} right={right} /> : null;
  const footerView = footer ? <View style={styles.footer}>{footer}</View> : null;
  // iOS sizes fitted sheets clear of the home indicator itself; adding the inset
  // again left a tall gap under the buttons.
  const bottom = (fill || Platform.OS !== 'ios' ? insets.bottom : 0) + SHEET.bottom;
  // A tray floats above the home indicator and has no grabber: its header lines up
  // with the close button, and the footer gets the room a sheet's home indicator took.
  const top = inTray ? (header ? TRAY_HEADER_TOP : SHEET.top) : SHEET.top + clear.top;

  if (scroll && !inTray) {
    // The ScrollView must be the sheet's root: iOS form sheets lay a ScrollView out
    // against the sheet itself, so wrapping it leaves it zero-height, and a title
    // placed above it floats over the rows. The title (and any `sticky` content) is
    // pinned as a sticky header instead, and the footer ends the list.
    return (
      <ScrollView
        onLayout={clear.onLayout}
        alwaysBounceVertical={false}
        style={[styles.root, styles.fill]}
        stickyHeaderIndices={header || sticky ? [0] : undefined}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.gutter,
          !header && !sticky && { paddingTop: SHEET.top + clear.top },
          { paddingBottom: bottom },
          contentStyle,
        ]}
      >
        {(header || sticky) && (
          <View style={[styles.stickyHeader, { paddingTop: SHEET.top + clear.top }]}>
            {header}
            {sticky}
          </View>
        )}
        {children}
        {footerView}
      </ScrollView>
    );
  }

  return (
    <View
      onLayout={clear.onLayout}
      style={[
        styles.root,
        styles.gutter,
        fill && styles.fill,
        { paddingTop: top, paddingBottom: inTray ? TRAY_BOTTOM : bottom },
      ]}
    >
      {header}
      {inTray && scroll && sticky ? (
        // With no title row, keep the pinned content (a search field) clear of the close button.
        <View style={!header && styles.trayClear}>{sticky}</View>
      ) : null}
      <View style={[fill && styles.fill, contentStyle]}>{children}</View>
      {footerView}
    </View>
  );
}

/**
 * Extra top padding for when iOS stretches a full-height sheet up to the top edge
 * (pulling it up on iOS 26 can), so its header isn't hidden under the status bar
 * and Dynamic Island. A sheet in its usual place stops about a status bar short of
 * the top; one that's as tall as the screen has ridden up under it. Zero otherwise.
 */
function useStatusBarClearance(fill: boolean) {
  const insets = useSafeAreaInsets();
  const { height: screen } = useWindowDimensions();
  const [top, setTop] = useState(0);
  // The first layout comes before iOS has sized the sheet (it reports the whole
  // screen), so only later ones are trusted.
  const sized = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    if (!fill || Platform.OS !== 'ios') return;
    if (!sized.current) {
      sized.current = true;
      return;
    }
    const gap = screen - e.nativeEvent.layout.height;
    setTop(gap < insets.top / 2 ? Math.round(insets.top - gap) : 0);
  };
  return { onLayout, top };
}

/** Title row for bottom sheets, with an optional back chevron for nested pages. */
export function SheetHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const inTray = useInTray();
  if (inTray) {
    // Tray header: the title reads from the left, after a back chevron on later steps;
    // the tray's own close button sits at the far right.
    return (
      <View style={[styles.header, styles.trayHeader]}>
        {onBack ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={10}
            onPress={onBack}
            style={styles.trayBack}
          >
            <Icon name="chevronLeft" size={14} color={c.textSecondary} />
          </PressableScale>
        ) : null}
        <Text style={styles.trayTitle} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {/* Bare icons (Share…) sit just before the tray's own close button. */}
        {right}
      </View>
    );
  }
  return (
    <View style={styles.header}>
      <View style={styles.side}>
        {onBack ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            scaleTo={0.97}
            onPress={onBack}
          >
            <Icon name="chevronLeft" size={18} color={c.textSecondary} />
          </PressableScale>
        ) : null}
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

/** Grey heading above a group of rows, e.g. "Preferences". */
export function SheetSection({ title }: { title: string }) {
  const styles = useStyles();
  return <Text style={styles.section}>{title}</Text>;
}

/** A labelled group of options (e.g. OptionChips) with a one-line explanation. */
export function SheetField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.field}>
      <SheetSection title={label} />
      <View style={styles.fieldOptions}>{children}</View>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Ends every section's settings sheet (Trade, Search, Savings, Activity): makes
 * clear these are that section's settings, and leads to the wallet-wide ones.
 */
export function WalletSettingsRow({ tradeTabs = false }: { tradeTabs?: boolean }) {
  const styles = useStyles();
  const settings = useSettings();
  const multisig = useActiveMultisig();
  return (
    <View style={styles.walletSettings}>
      {/* On Trade's settings: add, hide or reorder the product tabs. */}
      {/* Not on a shared wallet: it only ever has Swap. */}
      {tradeTabs && !multisig && (
        <SheetRow
          icon="trade"
          title="Trade tabs"
          subtitle="Add, hide or reorder products"
          value={`${settings.tradeTabs.filter((m) => AVAILABLE_TRADE_MODES.includes(m)).length} of ${AVAILABLE_TRADE_MODES.length}`}
          accessory="chevron"
          onPress={() => router.replace('/trade-tabs')}
        />
      )}
      <SheetRow
        icon="settings"
        title="Wallet settings"
        subtitle="Theme, currency, security and more"
        accessory="chevron"
        onPress={() => leaveSheetTo('/settings')}
      />
    </View>
  );
}

/** Centred explanatory text under a sheet's title. */
export function SheetText({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.text}>{children}</Text>;
}

type SheetRowProps = {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** A custom leading element (avatar, token logo) instead of `icon`. */
  leading?: ReactNode;
  /** Grey text on the right, e.g. the current value. */
  value?: string;
  /**
   * What sits at the far right: a chevron for rows that open something, a check
   * for the selected option in a picker, or any element (e.g. a `Toggle`).
   */
  accessory?: 'chevron' | 'check' | ReactNode;
  onPress?: () => void;
  /** Marks the row as the current choice (shows the check for `accessory="check"`). */
  selected?: boolean;
  destructive?: boolean;
  /** Read instead of the title, e.g. to add ", current wallet". */
  accessibilityLabel?: string;
};

/**
 * The one row style for sheets: optional icon, title with optional subtitle, value,
 * and accessory. Rows run edge to edge so the press highlight fills the sheet width.
 */
export function SheetRow({
  title,
  subtitle,
  icon,
  leading,
  value,
  accessory,
  onPress,
  selected,
  destructive,
  accessibilityLabel,
}: SheetRowProps) {
  const styles = useStyles();
  const c = useTheme();
  const tint = destructive ? c.error : c.text;
  const content = (
    <>
      {leading ??
        (icon && (
          <View style={styles.rowIcon}>
            <Icon name={icon} size={22} color={tint} />
          </View>
        ))}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: tint }]}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {accessory === 'chevron' ? (
        <Icon name="chevronRight" size={14} color={c.textSecondary} />
      ) : accessory === 'check' ? (
        selected ? (
          <Icon name="check" size={18} color={c.accentText} />
        ) : null
      ) : (
        accessory
      )}
    </>
  );
  if (!onPress) {
    return (
      <View
        style={styles.row}
        accessible={!!accessibilityLabel}
        accessibilityLabel={accessibilityLabel}
      >
        {content}
      </View>
    );
  }
  return (
    <PressableRow
      accessibilityRole={accessory === 'check' ? 'radio' : 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={styles.row}
    >
      {content}
    </PressableRow>
  );
}

/**
 * `count` stand-ins for `SheetRow`s with a `leading` icon of size `icon`, spaced like the
 * real rows so the list doesn't shift when it arrives.
 */
export function SheetRowSkeletons({
  count = 4,
  icon = 40,
  trailing = true,
}: {
  count?: number;
  icon?: number;
  trailing?: boolean;
}) {
  const styles = useStyles();
  return (
    <View>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          key={i}
          icon={icon}
          trailing={trailing}
          style={styles.skeletonRow}
        />
      ))}
    </View>
  );
}

/** "Label ........ value" rows used on detail screens and sheets. */
export function StatRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.stat}>
      {icon}
      <Text style={styles.statLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={styles.statValue}>{value}</Text> : value}
    </View>
  );
}

/** Closes the current sheet, or goes home if it was opened directly. */
export function closeSheet() {
  goBackOr('/home');
}

const useStyles = makeStyles((c) => ({
  field: {
    marginBottom: 8,
  },
  fieldOptions: {
    marginTop: 6,
  },
  fieldHint: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  walletSettings: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.divider,
  },
  root: {
    backgroundColor: c.sheet,
  },
  fill: {
    flex: 1,
  },
  gutter: {
    paddingHorizontal: SHEET.gutter,
  },
  stickyHeader: {
    backgroundColor: c.sheet,
  },
  footer: {
    marginTop: SHEET.footerGap,
  },
  header: {
    height: 44,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: {
    width: 32,
  },
  sideRight: {
    alignItems: 'flex-end',
  },
  // Title from the left (after a round back button on later steps), then any bare
  // icons, then the tray's own close button.
  trayHeader: {
    gap: 10,
    paddingRight: TRAY_CLOSE.size + TRAY_CLOSE.right - SHEET.gutter + 8,
  },
  trayClear: {
    paddingRight: TRAY_CLOSE.size + TRAY_CLOSE.right - SHEET.gutter + 8,
  },
  trayBack: {
    width: TRAY_CLOSE.size,
    height: TRAY_CLOSE.size,
    borderRadius: TRAY_CLOSE.size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  trayTitle: {
    flex: 1,
    color: c.text,
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
  section: {
    marginTop: 16,
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  text: {
    marginBottom: 12,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  skeletonRow: {
    minHeight: 56,
    gap: 14,
    paddingVertical: 8,
  },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 8,
    // Bleed past the gutter so the press highlight runs edge to edge.
    marginHorizontal: -SHEET.gutter,
    paddingHorizontal: SHEET.gutter,
  },
  // Fixed width so labels line up whatever the icon's shape.
  rowIcon: {
    width: 26,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 17,
  },
  rowSubtitle: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  rowValue: {
    color: c.textSecondary,
    fontSize: 16,
  },
  stat: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statLabel: {
    flex: 1,
    color: c.text,
    fontSize: 16,
  },
  statValue: {
    color: c.text,
    fontSize: 16,
  },
}));
