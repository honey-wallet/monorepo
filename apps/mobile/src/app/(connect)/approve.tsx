import type { Answer, Approval, ApprovalKind, Site } from '@honey-wallet/extension/protocol';
import { evmNetwork } from '@honey-wallet/keyring';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatEther, formatUnits } from 'viem';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { CHECKBOX_SIZE, Checkbox } from '@/components/motion/Checkbox';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, StatRow } from '@/components/sheets/Sheet';
import { confirmOwner } from '@/lib/auth';
import {
  answerApproval,
  claimApproval,
  hasWorker,
  keepWorkerAwake,
  nextApproval,
} from '@/lib/dapp';
import {
  approvalReviewError,
  type EvmSendPreparation,
  type EvmTx,
  evmMessageBytes,
  fromBase64,
  inspectEvmCall,
  isPermit,
  performApproval,
  prepareEvmSend,
  readableMessage,
  reasonOf,
  siweDomain,
  solanaSummary,
  TYPED_ROW_LIMIT,
  typedDataReview,
} from '@/lib/dapp-sign';
import { failure, success, tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { hostOf, multisigOf, propose, useMultisigState } from '@/lib/multisig';
import { goBackOr } from '@/lib/navigation';
import { isWeb } from '@/lib/platform';
import { useProfile } from '@/lib/profile';
import {
  type AddedWallet,
  allWallets,
  isFixtureWallet,
  isMainWallet,
  useWallets,
} from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/**
 * Honey for Chrome's approval window: a website asked to connect, sign or send, and this
 * is where you say yes or no. One request at a time, oldest first; the window closes when
 * none are left. Keys are only read after you approve (lib/dapp-sign.ts).
 */
export default function ApproveScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const [approval, setApproval] = useState<Approval | null | undefined>(undefined);

  const loadNext = async () => {
    const next = await nextApproval();
    setApproval(next);
    // Done: the extension closes its window; the phone goes back to where it was.
    if (!next) {
      if (hasWorker) globalThis.close?.();
      else if (!isWeb) goBackOr('/home');
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    void loadNext();
    return keepWorkerAwake();
  }, []);

  return (
    <View
      style={[styles.screen, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}
    >
      {approval ? (
        <Request key={approval.id} approval={approval} onAnswered={loadNext} />
      ) : approval === null ? (
        <Empty />
      ) : (
        <ActivityIndicator style={styles.loading} />
      )}
    </View>
  );
}

function Empty() {
  const styles = useStyles();
  return (
    <View style={styles.center}>
      <Text style={styles.title}>Nothing to approve</Text>
      <Text style={styles.body}>Requests from websites show up here.</Text>
    </View>
  );
}

// Who's asking

const TITLES: Record<ApprovalKind, string> = {
  connect: 'Connect',
  switchChain: 'Switch network',
  evmSign: 'Sign message',
  evmTypedData: 'Sign message',
  evmSend: 'Confirm transaction',
  solanaSignMessage: 'Sign message',
  solanaSignTransaction: 'Sign transaction',
  solanaSend: 'Confirm transaction',
};

function SiteChip({ approval }: { approval: Approval }) {
  const styles = useStyles();
  const c = useTheme();
  const [broken, setBroken] = useState(false);
  // Plain http is only fine on this computer (a developer's own site).
  const secure =
    approval.origin.startsWith('https://') ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(approval.origin);
  return (
    <View style={styles.chip}>
      {approval.icon && !broken ? (
        <Image
          source={{ uri: approval.icon }}
          style={styles.favicon}
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon name="globe" size={16} color={c.textSecondary} />
      )}
      <Text style={styles.chipText} numberOfLines={1}>
        {hostOf(approval.origin)}
      </Text>
      {secure ? null : <Icon name="warning" size={14} color={c.error} />}
      {approval.verified === 'valid' ? (
        <Icon name="verified" size={14} color={c.accentText} />
      ) : null}
    </View>
  );
}

/** A wallet that can answer this site: its keys are here, or it's a shared wallet you're in. */
type Signer = { wallet: AddedWallet; evm: string | null; solana: string | null; shared: boolean };

function useSigners(): Signer[] {
  const profile = useProfile();
  const { added } = useWallets();
  const shared = useMultisigState();
  return useMemo(
    () =>
      allWallets(profile.name, added).flatMap((wallet): Signer[] => {
        if (wallet.watchOnly || isFixtureWallet(wallet)) return [];
        const m = multisigOf(shared, wallet.id);
        if (m) {
          const safe = m.protocol === 'safe';
          return [
            {
              wallet,
              evm: safe ? wallet.address : null,
              solana: safe ? null : wallet.address,
              shared: true,
            },
          ];
        }
        if (!wallet.addresses) return [];
        return [
          {
            wallet,
            evm: wallet.addresses.evm ?? null,
            solana: wallet.addresses.solana ?? null,
            shared: false,
          },
        ];
      }),
    [profile.name, added, shared],
  );
}

// One request

function Request({ approval, onAnswered }: { approval: Approval; onAnswered: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const signers = useSigners();
  const { activeId } = useWallets();
  const namespace = (approval.params as { namespace?: 'evm' | 'solana' })?.namespace ?? 'evm';
  const eligible = signers.filter((s) => (namespace === 'evm' ? s.evm : s.solana));
  const [picked, setPicked] = useState(
    () => (eligible.find((s) => s.wallet.id === activeId) ?? eligible[0])?.wallet.id,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evmSendPreparation, setEvmSendPreparation] = useState<EvmSendPreparation | null>(null);
  // A signer/provider failure may be retried after the request crossed its atomic
  // approval boundary. Keep the worker claim for this mounted approval screen.
  const [claimed, setClaimed] = useState(false);
  // A site flagged as a scam needs this ticked first, so one tap can't approve it.
  const scam = approval.verified === 'scam';
  const [riskAccepted, setRiskAccepted] = useState(false);
  const requiresFallbackConsent =
    approval.kind === 'evmSend' &&
    (approval.params as { tx: EvmTx }).tx.data === '0x' &&
    (approval.params as { tx: EvmTx }).tx.to !== null;
  const [fallbackAccepted, setFallbackAccepted] = useState(false);
  const site = approval.site;
  const signer = signers.find((s) => s.wallet.id === (site?.walletId ?? picked));

  const shared = useMultisigState();
  const sharedNetwork = signer?.shared ? multisigOf(shared, signer.wallet.id)?.network : undefined;
  const wrongNetwork =
    approval.kind === 'evmSend' && sharedNetwork && site && sharedNetwork.chainId !== site.chainId
      ? `${signer?.wallet.label} is on ${sharedNetwork.name}. Switch the site to ${sharedNetwork.name} first.`
      : null;

  const reviewError = approvalReviewError(approval);

  const send = async (answer: Answer) => {
    await answerApproval(answer);
    onAnswered();
  };
  const cancel = () => {
    tap();
    void send({ id: approval.id, error: { code: 4001, message: 'You cancelled this in Honey.' } });
  };

  // What this request needs before it can be approved, and why it can't be.
  // A site WalletConnect flags as a scam isn't blocked: you're warned and decide (testnet
  // or not), as with an unverified one.
  // Was: approval.verified === 'scam' ? 'WalletConnect flags this site as a known scam. Honey won’t continue.' :
  const blocked =
    approval.kind === 'switchChain'
      ? null
      : approval.kind === 'connect'
        ? eligible.length
          ? null
          : namespace === 'evm'
            ? 'Add a wallet to Honey first.'
            : 'None of your wallets has a Solana address.'
        : !signer
          ? 'The wallet this site connected to isn’t in Honey anymore.'
          : signer.shared && approval.kind !== 'evmSend'
            ? 'Shared wallets can only send transactions to sites for now, not sign messages.'
            : (wrongNetwork ?? reviewError);

  const approve = async () => {
    if (
      busy ||
      blocked ||
      (scam && !riskAccepted) ||
      (requiresFallbackConsent && !fallbackAccepted) ||
      (approval.kind === 'evmSend' && !signer?.shared && evmSendPreparation?.status !== 'ready')
    )
      return;
    tap();
    setBusy(true);
    setError(null);
    try {
      // Connecting reveals wallet addresses. Require the same owner confirmation on
      // native and web, where the password prompt is the browser vault's re-auth gate.
      if (
        (approval.kind === 'connect' || (!isWeb && approval.kind !== 'switchChain')) &&
        !(await confirmOwner(`Approve for ${hostOf(approval.origin)}`))
      ) {
        setBusy(false);
        return;
      }
      // Disconnect may revoke a request while this approval window is still open.
      // Claiming atomically establishes that owner approval began before revocation.
      if (!claimed) {
        if (!(await claimApproval(approval.id))) {
          setBusy(false);
          setError('This request is no longer active.');
          await onAnswered();
          return;
        }
        setClaimed(true);
      }
      if (approval.kind === 'connect') {
        const s = eligible.find((x) => x.wallet.id === picked);
        if (!s) throw new Error('Pick a wallet');
        await send({
          id: approval.id,
          connect: {
            walletId: s.wallet.id,
            walletName: s.wallet.label,
            evm: s.evm,
            solana: s.solana,
          },
        });
      } else if (signer?.shared && approval.kind === 'evmSend' && site) {
        // A shared wallet doesn't sign alone: the transaction becomes a proposal.
        const tx = (approval.params as { tx: EvmTx }).tx;
        const network = evmNetwork(site.chainId);
        const { executed } = propose(signer.wallet.id, {
          type: 'appCall',
          site: approval.origin,
          network: network?.name ?? `Chain ${site.chainId}`,
          native: network?.native ?? 'ETH',
          to: tx.to,
          value: tx.value,
          data: tx.data,
          usd: 0,
        });
        await send({
          id: approval.id,
          error: {
            code: 4001,
            message: executed
              ? `${signer.wallet.label} ran it right away (one approval needed).`
              : `Sent to ${signer.wallet.label} for approval. It runs once enough members approve.`,
          },
        });
      } else {
        const prepared =
          approval.kind === 'evmSend' && evmSendPreparation?.status === 'ready'
            ? evmSendPreparation.prepared
            : undefined;
        await send(await performApproval(approval, signer?.wallet.id ?? '', prepared));
      }
      success();
    } catch (e) {
      failure();
      setBusy(false);
      setError(reasonOf(e));
    }
  };

  const primary =
    approval.kind === 'connect'
      ? 'Connect'
      : approval.kind === 'switchChain'
        ? 'Switch'
        : signer?.shared && approval.kind === 'evmSend'
          ? 'Propose'
          : approval.kind === 'evmSend' || approval.kind === 'solanaSend'
            ? 'Confirm'
            : 'Sign';

  return (
    <>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <SiteChip approval={approval} />
        <TextsReveal
          id={approval.kind}
          align="center"
          first={<Text style={styles.title}>{TITLES[approval.kind]}</Text>}
        />
        {/* A scam flag is one red alert with its tick, at the bottom (scamAlert below). */}
        {approval.verified && approval.verified !== 'valid' && !scam ? (
          <Warning
            text={
              approval.verified === 'invalid'
                ? 'This site isn’t the one it claims to be: its domain check failed.'
                : 'WalletConnect couldn’t confirm this site’s address. Make sure it’s the site you meant.'
            }
          />
        ) : null}
        {approval.kind === 'connect' ? (
          <Connect signers={eligible} picked={picked} onPick={setPicked} />
        ) : (
          <>
            {signer && site ? (
              <WalletLine signer={signer} site={site} kind={approval.kind} />
            ) : null}
            <Details
              approval={approval}
              shared={!!signer?.shared}
              preparation={evmSendPreparation}
              onPreparation={setEvmSendPreparation}
            />
          </>
        )}
        {blocked || error ? (
          <View style={styles.alert}>
            <Icon name="warning" size={16} color={c.error} />
            <Text style={styles.alertText}>{blocked ?? error}</Text>
          </View>
        ) : null}
      </ScrollView>
      {scam ? (
        <View style={styles.scamAlert}>
          {/* The icon in a box the checkbox's size, so both lines' text starts together. */}
          <View style={styles.scamLine}>
            <View style={styles.scamIcon}>
              <Icon name="warning" size={18} color={c.error} />
            </View>
            <Text style={[styles.alertText, styles.scamText]}>
              WalletConnect flags this site as a scam.
            </Text>
          </View>
          <Checkbox
            label="I understand the risk"
            checked={riskAccepted}
            onChange={setRiskAccepted}
          />
        </View>
      ) : null}
      {requiresFallbackConsent ? (
        <View style={styles.scamAlert}>
          <Checkbox
            label="I understand this may run unreviewed contract fallback code."
            checked={fallbackAccepted}
            onChange={setFallbackAccepted}
          />
        </View>
      ) : null}
      <View style={styles.buttons}>
        <PillButton label="Cancel" variant="secondary" onPress={cancel} style={styles.flex} />
        {blocked ? null : (
          <PillButton
            label={busy ? '…' : primary}
            disabled={
              busy ||
              (scam && !riskAccepted) ||
              (requiresFallbackConsent && !fallbackAccepted) ||
              (approval.kind === 'evmSend' &&
                !signer?.shared &&
                evmSendPreparation?.status !== 'ready') ||
              (approval.kind === 'connect' && !picked)
            }
            onPress={approve}
            style={styles.flex}
          />
        )}
      </View>
    </>
  );
}

function WalletAvatar({ wallet, size }: { wallet: AddedWallet; size: number }) {
  const profile = useProfile();
  return isMainWallet(wallet) ? (
    <Avatar name={wallet.label} size={size} uri={profile.photo} seed={profile.avatarSeed} />
  ) : (
    <Avatar name={wallet.label} size={size} seed={wallet.id} />
  );
}

function Connect({
  signers,
  picked,
  onPick,
}: {
  signers: Signer[];
  picked: string | undefined;
  onPick: (id: string) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <>
      <Text style={styles.body}>Pick the wallet this site can see.</Text>
      {/* A card like the app's other lists, the note lined up under it. */}
      <View style={styles.card}>
        {signers.map((s) => (
          <SheetRow
            key={s.wallet.id}
            leading={<WalletAvatar wallet={s.wallet} size={36} />}
            title={s.wallet.label}
            subtitle={`${s.shared ? 'Shared · ' : ''}${shortAddress(s.evm ?? s.solana ?? '', 6, 4)}`}
            accessory="check"
            selected={picked === s.wallet.id}
            onPress={() => {
              tap();
              onPick(s.wallet.id);
            }}
          />
        ))}
      </View>
      <View style={[styles.note, styles.connectNote]}>
        <Icon name="eye" size={16} color={c.textSecondary} />
        <Text style={styles.noteText}>
          It sees the address and balance. It asks before moving money.
        </Text>
      </View>
    </>
  );
}

function WalletLine({ signer, site, kind }: { signer: Signer; site: Site; kind: ApprovalKind }) {
  const styles = useStyles();
  const solana = kind.startsWith('solana');
  const address = solana ? signer.solana : signer.evm;
  const network = solana ? 'Solana' : (evmNetwork(site.chainId)?.name ?? `Chain ${site.chainId}`);
  return (
    <View style={styles.card}>
      <StatRow
        label="Wallet"
        value={
          <View style={styles.walletValue}>
            <WalletAvatar wallet={signer.wallet} size={20} />
            <Text style={styles.statValue}>{signer.wallet.label}</Text>
          </View>
        }
      />
      {address ? <StatRow label="Address" value={shortAddress(address, 6, 4)} /> : null}
      {kind === 'switchChain' ? null : <StatRow label="Network" value={network} />}
    </View>
  );
}

// What it asks for

function Details({
  approval,
  shared,
  preparation,
  onPreparation,
}: {
  approval: Approval;
  shared: boolean;
  preparation: EvmSendPreparation | null;
  onPreparation: (preparation: EvmSendPreparation | null) => void;
}) {
  const p = approval.params as Record<string, unknown>;
  switch (approval.kind) {
    case 'switchChain':
      return <SwitchChain approval={approval} />;
    case 'evmSign':
      return <MessageBox approval={approval} bytes={evmMessageBytes(p.message as string)} />;
    case 'solanaSignMessage':
      return <MessageBox approval={approval} bytes={fromBase64(p.message as string)} />;
    case 'evmTypedData':
      return <TypedData approval={approval} json={p.data as string} />;
    case 'evmSend':
      return (
        <EvmSend
          approval={approval}
          shared={shared}
          preparation={preparation}
          onPreparation={onPreparation}
        />
      );
    case 'solanaSignTransaction':
    case 'solanaSend':
      return <SolanaTx approval={approval} />;
    default:
      return null;
  }
}

function Warning({ icon = 'warning', text }: { icon?: IconName; text: string }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.alert}>
      <Icon name={icon} size={16} color={c.error} />
      <Text style={styles.alertText}>{text}</Text>
    </View>
  );
}

