export const CURRENT_MARKET_CONTRACT_VERSION = 4
export const COMMENTS_MIN_CONTRACT_VERSION = 2
export const MIN_VISIBLE_MARKET_CONTRACT_VERSION = CURRENT_MARKET_CONTRACT_VERSION
export const DEFAULT_LP_ENTRY_MAX_PRICE_FP = 800_000
export const RESOLUTION_CLASS_SOURCE_BASED = 0
export const RESOLUTION_CLASS_AGENT_ASSISTED = 1
export const RESOLUTION_CLASS_HUMAN_JUDGED = 2
export const DEFAULT_RESOLUTION_CLASS = RESOLUTION_CLASS_SOURCE_BASED
export const EXECUTION_ASSURANCE_UNAUTHENTICATED = 0
export const EXECUTION_ASSURANCE_SIGNED_RUNNER = 1
export const EXECUTION_ASSURANCE_TEE_ATTESTED = 2
export const EXECUTION_ASSURANCE_THRESHOLD_TEE_ATTESTED = 3
export const DEFAULT_EXECUTION_ASSURANCE_TIER = EXECUTION_ASSURANCE_UNAUTHENTICATED

export const STATUS_CREATED = 0
export const STATUS_ACTIVE = 1
export const STATUS_RESOLUTION_PENDING = 2
export const STATUS_RESOLUTION_PROPOSED = 3
export const STATUS_CANCELLED = 4
export const STATUS_RESOLVED = 5
export const STATUS_DISPUTED = 6

export const MARKET_STATUS_LABELS: Record<number, string> = {
  [STATUS_CREATED]: 'Created',
  [STATUS_ACTIVE]: 'Active',
  [STATUS_RESOLUTION_PENDING]: 'Resolution Pending',
  [STATUS_RESOLUTION_PROPOSED]: 'Resolution Proposed',
  [STATUS_CANCELLED]: 'Cancelled',
  [STATUS_RESOLVED]: 'Resolved',
  [STATUS_DISPUTED]: 'Disputed',
}

export const RESOLUTION_CLASS_LABELS: Record<number, string> = {
  [RESOLUTION_CLASS_SOURCE_BASED]: 'Source-based',
  [RESOLUTION_CLASS_AGENT_ASSISTED]: 'Agent-assisted',
  [RESOLUTION_CLASS_HUMAN_JUDGED]: 'Human-judged',
}

export const EXECUTION_ASSURANCE_TIER_LABELS: Record<number, string> = {
  [EXECUTION_ASSURANCE_UNAUTHENTICATED]: 'Unauthenticated',
  [EXECUTION_ASSURANCE_SIGNED_RUNNER]: 'Signed runner',
  [EXECUTION_ASSURANCE_TEE_ATTESTED]: 'TEE attested',
  [EXECUTION_ASSURANCE_THRESHOLD_TEE_ATTESTED]: 'Threshold TEE attested',
}

export const MARKET_BOX_Q = 'q'
export const MARKET_BOX_USER_SHARES_PREFIX = 'us:'
export const MARKET_BOX_USER_COST_BASIS_PREFIX = 'uc:'
export const MARKET_BOX_USER_FEES_PREFIX = 'uf:'
export const MARKET_BOX_PENDING_PAYOUT_PREFIX = 'pp:'
export const MARKET_BOX_TOTAL_USER_SHARES = 'tus'
export const MARKET_BOX_MAIN_BLUEPRINT = 'mb'
export const MARKET_BOX_DISPUTE_BLUEPRINT = 'db'

export const MARKET_LOCAL_LP_SHARES = 'ls'
export const MARKET_LOCAL_FEE_SNAPSHOT = 'fs'
export const MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS = 'wfs'
export const MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM = 'les'
export const MARKET_LOCAL_RESIDUAL_CLAIMED = 'rc'

