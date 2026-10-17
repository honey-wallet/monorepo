import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, ScrollView, Share, Text, TextInput, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonList } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { closeSheet, SHEET, SheetScreen, SheetSection, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import {
  MEMBER_KIND_LABEL,
  MemberAvatar,
  NetworkBadge,
  ThresholdStepper,
} from '@/components/wallet/MultisigParts';
import { EmptyState } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { type EvmChain, loadEvmChains, matchesChain, POPULAR_EVM } from '@/lib/evm-chains';
import { success, tap } from '@/lib/haptics';
import { RECENT_RECIPIENTS, shortAddress } from '@/lib/mock-wallet';
import {
  createMultisig,
  type Member,
  type MemberKind,
  type MultisigNetwork,
  type MultisigPurpose,
  newMemberId,
  protocolFor,
  protocolName,
  recommendedThreshold,
  SOLANA_NETWORK,
  setupCost,
  yourKey,
} from '@/lib/multisig';
import { followFix, useFailure } from '@/lib/outcomes';
import { useProfile } from '@/lib/profile';
import { askForNotifications } from '@/lib/push';
import { demoAddress, isEvmAddress, isHoneyHandle } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type Page = 'name' | 'network' | 'members' | 'rule' | 'review' | 'done' | 'failed';
const PAGES: Page[] = ['name', 'network', 'members', 'rule', 'review', 'done', 'failed'];

const TITLES: Record<Page, string> = {
  name: 'New shared wallet',
  network: 'Network',
  members: 'Members',
  rule: 'Approvals',
  review: 'Review',
  done: 'Shared wallet',
  failed: 'Shared wallet',
};

/** Names offered, to save typing. */
const NAME_IDEAS: { name: string; icon: IconName }[] = [
  { name: 'Shared wallet', icon: 'multisig' },
  { name: 'Family', icon: 'heart' },
  { name: 'Vault', icon: 'shield' },
  { name: 'Treasury', icon: 'bank' },
];

/** How a shared wallet works, in three steps, on its first page. */
const HOW_IT_WORKS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'person',
    title: 'Add members',
    body: 'People you trust, or your own keys kept in other places.',
  },
  {
    icon: 'checkCircle',
    title: 'Choose how many must approve',
    body: 'Like 2 of 3, so no one can move money alone.',
  },
  {
    icon: 'shield',
    title: 'Every payment waits for a yes',
    body: 'A lost phone or a rogue member can never empty it.',
  },
];

/** Your other keys, for a vault: each a separate device or backup. */
const KEY_OPTIONS: { kind: Exclude<MemberKind, 'you' | 'person'>; icon: IconName; hint: string }[] =
  [
    { kind: 'hardware', icon: 'hardware', hint: 'Ledger or Keystone, kept somewhere safe' },
    { kind: 'device', icon: 'key', hint: 'An iPad or second phone with Honey' },
    { kind: 'recovery', icon: 'recovery', hint: 'Encrypted in iCloud, for emergencies' },
  ];

/** A full Solana address (base58, 32 to 44 characters). */
const isSolanaAddress = (v: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim());

/**
 * Create a shared wallet (multisig): what it's for, a name, the network (any EVM
 * network through Safe, or Solana through Squads), its members and how many must
 * approve. Each step is a page of this one sheet.
 */