function SwitchChain({ approval }: { approval: Approval }) {
  const styles = useStyles();
  const to = evmNetwork(approval.params as number);
  const from = approval.site ? evmNetwork(approval.site.chainId) : undefined;
  return (
    <View style={styles.card}>
      {from ? <StatRow label="From" value={from.name} /> : null}
      <StatRow label="To" value={to?.name ?? 'Unknown'} />
      {to?.testnet ? <StatRow label="Note" value="Test network: no real money" /> : null}
    </View>
  );
}

function MessageBox({ approval, bytes }: { approval: Approval; bytes: Uint8Array }) {
  const styles = useStyles();
  const { text, isText } = readableMessage(bytes);
  const siwe = approval.kind === 'evmSign' && isText ? siweDomain(text) : null;
  const host = hostOf(approval.origin);
  return (
    <>
      {siwe && siwe !== host ? (
        <Warning text={`This sign-in is for ${siwe}, not ${host}. Don’t sign it here.`} />
      ) : null}
      {isText ? null : (
        <Warning text="This isn’t readable text. Only sign if you trust the site." />
      )}
      <View style={styles.message}>
        <Text style={[styles.messageText, !isText && styles.mono]} selectable>
          {text}
        </Text>
      </View>
    </>
  );
}

function TypedData({ approval, json }: { approval: Approval; json: string }) {
  const styles = useStyles();
  const review = useMemo(() => {
    try {
      return typedDataReview(json);
    } catch {
      return null;
    }
  }, [json]);
  if (!review) return <Warning text="This request is malformed. Cancel it." />;
  const { typed } = review;
  const signedChainId = review.chainId;
  const wrongChain =
    signedChainId !== undefined && approval.site && signedChainId !== approval.site.chainId;
  return (
    <>
      {review.complete ? null : (
        <Warning
          text={`This request has missing, malformed, unbound, or more than ${TYPED_ROW_LIMIT} fields. Honey won’t sign it.`}
        />
      )}
      {!review.hasChainBinding ? (
        <Warning text="No chain ID is included in the signed domain. This signature may be valid on multiple chains." />
      ) : null}
      {isPermit(typed.primaryType as string) ? (
        <Warning text="This lets someone move your tokens without asking again. Only sign on sites you trust." />
      ) : null}
      {wrongChain ? (
        <Warning
          text={`This is for ${evmNetwork(signedChainId)?.name ?? `chain ${signedChainId}`}, not the site’s network.`}
        />
      ) : null}
      <View style={styles.card}>
        <StatRow label="Type" value={review.primaryTypeLabel} />
        <StatRow label="Signed domain fields" value={String(review.domainRows.length)} />
      </View>
      <View style={styles.message}>
        <Text style={styles.fieldKey}>Domain separator</Text>
        {review.domainRows.map(([key, value]) => (
          <Text key={`domain:${key}`} style={styles.field} selectable>
            <Text style={styles.fieldKey}>{key}</Text> {value}
          </Text>
        ))}
        <Text style={styles.fieldKey}>Signed message</Text>
        {review.messageRows.map(([key, value]) => (
          <Text key={key} style={styles.field} selectable>
            <Text style={styles.fieldKey}>{key}</Text> {value}
          </Text>
        ))}
      </View>
    </>
  );
}