export interface NormalizedIndexerMarket {
  appId: number
  contractVersion: number
  question: string
  outcomes: string[]
  status: number
  numOutcomes: number
  b: string
  poolBalance: string
  lpSharesTotal: string
  lpFeeBps: number
  protocolFeeBps: number
  activationTimestamp: number
  deadline: number
  resolutionClass: number
  executionAssuranceTier: number
  lpEntryMaxPriceFp: number
  resolutionPendingSince: number
  quantities: string[]
  prices: number[]
  creator: string
  resolutionAuthority: string
  marketAdmin: string
  cancellable: boolean
  challengeWindowSecs: number
  proposalTimestamp: number
  proposalEvidenceHash: string
  proposer: string
  proposalBond: string
  gracePeriodSecs: number
  proposerBondHeld: string
  challengeBond: string
  challenger: string
  challengeReasonCode: number
  challengeEvidenceHash: string
  challengerBondHeld: string
  disputeRefHash: string
  disputeOpenedAt: number
  disputeDeadline: number
  rulingHash: string
  resolutionPathUsed: number
  disputeBackendKind: number
  pendingResponderRole: number
  disputeSinkBalance: string
  winningOutcome: number
  blueprintSummary: string
  questionHash: string
  volume: string
}

export interface NormalizedIndexerLpStake {
  appId: number
  address: string
  shares: string
  feeSnapshot: string
  claimableFees: string
}

function fallbackOutcomeLabels(length: number): string[] {
  return Array.from({ length: Math.max(length, 0) }, (_, index) => `Outcome ${index + 1}`)
}

export function parseStringArray(raw: unknown, fallbackLength = 0): string[] {
  if (Array.isArray(raw)) return raw.map(String)

  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // Ignore parse errors and fall through to fallback labels.
  }

  return fallbackOutcomeLabels(fallbackLength)
}

export function parseExactStringArray(raw: unknown, fallbackLength = 0): string[] {
  if (Array.isArray(raw)) return raw.map((value) => String(value))

  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    if (Array.isArray(parsed)) return parsed.map((value) => String(value))
  } catch {
    // Ignore parse errors and fall through to zeroed values.
  }

  return Array.from({ length: Math.max(fallbackLength, 0) }, () => '0')
}

export function parseOutcomeLabels(raw: unknown, outcomeCount: number): string[] {
  return parseStringArray(raw, outcomeCount).slice(0, Math.max(outcomeCount, 0))
}

export function parsePrices(raw: unknown, outcomeCount: number): number[] {
  if (Array.isArray(raw)) return raw.map(Number).slice(0, Math.max(outcomeCount, 0))

  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    if (Array.isArray(parsed)) return parsed.map(Number).slice(0, Math.max(outcomeCount, 0))
  } catch {
    // Ignore parse errors and fall through to even odds.
  }

  if (outcomeCount <= 0) return []
  return Array(outcomeCount).fill(Math.floor(1_000_000 / outcomeCount))
}

export function getMarketContractVersion(market: { contractVersion?: number | string | bigint } | null | undefined): number {
  return Number(market?.contractVersion ?? CURRENT_MARKET_CONTRACT_VERSION)
}

export function isVisibleMarketVersion(market: { contractVersion?: number | string | bigint } | null | undefined): boolean {
  return getMarketContractVersion(market) >= MIN_VISIBLE_MARKET_CONTRACT_VERSION
}

export function marketStatusName(status: number): string {
  return MARKET_STATUS_LABELS[status] ?? `Status ${status}`
}

export function resolutionClassName(resolutionClass: number): string {
  return RESOLUTION_CLASS_LABELS[resolutionClass] ?? `Resolution Class ${resolutionClass}`
}

export function executionAssuranceTierName(executionAssuranceTier: number): string {
  return EXECUTION_ASSURANCE_TIER_LABELS[executionAssuranceTier] ?? `Execution Tier ${executionAssuranceTier}`
}

export function deriveResolutionClassFromBlueprint(blueprint: unknown): number {
  const nodes = (blueprint && typeof blueprint === 'object' && 'nodes' in blueprint
    ? (blueprint as { nodes?: Array<{ type?: unknown }> }).nodes
    : undefined) ?? []

  if (!Array.isArray(nodes)) return RESOLUTION_CLASS_SOURCE_BASED
  if (nodes.some((node) => node?.type === 'human_judge')) return RESOLUTION_CLASS_HUMAN_JUDGED
  if (nodes.some((node) => node?.type === 'llm_judge')) return RESOLUTION_CLASS_AGENT_ASSISTED
  return RESOLUTION_CLASS_SOURCE_BASED
}

export function normalizeIndexerLpStake(raw: any): NormalizedIndexerLpStake {
  return {
    appId: Number(raw?.appId ?? 0),
    address: String(raw?.address ?? ''),
    shares: String(raw?.shares ?? '0'),
    feeSnapshot: String(raw?.feeSnapshot ?? '0'),
    claimableFees: String(raw?.claimableFees ?? '0'),
  }
}