export default function NewMultisigSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const [page, setPage] = useState<Page>('name');

  const [name, setName] = useState(NAME_IDEAS[0].name);
  const [network, setNetwork] = useState<MultisigNetwork>(POPULAR_EVM[0]);
  const [members, setMembers] = useState<Member[]>([yourKey('You')]);
  // What it's for follows from who's in it: only your own keys is a vault.
  const purpose: MultisigPurpose = members.every((m) => m.kind !== 'person')
    ? 'vault'
    : members.length > 3
      ? 'team'
      : 'family';
  const [threshold, setThreshold] = useState(1);
  const [touchedRule, setTouchedRule] = useState(false);
  const [entry, setEntry] = useState('');
  const [query, setQuery] = useState('');
  const [walletId, setWalletId] = useState<string | null>(null);

  const go = (next: Page) => {
    tap();
    Keyboard.dismiss();
    setPage(next);
  };

  // Until you pick a rule yourself, it follows the recommended majority.
  useEffect(() => {
    if (!touchedRule) setThreshold(recommendedThreshold(members.length));
    else if (threshold > members.length) setThreshold(members.length);
  }, [members.length, touchedRule, threshold]);

  const addKey = (kind: Exclude<MemberKind, 'you' | 'person'>) => {
    tap();
    const count = members.filter((m) => m.kind === kind).length;
    const label = MEMBER_KIND_LABEL[kind];
    setMembers((list) => [
      ...list,
      {
        id: newMemberId(),
        name: count ? `${label} ${count + 1}` : label,
        kind,
        address: demoAddress(),
      },
    ]);
  };

  const squads = protocolFor(network) === 'squads';
  const entryValid =
    isHoneyHandle(entry) || (squads ? isSolanaAddress(entry) : isEvmAddress(entry));
  const addPerson = (value: string, label?: string) => {
    const v = value.trim();
    if (members.some((m) => m.address === v || m.handle === v)) return;
    tap();
    const handle = isHoneyHandle(v) ? v.toLowerCase() : undefined;
    const display = label ?? (handle ? handle.replace(/\.honey$/, '') : shortAddress(v));
    setMembers((list) => [
      ...list,
      {
        id: newMemberId(),
        name: display.charAt(0).toUpperCase() + display.slice(1),
        kind: 'person',
        handle,
        address: handle ? demoAddress() : v,
      },
    ]);
    setEntry('');
  };

  const outcome = useFailure('multisig');
  const create = () => {
    if (outcome.attempt()) {
      setPage('failed');
      return;
    }
    success();
    // Now it's clear why: members will need you to approve.
    askForNotifications().catch(() => {});
    setWalletId(createMultisig({ name: name.trim(), purpose, network, members, threshold }));
    setPage('done');
  };

  const invite = () => {
    tap();
    Share.share({
      message: `Join “${name.trim()}”, a shared wallet on Honey (${protocolName(protocolFor(network))} on ${network.name}). Open: honeywallet://multisig/${walletId ?? ''}`,
    }).catch(() => {});
  };

  const back = () => {
    go(PAGES[PAGES.indexOf(page) - 1]);
  };

  return (
    <SheetScreen
      title={TITLES[page]}
      size="fill"
      onBack={page === 'name' || page === 'done' || page === 'failed' ? undefined : back}
    >
      <View>
        <ContentSwap id={page} index={PAGES.indexOf(page)}>
          <View>
            {page === 'name' && (
              <>
                <View style={styles.hero}>
                  <View style={styles.heroIcon}>
                    <Icon name="multisig" size={30} color={c.accentText} />
                  </View>
                  <Text style={styles.heroTitle}>Money that needs more than one yes</Text>
                </View>
                <View style={[styles.field, styles.nameField]}>
                  <Icon name="pencil" size={16} color={c.textSecondary} />
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Name your wallet"
                    placeholderTextColor={c.placeholder}
                    maxLength={32}
                    returnKeyType="next"
                    onSubmitEditing={() => name.trim() && go('network')}
                    style={[styles.input, styles.flex]}
                  />
                </View>
                <View style={styles.chips}>
                  {NAME_IDEAS.map((idea) => {
                    const active = name === idea.name;
                    return (
                      <PressableScale
                        key={idea.name}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => {
                          tap();
                          setName(idea.name);
                        }}
                        style={[styles.chip, styles.iconChip, active && styles.chipActive]}
                      >
                        <Icon
                          name={idea.icon}
                          size={14}
                          color={active ? c.accentText : c.textSecondary}
                        />
                        <Text style={styles.chipLabel}>{idea.name}</Text>
                      </PressableScale>
                    );
                  })}
                </View>
                <View style={styles.how}>
                  {HOW_IT_WORKS.map((step) => (
                    <View key={step.title} style={styles.howRow}>
                      <View style={styles.howIcon}>
                        <Icon name={step.icon} size={18} color={c.accentText} />
                      </View>
                      <View style={styles.flex}>
                        <Text style={styles.howTitle}>{step.title}</Text>
                        <Text style={styles.howBody}>{step.body}</Text>
                      </View>
                    </View>
                  ))}
                </View>
                <View style={styles.flex} />
                <PillButton
                  label={name.trim() ? 'Continue' : 'Name your wallet'}
                  disabled={!name.trim()}
                  onPress={() => go('network')}
                  style={styles.cta}
                />
              </>
            )}

            {page === 'network' && (
              <NetworkPage
                query={query}
                onQuery={setQuery}
                selected={network}
                onPick={(n) => {
                  setNetwork(n);
                  // People added by address must match the network family.
                  setMembers((list) =>
                    list.filter(
                      (m) =>
                        m.kind !== 'person' ||
                        !!m.handle ||
                        (protocolFor(n) === 'squads'
                          ? isSolanaAddress(m.address)
                          : isEvmAddress(m.address)),
                    ),
                  );
                  go('members');
                }}
              />
            )}

            {page === 'members' && (
              <>
                <ScrollView
                  style={styles.flex}
                  alwaysBounceVertical={false}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <Text style={styles.lead}>
                    Add the people who share it, or your own keys kept in other places.
                  </Text>
                  {members.map((m) => (
                    <View key={m.id} style={styles.member}>
                      <MemberAvatar member={m} size={38} />
                      <View style={styles.flex}>
                        <Text style={styles.memberName}>
                          {m.kind === 'you' ? `${m.name} (${profile.name})` : m.name}
                        </Text>
                        <Text style={styles.memberSub}>
                          {m.kind === 'you'
                            ? 'A new key on this device, just for this wallet'
                            : (m.handle ??
                              (m.kind === 'person'
                                ? shortAddress(m.address)
                                : MEMBER_KIND_LABEL[m.kind]))}
                        </Text>
                      </View>
                      {m.kind === 'you' ? null : (
                        <PressableScale
                          accessibilityLabel={`Remove ${m.name}`}
                          hitSlop={10}
                          onPress={() => {
                            tap();
                            setMembers((list) => list.filter((x) => x.id !== m.id));
                          }}
                        >
                          <Icon name="close" size={14} color={c.textSecondary} />
                        </PressableScale>
                      )}
                    </View>
                  ))}

                  {/* People, by Honey handle or address */}
                  <View style={[styles.field, styles.addField]}>
                    <TextInput
                      value={entry}
                      onChangeText={setEntry}
                      placeholder={
                        squads ? 'name.honey or Solana address' : 'name.honey or 0x address'
                      }
                      placeholderTextColor={c.placeholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      onSubmitEditing={() => entryValid && addPerson(entry)}
                      style={[styles.input, styles.flex]}
                    />
                    <PressableScale
                      accessibilityLabel="Add member"
                      disabled={!entryValid}
                      onPress={() => addPerson(entry)}
                      style={[styles.addButton, !entryValid && styles.dim]}
                    >
                      <Icon name="plus" size={16} color={c.onPrimary} />
                    </PressableScale>
                  </View>
                  {squads ? null : (
                    <>
                      <SheetSection title="Recent" />
                      <View style={styles.chips}>
                        {RECENT_RECIPIENTS.filter((r) => !r.label)
                          .slice(0, 4)
                          .map((r) => (
                            <PressableScale
                              key={r.id}
                              accessibilityRole="button"
                              onPress={() => addPerson(r.address, r.label)}
                              style={styles.chip}
                            >
                              <Text style={styles.chipLabel}>
                                {r.label ?? shortAddress(r.address)}
                              </Text>
                            </PressableScale>
                          ))}
                      </View>
                    </>
                  )}
                  {/* Or more keys of your own, kept somewhere else */}
                  <SheetSection title="Or add your own key" />
                  {KEY_OPTIONS.map((k) => (
                    <PressableRow key={k.kind} onPress={() => addKey(k.kind)} style={styles.option}>
                      <View style={styles.cardIcon}>
                        <Icon name={k.icon} size={20} color={c.accentText} />
                      </View>
                      <View style={styles.flex}>
                        <Text style={styles.memberName}>{MEMBER_KIND_LABEL[k.kind]}</Text>
                        <Text style={styles.memberSub}>{k.hint}</Text>
                      </View>
                      <Icon name="plus" size={14} color={c.textSecondary} />
                    </PressableRow>
                  ))}
                </ScrollView>
                <PillButton
                  label={members.length < 2 ? 'Add at least one more' : 'Continue'}
                  disabled={members.length < 2}
                  onPress={() => go('rule')}
                  style={styles.cta}
                />
              </>
            )}

            {page === 'rule' && (
              <>
                <Text style={styles.lead}>
                  How many must approve before money moves or the wallet changes?
                </Text>
                <View style={styles.flex} />
                <ThresholdStepper
                  value={threshold}
                  members={members.length}
                  onChange={(n) => {
                    setTouchedRule(true);
                    setThreshold(n);
                  }}
                />
                <View style={styles.flex} />
                <PillButton label="Continue" onPress={() => go('review')} style={styles.cta} />
              </>
            )}

            {page === 'review' && (
              <>
                <View style={styles.summary}>
                  <NetworkBadge network={network} size={48} />
                  <Text style={styles.summaryName}>{name.trim()}</Text>
                  <Text style={styles.summarySub}>
                    {members.length}{' '}
                    {purpose === 'vault'
                      ? members.length === 1
                        ? 'key'
                        : 'keys'
                      : members.length === 1
                        ? 'member'
                        : 'members'}
                  </Text>
                </View>
                <StatRow label="Approvals" value={`${threshold} of ${members.length}`} />
                <StatRow
                  label="Network"
                  value={`${protocolName(protocolFor(network))} · ${network.name}`}
                />
                <StatRow
                  label={purpose === 'vault' ? 'Keys' : 'Members'}
                  value={
                    <View style={styles.faces}>
                      {members.map((m, i) => (
                        <View key={m.id} style={i > 0 && styles.faceOverlap}>
                          <MemberAvatar member={m} size={24} />
                        </View>
                      ))}
                    </View>
                  }
                />
                <StatRow label="Setup cost" value={setupCost(network)} />
                <View style={styles.flex} />
                <Text style={styles.note}>
                  Honey sets up the {protocolName(protocolFor(network))} wallet with a new key of
                  yours, separate from your Honey wallet. Changing members or the rule later needs
                  approvals too.
                </Text>
                <PillButton label="Create shared wallet" onPress={create} style={styles.cta} />
              </>
            )}

            {page === 'failed' && outcome.failure && (
              <FailurePage
                failure={outcome.failure}
                rows={[
                  { label: 'Wallet', value: name.trim() },
                  { label: 'Network', value: network.name },
                ]}
                onRetry={() => {
                  tap();
                  if (outcome.failure && followFix(outcome.failure)) return;
                  go('review');
                }}
                onClose={() => {
                  tap();
                  closeSheet();
                }}
              />
            )}

            {page === 'done' && (
              <>
                <SuccessPage
                  title="Shared wallet ready"
                  detail={`${name.trim()} · ${threshold} of ${members.length} on ${network.name}.${
                    purpose === 'vault' ? '' : ' Invite the others so they can approve.'
                  }`}
                />
                {purpose === 'vault' ? null : (
                  <PillButton
                    label="Invite members"
                    variant="secondary"
                    onPress={invite}
                    style={styles.cta}
                  />
                )}
                <PillButton
                  label="Open wallet"
                  onPress={() => {
                    tap();
                    router.dismissAll();
                    if (walletId)
                      router.push({ pathname: '/multisig/[id]', params: { id: walletId } });
                  }}
                  style={styles.ctaTight}
                />
              </>
            )}
          </View>
        </ContentSwap>
      </View>
    </SheetScreen>
  );
}