/** A transaction's amount, recipient and fee. A shared wallet's runs later, so no estimate. */
function EvmSend({
  approval,
  shared,
  preparation,
  onPreparation,
}: {
  approval: Approval;
  shared: boolean;
  preparation: EvmSendPreparation | null;
  onPreparation: (preparation: EvmSendPreparation | null) => void;
}) {
  const styles = useStyles();
  const { tx, chainId } = approval.params as { tx: EvmTx; chainId: number };
  const network = evmNetwork(chainId);
  useEffect(() => {
    if (shared) {
      onPreparation(null);
      return;
    }
    let live = true;
    onPreparation({ status: 'loading' });
    prepareEvmSend(tx, chainId)
      .then((prepared) => live && onPreparation({ status: 'ready', prepared }))
      .catch((e) => live && onPreparation({ status: 'error', message: reasonOf(e) }));
    return () => {
      live = false;
    };
  }, [tx, chainId, shared, onPreparation]);
  const value = BigInt(tx.value);
  const call = inspectEvmCall(tx.data, tx.to);
  const native = network?.native ?? 'ETH';
  return (
    <>
      {!call.reviewable ? (
        <Warning text={call.reason ?? 'Honey cannot safely decode this contract call.'} />
      ) : null}
      {call.warning ? <Warning icon="info" text={call.warning} /> : null}
      {preparation?.status === 'error' ? (
        <Warning text={`This will probably fail: ${preparation.message}`} />
      ) : null}
      <View style={styles.card}>
        <StatRow label="Amount" value={`${formatEther(value)} ${native}`} />
        <StatRow
          label={tx.to ? 'To' : 'Creates'}
          value={
            tx.to ? (
              <Text style={styles.reviewValue} selectable>
                {tx.to}
              </Text>
            ) : (
              'A new contract'
            )
          }
        />
        <StatRow label="Action" value={call.label} />
        {call.rows.map(([label, value]) => (
          <StatRow
            key={label}
            label={label}
            value={
              <Text style={styles.reviewValue} selectable>
                {value}
              </Text>
            }
          />
        ))}
        <StatRow
          label="Network fee"
          value={
            shared
              ? 'Paid when it runs'
              : preparation?.status !== 'ready'
                ? 'Estimating…'
                : `Up to ${formatEther(preparation.prepared.maxFee)} ${native}`
          }
        />
      </View>
    </>
  );
}