export function normalizeIndexerLpStakes(raw: unknown): NormalizedIndexerLpStake[] {
  if (!Array.isArray(raw)) return []

  return raw
    .map((entry) => normalizeIndexerLpStake(entry))
    .filter((entry) => entry.appId > 0 && entry.address.length > 0)
}

function normalizeOutcomeCount(raw: unknown): number {
  const parsed = Number(raw ?? 0)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(16, Math.max(0, Math.trunc(parsed)))
}

export function normalizeIndexerMarket(raw: any): NormalizedIndexerMarket {
  const numOutcomes = normalizeOutcomeCount(raw?.numOutcomes)

  return {
    appId: Number(raw?.appId ?? 0),
    contractVersion: getMarketContractVersion(raw),
    question: String(raw?.question ?? `Market #${raw?.appId ?? 0}`),
    outcomes: parseOutcomeLabels(raw?.outcomes, numOutcomes),
    status: Number(raw?.status ?? 0),
    numOutcomes,
    b: String(raw?.b ?? '0'),
    poolBalance: String(raw?.poolBalance ?? '0'),
    lpSharesTotal: String(raw?.lpSharesTotal ?? '0'),
    lpFeeBps: Number(raw?.lpFeeBps ?? 0),
    protocolFeeBps: Number(raw?.protocolFeeBps ?? 0),
    activationTimestamp: Number(raw?.activationTimestamp ?? 0),
    deadline: Number(raw?.deadline ?? 0),
    resolutionClass: Number(raw?.resolutionClass ?? DEFAULT_RESOLUTION_CLASS),
    executionAssuranceTier: Number(raw?.executionAssuranceTier ?? DEFAULT_EXECUTION_ASSURANCE_TIER),
    lpEntryMaxPriceFp: Number(raw?.lpEntryMaxPriceFp ?? DEFAULT_LP_ENTRY_MAX_PRICE_FP),
    resolutionPendingSince: Number(raw?.resolutionPendingSince ?? 0),
    quantities: parseExactStringArray(raw?.quantities, numOutcomes).slice(0, Math.max(numOutcomes, 0)),
    prices: parsePrices(raw?.prices, numOutcomes),
    creator: String(raw?.creator ?? ''),
    resolutionAuthority: String(raw?.resolutionAuthority ?? ''),
    marketAdmin: String(raw?.marketAdmin ?? ''),
    cancellable: Boolean(raw?.cancellable ?? 0),
    challengeWindowSecs: Number(raw?.challengeWindowSecs ?? 0),
    proposalTimestamp: Number(raw?.proposalTimestamp ?? 0),
    proposalEvidenceHash: String(raw?.proposalEvidenceHash ?? ''),
    proposer: String(raw?.proposer ?? ''),
    proposalBond: String(raw?.proposalBond ?? '0'),
    gracePeriodSecs: Number(raw?.gracePeriodSecs ?? 0),
    proposerBondHeld: String(raw?.proposerBondHeld ?? '0'),
    challengeBond: String(raw?.challengeBond ?? '0'),
    challenger: String(raw?.challenger ?? ''),
    challengeReasonCode: Number(raw?.challengeReasonCode ?? 0),
    challengeEvidenceHash: String(raw?.challengeEvidenceHash ?? ''),
    challengerBondHeld: String(raw?.challengerBondHeld ?? '0'),
    disputeRefHash: String(raw?.disputeRefHash ?? ''),
    disputeOpenedAt: Number(raw?.disputeOpenedAt ?? 0),
    disputeDeadline: Number(raw?.disputeDeadline ?? 0),
    rulingHash: String(raw?.rulingHash ?? ''),
    resolutionPathUsed: Number(raw?.resolutionPathUsed ?? 0),
    disputeBackendKind: Number(raw?.disputeBackendKind ?? 0),
    pendingResponderRole: Number(raw?.pendingResponderRole ?? 0),
    disputeSinkBalance: String(raw?.disputeSinkBalance ?? '0'),
    winningOutcome: Number(raw?.winningOutcome ?? 0),
    blueprintSummary: String(raw?.blueprintSummary ?? ''),
    questionHash: String(raw?.questionHash ?? ''),
    volume: String(raw?.volume ?? '0'),
  }
}
