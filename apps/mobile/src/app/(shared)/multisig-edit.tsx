import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SHEET, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import {
  MEMBER_KIND_LABEL,
  ProposedPage,
  ThresholdStepper,
} from '@/components/wallet/MultisigParts';
import { EmptyState } from '@/components/wallet/parts';
import { useHandleLookup } from '@/lib/handles';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import {
  type MemberKind,
  newMemberId,
  type Proposal,
  type ProposalAction,
  propose,
  useMultisig,
  useProposal,
} from '@/lib/multisig';
import { showToast } from '@/lib/toast';
import { demoAddress, isEvmAddress, isHoneyHandle } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type Kind = 'rule' | 'limit' | 'member';

const LIMITS: (number | null)[] = [null, 100, 250, 500, 1000];

const TITLES: Record<Kind, string> = {
  rule: 'Approvals needed',
  limit: 'Daily spending limit',
  member: 'Add member',
};

/**
 * Change a shared wallet's rules: how many must approve, the daily limit, or who's a
 * member. Each change is proposed, and applies once enough members approve.
 */
export default function MultisigEditSheet() {
  const { id = '', kind = 'rule' } = useLocalSearchParams<{ id: string; kind?: Kind }>();
  const styles = useStyles();
  const c = useTheme();
  const multisig = useMultisig(id);
  const [threshold, setThreshold] = useState(multisig?.threshold ?? 1);
  const [limit, setLimit] = useState<number | null>(multisig?.dailyLimit ?? null);
  const [entry, setEntry] = useState('');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const proposal = useProposal(proposalId ?? '');
  const resolving = useHandleLookup(entry);

  if (!multisig) {
    return (
      <SheetScreen>
        <EmptyState
          icon="multisig"
          title="Shared wallet not found"
          hint="It may have been removed from this device."
          action={{ label: 'Close', onPress: closeSheet }}
        />
      </SheetScreen>
    );
  }

  const vault = multisig.purpose === 'vault';
  const submit = (action: ProposalAction) => {
    tap();
    const { proposal: p, executed } = propose(id, action);
    if (executed) {
      showToast('Changed');
      closeSheet();
    } else setProposalId(p.id);
  };

  const entryValid = (isHoneyHandle(entry) || isEvmAddress(entry)) && !resolving;
  const addPerson = () => {
    const v = entry.trim();
    const handle = isHoneyHandle(v) ? v.toLowerCase() : undefined;
    const label = handle ? handle.replace(/\.honey$/, '') : `${v.slice(0, 6)}…`;
    submit({
      type: 'addMember',
      member: {
        id: newMemberId(),
        name: label.charAt(0).toUpperCase() + label.slice(1),
        kind: 'person',
        handle,
        address: handle ? demoAddress() : v,
      },
    });
  };
  const addKey = (k: Exclude<MemberKind, 'you' | 'person'>) =>
    submit({
      type: 'addMember',
      member: { id: newMemberId(), name: MEMBER_KIND_LABEL[k], kind: k, address: demoAddress() },
    });

  const done = proposal as Proposal | undefined;

  return (
    <SheetScreen
      title={done ? 'Proposed' : TITLES[kind]}
      footer={
        done ? (
          <PillButton
            label="Done"
            onPress={() => {
              tap();
              closeSheet();
            }}
          />
        ) : kind === 'rule' ? (
          <PillButton
            label={threshold === multisig.threshold ? 'No change' : 'Propose change'}
            disabled={threshold === multisig.threshold}
            onPress={() => submit({ type: 'changeThreshold', threshold })}
          />
        ) : kind === 'limit' ? (
          <PillButton
            label={limit === multisig.dailyLimit ? 'No change' : 'Propose change'}
            disabled={limit === multisig.dailyLimit}
            onPress={() => submit({ type: 'setDailyLimit', usd: limit })}
          />
        ) : vault ? undefined : (
          <PillButton
            label={
              entryValid
                ? 'Propose adding'
                : resolving
                  ? 'Looking up name…'
                  : 'Enter a handle or address'
            }
            disabled={!entryValid}
            onPress={addPerson}
          />
        )
      }
    >
      <ContentSwap id={done ? 'done' : 'edit'} index={done ? 1 : 0}>
        {done ? (
          <ProposedPage multisig={multisig} proposal={done} />
        ) : kind === 'rule' ? (
          <View>
            <SheetText>
              Changing the rule is a proposal too: it needs {multisig.threshold} of{' '}
              {multisig.members.length} to approve.
            </SheetText>
            <View style={styles.stepper}>
              <ThresholdStepper
                value={threshold}
                members={multisig.members.length}
                onChange={setThreshold}
              />
            </View>
          </View>
        ) : kind === 'limit' ? (
          <View>
            <SheetText>
              Up to this much a day, any one member can spend without waiting for approvals. Above
              it, payments need {multisig.threshold} of {multisig.members.length}.
            </SheetText>
            <View style={styles.chips}>
              {LIMITS.map((l) => (
                <PressableScale
                  key={String(l)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: l === limit }}
                  onPress={() => {
                    tap();
                    setLimit(l);
                  }}
                  style={[styles.chip, l === limit && styles.chipActive]}
                >
                  <Text style={styles.chipLabel}>{l === null ? 'None' : formatUsd(l)}</Text>
                </PressableScale>
              ))}
            </View>
          </View>
        ) : vault ? (
          <View>
            <SheetText>Add another key. It's added once your other keys approve.</SheetText>
            {(['hardware', 'device', 'recovery'] as const).map((k) => (
              <PressableRow key={k} onPress={() => addKey(k)} style={styles.option}>
                <Icon name={k === 'device' ? 'key' : k} size={20} color={c.accentText} />
                <Text style={[styles.flex, styles.optionLabel]}>{MEMBER_KIND_LABEL[k]}</Text>
                <Icon name="plus" size={14} color={c.textSecondary} />
              </PressableRow>
            ))}
          </View>
        ) : (
          <View>
            <SheetText>
              They join once {multisig.threshold} of {multisig.members.length} approve, then get an
              invite.
            </SheetText>
            <View style={styles.field}>
              <TextInput
                value={entry}
                onChangeText={setEntry}
                placeholder="name.honey or 0x address"
                placeholderTextColor={c.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                style={styles.input}
              />
            </View>
          </View>
        )}
      </ContentSwap>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  stepper: {
    marginTop: 20,
  },
  chips: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
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
    fontWeight: '500',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    marginHorizontal: -SHEET.gutter,
    paddingHorizontal: SHEET.gutter,
  },
  optionLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  field: {
    marginTop: 16,
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  input: {
    color: c.text,
    fontSize: 17,
  },
}));