/**
 * Pick the network: Solana (Squads) and popular EVM networks first; typing searches
 * every EVM mainnet in the chainlist registry, fetched on first search.
 */
function NetworkPage({
  query,
  onQuery,
  selected,
  onPick,
}: {
  query: string;
  onQuery: (q: string) => void;
  selected: MultisigNetwork;
  onPick: (n: MultisigNetwork) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [all, setAll] = useState<EvmChain[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped by Try again, to rerun the fetch after a failure.
  const [attempt, setAttempt] = useState(0);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!searching || all) return;
    void attempt;
    let live = true;
    setFailed(false);
    loadEvmChains()
      .then((list) => live && setAll(list))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [searching, all, attempt]);

  const evm = (searching ? (all ?? POPULAR_EVM) : POPULAR_EVM).filter((ch) =>
    matchesChain(ch, query),
  );
  const showSolana = !searching || 'solana'.includes(query.trim().toLowerCase());
  const row = (n: MultisigNetwork & { color?: string }, hint: string) => {
    const active = n.chainId === selected.chainId && n.name === selected.name;
    return (
      <PressableRow key={`${n.chainId}-${n.name}`} onPress={() => onPick(n)} style={styles.option}>
        <NetworkBadge network={n} size={34} />
        <View style={styles.flex}>
          <Text style={styles.memberName}>{n.name}</Text>
          <Text style={styles.memberSub}>{hint}</Text>
        </View>
        {active ? <Icon name="check" size={15} color={c.accentText} /> : null}
      </PressableRow>
    );
  };

  return (
    <>
      <SearchField
        value={query}
        onChangeText={onQuery}
        placeholder="Search EVM networks"
        style={styles.search}
      />
      <ScrollView
        style={styles.flex}
        alwaysBounceVertical={false}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {showSolana ? row(SOLANA_NETWORK, `Squads · ${setupCost(SOLANA_NETWORK)}`) : null}
        <SheetSection title={searching ? 'EVM networks' : 'Popular EVM networks'} />
        {evm
          .slice(0, 80)
          .map((ch, i) =>
            row(
              ch,
              `Safe · ${setupCost(ch)}${!searching && i === 0 ? ' · Recommended' : ''}${
                searching ? ` · Chain ${ch.chainId}` : ''
              }`,
            ),
          )}
        {searching && !all && !failed ? (
          <SkeletonList count={3} icon={34} trailing={false} />
        ) : null}
        {searching && failed ? (
          <EmptyState
            compact
            icon="warning"
            title="Couldn't load every network"
            hint="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => setAttempt((n) => n + 1) }}
          />
        ) : null}
        {searching && all && evm.length === 0 && !showSolana ? (
          <EmptyState
            compact
            icon="search"
            title="No networks found"
            hint={`No EVM network matches “${query.trim()}”. Try a name or chain ID.`}
            action={{ label: 'Clear search', onPress: () => onQuery('') }}
          />
        ) : null}
        {!searching ? (
          <Text style={styles.note}>
            Safe works on any EVM network. Search by name or chain ID to see all of them.
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  lead: {
    marginBottom: 16,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  hero: {
    alignItems: 'center',
    gap: 14,
    paddingTop: 4,
    paddingBottom: 22,
  },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  heroTitle: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  nameField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  how: {
    marginTop: 28,
    padding: 16,
    gap: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  howRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  howIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  howTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  howBody: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  card: {
    marginBottom: 10,
    padding: 16,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: c.card,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  cardTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  cardBody: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  field: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  addField: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingRight: 8,
  },
  input: {
    color: c.text,
    fontSize: 17,
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  dim: {
    opacity: 0.4,
  },
  chips: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.divider,
  },
  chipActive: {
    borderColor: c.primary,
    backgroundColor: c.accentSurface,
  },
  chipLabel: {
    color: c.text,
    fontSize: 15,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  memberName: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  memberSub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -SHEET.gutter,
    paddingHorizontal: SHEET.gutter,
  },
  search: {
    marginBottom: 8,
  },
  summary: {
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    paddingBottom: 20,
  },
  summaryName: {
    marginTop: 6,
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
  },
  summarySub: {
    color: c.textSecondary,
    fontSize: 15,
  },
  faces: {
    flexDirection: 'row',
  },
  faceOverlap: {
    marginLeft: -6,
  },
  note: {
    marginTop: 12,
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
  ctaTight: {
    marginTop: 10,
  },
}));