function SolanaTx({ approval }: { approval: Approval }) {
  const styles = useStyles();
  let summary: ReturnType<typeof solanaSummary> = null;
  try {
    summary = solanaSummary((approval.params as { transaction: string }).transaction);
  } catch {
    summary = null;
  }
  const mine = approval.site?.solana;
  if (!summary) return <Warning text="This transaction can’t be read. Cancel it." />;
  return (
    <>
      {!summary.reviewable ? (
        <Warning text="This transaction contains an instruction Honey cannot safely interpret. Signing is blocked." />
      ) : (
        <Warning
          icon="info"
          text="Review every instruction below. Only simple SOL transfers and compute-budget settings are supported."
        />
      )}
      <View style={styles.card}>
        <StatRow
          label="Fee paid by"
          value={summary.feePayer === mine ? 'You' : shortAddress(summary.feePayer, 4, 4)}
        />
        <StatRow label="Signers" value={String(summary.signers.length)} />
        <StatRow label="Version" value={String(summary.version)} />
        <StatRow label="Instructions" value={String(summary.instructions.length)} />
      </View>
      {summary.instructions.map((instruction, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: duplicate Solana instructions are distinct ordered effects
        <View key={`${index}:${instruction.kind}`} style={styles.card}>
          <StatRow label={`Instruction ${index + 1}`} value={instruction.kind} />
          {instruction.kind === 'solTransfer' ? (
            <>
              <StatRow
                label="From"
                value={
                  <Text style={styles.reviewValue} selectable>
                    {instruction.from}
                  </Text>
                }
              />
              <StatRow
                label="To"
                value={
                  <Text style={styles.reviewValue} selectable>
                    {instruction.to}
                  </Text>
                }
              />
              <StatRow label="Amount" value={`${formatUnits(instruction.lamports, 9)} SOL`} />
              <StatRow label="Lamports" value={instruction.lamports.toString()} />
            </>
          ) : instruction.kind === 'computeUnitLimit' ? (
            <StatRow label="Compute units" value={String(instruction.units)} />
          ) : instruction.kind === 'computeUnitPrice' ? (
            <StatRow label="Micro-lamports per unit" value={instruction.microLamports.toString()} />
          ) : (
            <>
              <StatRow
                label="Program"
                value={
                  <Text style={styles.reviewValue} selectable>
                    {instruction.program ?? 'Unresolved program'}
                  </Text>
                }
              />
              <StatRow label="Opaque data bytes" value={String(instruction.data.length)} />
            </>
          )}
        </View>
      ))}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    backgroundColor: c.canvas,
  },
  loading: {
    marginTop: 80,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  content: {
    paddingBottom: 16,
    gap: 14,
  },
  chip: {
    alignSelf: 'center',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: c.card,
  },
  favicon: {
    width: 18,
    height: 18,
    ...radius(4),
  },
  chipText: {
    flexShrink: 1,
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    color: c.text,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  body: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  list: {
    marginTop: -4,
  },
  connectNote: {
    paddingHorizontal: 16,
  },
  card: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...radius(20),
    backgroundColor: c.card,
  },
  walletValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statValue: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  // No height cap: the page scrolls, so nothing being signed is ever cut off.
  message: {
    padding: 14,
    gap: 6,
    ...radius(16),
    backgroundColor: c.card,
  },
  messageText: {
    color: c.text,
    fontSize: 14,
    lineHeight: 20,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  field: {
    color: c.text,
    fontSize: 13,
    lineHeight: 18,
  },
  fieldKey: {
    color: c.textSecondary,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  noteText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  alert: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    ...radius(14),
    backgroundColor: `${c.error}18`,
  },
  scamAlert: {
    marginBottom: 12,
    padding: 12,
    gap: 12,
    ...radius(14),
    backgroundColor: `${c.error}18`,
  },
  scamLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  // The checkbox label's size, so the two lines read as one block.
  scamText: {
    fontSize: 16,
    lineHeight: 21,
  },
  scamIcon: {
    width: CHECKBOX_SIZE,
    alignItems: 'center',
  },
  alertText: {
    flex: 1,
    color: c.text,
    fontSize: 14,
    lineHeight: 19,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
  },
  reviewValue: {
    color: c.text,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'right',
    flexShrink: 1,
    maxWidth: '72%',
    fontFamily: 'monospace',
  },
}));
