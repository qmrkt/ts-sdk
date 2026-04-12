import algosdk from 'algosdk'
import { type ClientConfig, type MethodCallOptions, loadMethods, callMethod, readGlobalState, readBox, boxName, boxNameAddr, boxNameAddrIdx, marketBoxRefs, bootstrapBoxRefs, pricingBoxRefs } from './base'
import { SCALE, calculatePrices, lnFp } from '../index'
import {
  COMMENTS_MIN_CONTRACT_VERSION,
  CURRENT_MARKET_CONTRACT_VERSION,
  DEFAULT_LP_ENTRY_MAX_PRICE_FP,
  MARKET_BOX_PENDING_PAYOUT_PREFIX,
  MARKET_BOX_USER_FEES_PREFIX,
  MARKET_BOX_USER_SHARES_PREFIX,
  MARKET_LOCAL_FEE_SNAPSHOT,
  MARKET_LOCAL_LP_SHARES,
  MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM,
  MARKET_LOCAL_RESIDUAL_CLAIMED,
  MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS,
} from './market-schema'
import spec from './specs/QuestionMarket.arc56.json'
import protocolConfigSpec from './specs/ProtocolConfig.arc56.json'

const methods = loadMethods(spec)
const protocolConfigMethods = loadMethods(protocolConfigSpec)
const GROUP_LIMIT = 16
const MAX_REFS_PER_TXN = 8
const SHARE_UNIT = 1_000_000n
const HIGH_OUTCOME_BUDGET_MIN_OUTCOMES = 2
const MAX_PROTOCOL_OP_UP_CALLS = 192
const MIN_TXN_FEE = 1_000n
const SECONDS_PER_DAY = 86_400n
const STATUS_ACTIVE = 1
export const COMMENTS_MIN_VERSION = COMMENTS_MIN_CONTRACT_VERSION
export const MAX_COMMENT_BYTES = 512

export class AtomicGroupUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AtomicGroupUnsupportedError'
  }
}

export interface MarketState {
  appId: number
  contractVersion: number
  creator: string
  resolutionAuthority: string
  marketAdmin: string
  status: number
  numOutcomes: number
  b: bigint
  poolBalance: bigint
  lpSharesTotal: bigint
  lpFeeBps: number
  protocolFeeBps: number
  residualLinearLambdaFp: bigint
  lpEntryMaxPriceFp: bigint
  activationTimestamp: number
  settlementTimestamp: number
  withdrawableFeeSurplus: bigint
  totalResidualClaimed: bigint
  deadline: number
  questionHash: Uint8Array
  mainBlueprintHash: Uint8Array
  disputeBlueprintHash: Uint8Array
  proposedOutcome: number
  proposalTimestamp: number
  winningOutcome: number
  challengeWindowSecs: number
  challengeBond: bigint
  proposalBond: bigint
  minChallengeBond: bigint
  minProposalBond: bigint
  challengeBondBps: number
  proposalBondBps: number
  challengeBondCap: bigint
  proposalBondCap: bigint
  proposerFeeBps: number
  proposerFeeFloorBps: number
  bootstrapDeposit: bigint
  resolutionBudgetBalance: bigint
  gracePeriodSecs: number
  proposerBondHeld: bigint
  challengerBondHeld: bigint
  disputeSinkBalance: bigint
  cancellable: boolean
  quantities: bigint[]
  prices: bigint[]
}

export interface CommentGroupPlan {
  methodBoxCount: number
  noopBoxCounts: number[]
  totalTxnCount: number
}

export interface BuySharesResult {
  txId: string
  shares: bigint
  totalCost: bigint
  refundAmount: bigint
}

export interface SellSharesResult {
  txId: string
  shares: bigint
  netReturn: bigint
}

export interface ClaimSharesResult {
  txId: string
  shares: bigint
  payout: bigint
}

export interface RefundSharesResult {
  txId: string
  shares: bigint
  refundAmount: bigint
}

export interface EnterActiveLpResult {
  txId: string
  targetDeltaB: bigint
  maxDeposit: bigint
}

function formatPricePct(priceFp: bigint): string {
  return `${(Number(priceFp) / 10_000).toFixed(2)}%`
}

function assertWholeShareMultiple(shares: bigint, action: 'buy' | 'sell' | 'claim' | 'refund'): void {
  if (shares < SHARE_UNIT || shares % SHARE_UNIT !== 0n) {
    throw new Error(
      `${action[0].toUpperCase()}${action.slice(1)} requires whole-share multiples of 1.000000 shares. Refresh and try again.`,
    )
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

function requiredBondFromState(
  minimum: bigint,
  bps: bigint,
  cap: bigint,
  poolBalance: bigint,
  bootstrapDeposit: bigint,
): bigint {
  const effectiveCap = cap > 0n ? cap : minimum
  const scaleBase = poolBalance > bootstrapDeposit ? poolBalance : bootstrapDeposit
  const proportional = ceilDiv(scaleBase * bps, 10_000n)
  const floored = proportional > minimum ? proportional : minimum
  return floored < effectiveCap ? floored : effectiveCap
}

function requiredProposerFeeFromState(
  minimumBond: bigint,
  currentBond: bigint,
  proposalBondCap: bigint,
  proposerFeeBps: number,
  proposerFeeFloorBps: number,
  challengeWindowSecs: number,
  maxBudget = false,
): bigint {
  const feeBond = maxBudget ? proposalBondCap : currentBond
  const floorFee = ceilDiv(minimumBond * BigInt(proposerFeeFloorBps), 10_000n)
  const dailyFee = ceilDiv(feeBond * BigInt(proposerFeeBps), 10_000n)
  const windowFee = ceilDiv(dailyFee * BigInt(challengeWindowSecs), SECONDS_PER_DAY)
  return windowFee > floorFee ? windowFee : floorFee
}

function assertActiveLpSkewWithinCap(state: Pick<MarketState, 'prices' | 'lpEntryMaxPriceFp'>): void {
  const maxPrice = state.prices.reduce((currentMax, price) => (price > currentMax ? price : currentMax), 0n)
  if (maxPrice > state.lpEntryMaxPriceFp) {
    throw new Error(
      `Active LP entry is disabled once any outcome exceeds ${formatPricePct(state.lpEntryMaxPriceFp)}. ` +
      `The current max outcome price is ${formatPricePct(maxPrice)}.`,
    )
  }
}

export interface LpAccountState {
  lpShares: bigint
  feeSnapshot: bigint
  withdrawableFeeSurplus: bigint
  lpWeightedEntrySum: bigint
  residualClaimed: bigint
  claimableFees: bigint
}

export interface CollectLpFeesResult {
  claimTxId?: string
  withdrawTxId?: string
  withdrawnAmount: bigint
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an ASA transfer transaction (USDC payment to app, or outcome ASA).
 */
function makeAssetTransfer(
  sender: string,
  receiver: string,
  assetId: number,
  amount: bigint,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    assetIndex: assetId,
    amount,
    suggestedParams: withMinFlatFee(suggestedParams),
  })
}

function withMinFlatFee(
  suggestedParams: algosdk.SuggestedParams,
  multiplier: bigint = 1n,
): algosdk.SuggestedParams {
  const normalizedFee = MIN_TXN_FEE * (multiplier > 0n ? multiplier : 1n)
  return {
    ...suggestedParams,
    flatFee: true,
    fee: normalizedFee,
  }
}

function makeBareAppNoOp(
  sender: string,
  appId: number,
  suggestedParams: algosdk.SuggestedParams,
  options?: {
    boxes?: algosdk.BoxReference[]
    note?: Uint8Array
  },
): algosdk.Transaction {
  return algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: appId,
    suggestedParams: withMinFlatFee(suggestedParams),
    boxes: options?.boxes,
    note: options?.note,
  })
}

/**
 * Deduplicate box references by serializing to string keys.
 */
function deduplicateBoxes(refs: algosdk.BoxReference[]): algosdk.BoxReference[] {
  const seen = new Set<string>()
  const result: algosdk.BoxReference[] = []
  for (const ref of refs) {
    const key = `${ref.appIndex}:${Array.from(ref.name, (b) => b.toString(16).padStart(2, '0')).join('')}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(ref)
    }
  }
  return result
}

function decodeAddressStateValue(value: bigint | Uint8Array | undefined): string | undefined {
  if (!(value instanceof Uint8Array) || value.length !== 32) return undefined
  if (value.every((byte) => byte === 0)) return undefined
  return algosdk.encodeAddress(value)
}

function stateValue<T>(state: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in state) return state[key] as T
  }
  return undefined
}

function methodAccounts(sender: string, ...accounts: Array<string | undefined>): string[] | undefined {
  const filtered = accounts.filter((account): account is string => Boolean(account) && account !== sender)
  if (filtered.length === 0) return undefined
  return [...new Set(filtered)]
}

async function getLatestBlockTimestamp(algod: algosdk.Algodv2): Promise<number> {
  const status = await algod.status().do()
  const latestRound = Number(status.lastRound ?? 0)
  if (latestRound <= 0) return 0

  const block = await algod.block(latestRound).do()
  return Number((block as { block?: { ts?: number } }).block?.ts ?? 0)
}

function payoutBoxRefs(appId: number, ...accounts: Array<string | undefined>): algosdk.BoxReference[] {
  return accounts
    .filter((account): account is string => Boolean(account))
    .map((account) => ({ appIndex: appId, name: boxNameAddr(MARKET_BOX_PENDING_PAYOUT_PREFIX, account) }))
}

export function commentBoxRefs(appId: number, numOutcomes: number, sender: string): algosdk.BoxReference[] {
  return Array.from({ length: numOutcomes }, (_, outcomeIndex) => ({
    appIndex: appId,
    name: boxNameAddrIdx(MARKET_BOX_USER_SHARES_PREFIX, sender, outcomeIndex),
  }))
}

export function planCommentGroup(totalBoxCount: number, maxRefsPerTxn: number = MAX_REFS_PER_TXN): CommentGroupPlan {
  const methodBoxCount = Math.min(totalBoxCount, maxRefsPerTxn)
  const noopBoxCounts: number[] = []

  for (let remaining = Math.max(0, totalBoxCount - methodBoxCount); remaining > 0; remaining -= maxRefsPerTxn) {
    noopBoxCounts.push(Math.min(remaining, maxRefsPerTxn))
  }

  return {
    methodBoxCount,
    noopBoxCounts,
    totalTxnCount: 1 + noopBoxCounts.length,
  }
}

function splitCommentBoxRefs(boxes: algosdk.BoxReference[]): {
  methodBoxes: algosdk.BoxReference[]
  noopBoxChunks: algosdk.BoxReference[][]
} {
  const plan = planCommentGroup(boxes.length)
  let offset = 0

  const methodBoxes = boxes.slice(offset, offset + plan.methodBoxCount)
  offset += plan.methodBoxCount

  const noopBoxChunks = plan.noopBoxCounts.map((count) => {
    const chunk = boxes.slice(offset, offset + count)
    offset += count
    return chunk
  })

  return { methodBoxes, noopBoxChunks }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function isTransactionWithSigner(
  value: algosdk.ABIValue | algosdk.TransactionWithSigner,
): value is algosdk.TransactionWithSigner {
  return typeof value === 'object' && value !== null && 'txn' in value && 'signer' in value
}

function transactionArgCount(args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[]): number {
  return args.filter(isTransactionWithSigner).length
}

function cloneTxnWithSigner(txnWithSigner: algosdk.TransactionWithSigner, signerOverride?: algosdk.TransactionSigner): algosdk.TransactionWithSigner {
  return {
    txn: algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txnWithSigner.txn)),
    signer: signerOverride ?? txnWithSigner.signer,
  }
}

function cloneMethodArgs(
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  signerOverride?: algosdk.TransactionSigner,
): (algosdk.ABIValue | algosdk.TransactionWithSigner)[] {
  return args.map((arg) => (isTransactionWithSigner(arg) ? cloneTxnWithSigner(arg, signerOverride) : arg))
}

const EMPTY_SIGNER: algosdk.TransactionSigner = async (txnGroup: algosdk.Transaction[], indexesToSign: number[]) => {
  // Return properly encoded but unsigned transactions for simulation
  return indexesToSign.map((i) => algosdk.encodeUnsignedSimulateTransaction(txnGroup[i]))
}

async function buildAsaOptInIfNeeded(
  algod: algosdk.Algodv2,
  sender: string,
  signer: algosdk.TransactionSigner,
  asaId: number,
) : Promise<algosdk.TransactionWithSigner | undefined> {
  try {
    await algod.accountAssetInformation(sender, asaId).do()
    return undefined
  } catch {
    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender,
      receiver: sender,
      assetIndex: asaId,
      amount: BigInt(0),
      suggestedParams: withMinFlatFee(sp),
    })
    return { txn, signer }
  }
}

function decodeBase64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  if (typeof atob === 'function') {
    try {
      const binary = atob(normalized)
      return Uint8Array.from(binary, (char) => char.charCodeAt(0))
    } catch {
      // Fall through to raw-byte fallback below. Some localnet/account-info
      // surfaces already hand back plain UTF-8 strings instead of base64.
    }
  }
  return new TextEncoder().encode(value)
}

async function readAccountLocalState(
  algod: algosdk.Algodv2,
  appId: number,
  address: string,
): Promise<Record<string, bigint | Uint8Array>> {
  const accountInfo = await algod.accountInformation(address).do() as Record<string, any>
  const appStates = accountInfo['apps-local-state'] ?? accountInfo.appsLocalState ?? []
  const appState = appStates.find((entry: any) => Number(entry.id ?? entry.appId) === appId)
  if (!appState) return {}

  const keyValue = appState['key-value'] ?? appState.keyValue ?? []
  const localState: Record<string, bigint | Uint8Array> = {}
  for (const entry of keyValue) {
    const key = new TextDecoder().decode(decodeBase64Bytes(String(entry.key ?? '')))
    const value = entry.value ?? {}
    if (Number(value.type ?? 0) === 2) {
      localState[key] = BigInt(value.uint ?? 0)
    } else if (typeof value.bytes === 'string') {
      localState[key] = decodeBase64Bytes(value.bytes)
    }
  }
  return localState
}

function maxActiveLpAlphaFromPrices(prices: readonly bigint[]): bigint {
  if (prices.length === 0) {
    throw new Error('prices must not be empty')
  }

  let alphaFp = 0n
  for (const price of prices) {
    if (price <= 0n) {
      throw new Error('prices must be positive')
    }
    const invPriceFp = ceilDiv(SCALE * SCALE, price)
    const candidate = lnFp(invPriceFp)
    if (candidate > alphaFp) alphaFp = candidate
  }
  return alphaFp
}

export function collateralRequiredForActiveLpFromPrices(
  targetDeltaB: bigint,
  prices: readonly bigint[],
): bigint {
  if (targetDeltaB <= 0n) {
    throw new Error('targetDeltaB must be positive')
  }
  const alphaFp = maxActiveLpAlphaFromPrices(prices)
  return ceilDiv(targetDeltaB * alphaFp, SCALE)
}

export function targetDeltaBForActiveLpDepositFromPrices(
  maxDeposit: bigint,
  prices: readonly bigint[],
): bigint {
  if (maxDeposit <= 0n) return 0n
  const alphaFp = maxActiveLpAlphaFromPrices(prices)
  if (alphaFp <= 0n) {
    throw new Error('active LP alpha must be positive')
  }
  return (maxDeposit * SCALE) / alphaFp
}

async function getAssetBalance(
  algod: algosdk.Algodv2,
  address: string,
  assetId: number,
): Promise<bigint> {
  try {
    const info = await algod.accountAssetInformation(address, assetId).do()
    return BigInt(info.assetHolding?.amount ?? 0)
  } catch {
    return 0n
  }
}

async function buildAppOptInIfNeeded(
  algod: algosdk.Algodv2,
  sender: string,
  signer: algosdk.TransactionSigner,
  appId: number | bigint,
): Promise<algosdk.TransactionWithSigner | undefined> {
  try {
    await algod.accountApplicationInformation(sender, Number(appId)).do()
    return undefined
  } catch {
    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeApplicationOptInTxnFromObject({
      sender,
      appIndex: Number(appId),
      suggestedParams: withMinFlatFee(sp),
    })
    return { txn, signer }
  }
}

/**
 * Market bare no-ops still distribute box refs. For higher-outcome markets the
 * planner can add more pooled opcode budget via ProtocolConfig.op_up().
 */
function noopsFor(numOutcomes: number): number {
  if (numOutcomes <= 2) return 10  // budget 7700, cost ~5600
  if (numOutcomes <= 3) return 14  // budget 10500, cost ~7700
  return 14                        // planner will cap this against group limits
}

export function recommendedNoopsFor(numOutcomes: number): number {
  return noopsFor(numOutcomes)
}

type BudgetedCallOptions = {
  prependTxns?: algosdk.TransactionWithSigner[]
  extraBoxes?: algosdk.BoxReference[]
  boxOverride?: algosdk.BoxReference[]
  foreignAssets?: number[]
  appAccounts?: string[]
  innerTxnCount?: number
  budgetAppId?: number
  budgetForeignApps?: number[]
}

type BuiltBudgetedCall = {
  atc: algosdk.AtomicTransactionComposer
  allBoxes: algosdk.BoxReference[]
  methodBoxes: algosdk.BoxReference[]
  effectiveNoopCount: number
  totalTxnCount: number
  foreignAssetCount: number
  appAccountCount: number
}

export interface BudgetSimulationResult {
  methodName: string
  effectiveNoopCount: number
  totalTxnCount: number
  totalBoxCount: number
  methodBoxCount: number
  foreignAssetCount: number
  appAccountCount: number
  methodReferenceCount: number
  groupAppBudgetAdded: number
  groupAppBudgetConsumed: number
  groupAppBudgetHeadroom: number
  methodAppBudgetConsumed: number
  usedUnnamedResources: boolean
  failureMessage?: string
  failedAt?: number[]
}

export type BudgetedMethodResult = algosdk.ABIResult & { txId: string }

async function buildBudgetedCall(
  config: ClientConfig,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  numOutcomes: number,
  outcomeIndex: number = 0,
  noopCount: number = 10,
  opts?: BudgetedCallOptions,
  signerOverride?: algosdk.TransactionSigner,
): Promise<BuiltBudgetedCall> {
  const effectiveSigner = signerOverride ?? config.signer
  const atc = new algosdk.AtomicTransactionComposer()
  const sp = await config.algodClient.getTransactionParams().do()
  const allBoxes = deduplicateBoxes(opts?.boxOverride ?? [
    ...marketBoxRefs(Number(config.appId), numOutcomes, config.sender, outcomeIndex),
    ...(opts?.extraBoxes ?? []),
  ])

  if (opts?.prependTxns) {
    for (const txnWithSigner of opts.prependTxns) {
      atc.addTransaction(cloneTxnWithSigner(txnWithSigner, signerOverride))
    }
  }

  const marketNoopCount = Math.ceil(allBoxes.length / MAX_REFS_PER_TXN)
  const effectiveNoopCount = Math.max(noopCount, marketNoopCount)
  const extraMarketNoopCount = opts?.budgetAppId ? 0 : Math.max(0, effectiveNoopCount - marketNoopCount)
  const budgetOpUpCount = opts?.budgetAppId ? Math.max(0, effectiveNoopCount - marketNoopCount) : 0

  for (let i = 0; i < marketNoopCount; i++) {
    const start = i * MAX_REFS_PER_TXN
    const chunk = allBoxes.slice(start, start + MAX_REFS_PER_TXN)
    atc.addTransaction({
      txn: makeBareAppNoOp(config.sender, Number(config.appId), sp, {
        boxes: chunk.length > 0 ? chunk : undefined,
        note: new TextEncoder().encode(`n${methodName}${i}`),
      }),
      signer: effectiveSigner,
    })
  }

  for (let i = 0; i < extraMarketNoopCount; i++) {
    atc.addTransaction({
      txn: makeBareAppNoOp(config.sender, Number(config.appId), sp, {
        note: new TextEncoder().encode(`p${methodName}${i}`),
      }),
      signer: effectiveSigner,
    })
  }

  if (opts?.budgetAppId && budgetOpUpCount > 0) {
    const opUpMethod = protocolConfigMethods.get('op_up')
    if (!opUpMethod) throw new Error("Method 'op_up' not found in ProtocolConfig ABI spec")
    const opUpSp = { ...sp }
    opUpSp.flatFee = true
    opUpSp.fee = BigInt((1 + budgetOpUpCount) * 1000)
    atc.addMethodCall({
      appID: opts.budgetAppId,
      method: opUpMethod,
      methodArgs: [BigInt(budgetOpUpCount)],
      sender: config.sender,
      suggestedParams: opUpSp,
      signer: effectiveSigner,
      appForeignApps: opts.budgetForeignApps,
      note: new TextEncoder().encode(`opup:${methodName}:${budgetOpUpCount}`),
    })
  }

  const callSp = { ...sp }
  if (opts?.innerTxnCount) {
    callSp.flatFee = true
    callSp.fee = BigInt((1 + opts.innerTxnCount) * 1000)
  }

  const foreignAssetCount = opts?.foreignAssets?.length ?? 0
  const appAccountCount = opts?.appAccounts?.length ?? 0
  const methodBoxLimit = Math.max(0, MAX_REFS_PER_TXN - foreignAssetCount - appAccountCount)
  const methodBoxes = allBoxes.slice(0, Math.min(methodBoxLimit, allBoxes.length))
  const method = methods.get(methodName)
  if (!method) throw new Error(`Method '${methodName}' not found in ABI spec`)
  const methodArgs = cloneMethodArgs(args, signerOverride)
  atc.addMethodCall({
    appID: Number(config.appId),
    method,
    methodArgs,
    sender: config.sender,
    suggestedParams: callSp,
    signer: effectiveSigner,
    boxes: methodBoxes.length > 0 ? methodBoxes : undefined,
    appForeignAssets: opts?.foreignAssets,
    appAccounts: opts?.appAccounts,
  })

  return {
    atc,
    allBoxes,
    methodBoxes,
    effectiveNoopCount,
    totalTxnCount:
      (opts?.prependTxns?.length ?? 0) +
      transactionArgCount(args) +
      marketNoopCount +
      extraMarketNoopCount +
      (budgetOpUpCount > 0 ? 1 : 0) +
      1,
    foreignAssetCount,
    appAccountCount,
  }
}

async function simulateBuiltCall(
  config: ClientConfig,
  methodName: string,
  built: BuiltBudgetedCall,
): Promise<BudgetSimulationResult> {
  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowUnnamedResources: false,
    allowEmptySignatures: true,
  })
  const { simulateResponse } = await built.atc.simulate(config.algodClient, request)
  const txnGroup = simulateResponse.txnGroups[0]
  if (!txnGroup) {
    throw new Error(`No simulate transaction group returned for ${methodName}`)
  }

  const methodTxnResult = txnGroup.txnResults[txnGroup.txnResults.length - 1]
  const groupAppBudgetAdded = txnGroup.appBudgetAdded ?? 0
  const groupAppBudgetConsumed = txnGroup.appBudgetConsumed ?? 0
  const groupAppBudgetHeadroom = groupAppBudgetAdded - groupAppBudgetConsumed
  const usedUnnamedResources =
    Boolean(txnGroup.unnamedResourcesAccessed) ||
    txnGroup.txnResults.some((result) => Boolean(result.unnamedResourcesAccessed))

  return {
    methodName,
    effectiveNoopCount: built.effectiveNoopCount,
    totalTxnCount: built.totalTxnCount,
    totalBoxCount: built.allBoxes.length,
    methodBoxCount: built.methodBoxes.length,
    foreignAssetCount: built.foreignAssetCount,
    appAccountCount: built.appAccountCount,
    methodReferenceCount: built.methodBoxes.length + built.foreignAssetCount + built.appAccountCount,
    groupAppBudgetAdded,
    groupAppBudgetConsumed,
    groupAppBudgetHeadroom,
    methodAppBudgetConsumed: methodTxnResult?.appBudgetConsumed ?? 0,
    usedUnnamedResources,
    failureMessage: txnGroup.failureMessage,
    failedAt: txnGroup.failedAt,
  }
}

async function planBudgetedCall(
  config: ClientConfig,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  numOutcomes: number,
  outcomeIndex: number,
  noopCount: number,
  opts?: BudgetedCallOptions,
): Promise<BuiltBudgetedCall> {
  const prependCount = opts?.prependTxns?.length ?? 0
  const txnArgs = transactionArgCount(args)
  const allBoxes = deduplicateBoxes(opts?.boxOverride ?? [
    ...marketBoxRefs(Number(config.appId), numOutcomes, config.sender, outcomeIndex),
    ...(opts?.extraBoxes ?? []),
  ])
  const minimumNoops = Math.ceil(allBoxes.length / MAX_REFS_PER_TXN)
  const marketOnlyOuterTxCount = prependCount + txnArgs + minimumNoops + 1
  const maxNoops = opts?.budgetAppId
    ? minimumNoops + MAX_PROTOCOL_OP_UP_CALLS
    : GROUP_LIMIT - prependCount - txnArgs - 1

  if (marketOnlyOuterTxCount > GROUP_LIMIT) {
    throw new AtomicGroupUnsupportedError(
      `${methodName} needs at least ${marketOnlyOuterTxCount} transactions, exceeding the ${GROUP_LIMIT}-transaction limit`,
    )
  }

  const initialNoops = Math.max(minimumNoops, Math.min(noopCount, maxNoops))
  let lastFailure: BudgetSimulationResult | undefined
  let winningNoops: number | undefined

  const nextCandidateNoops = (candidateNoops: number, extraBudgetStep: number): number => {
    if (!opts?.budgetAppId) return candidateNoops + 1
    return Math.min(maxNoops, candidateNoops + extraBudgetStep)
  }

  let candidateNoops = initialNoops
  let extraBudgetStep = 1
  while (candidateNoops <= maxNoops) {
    const simBuild = await buildBudgetedCall(config, methodName, args, numOutcomes, outcomeIndex, candidateNoops, opts, EMPTY_SIGNER)
    if (simBuild.totalTxnCount > GROUP_LIMIT) {
      if (candidateNoops === maxNoops) break
      candidateNoops = nextCandidateNoops(candidateNoops, extraBudgetStep)
      if (opts?.budgetAppId) extraBudgetStep *= 2
      continue
    }
    const simulation = await simulateBuiltCall(config, methodName, simBuild)
    if (!simulation.failureMessage && !simulation.usedUnnamedResources) {
      winningNoops = candidateNoops
      break
    }
    lastFailure = simulation
    if (candidateNoops === maxNoops) break
    candidateNoops = nextCandidateNoops(candidateNoops, extraBudgetStep)
    if (opts?.budgetAppId) extraBudgetStep *= 2
  }

  if (winningNoops === undefined) {
    const detail = lastFailure?.failureMessage ? `: ${lastFailure.failureMessage}` : ''
    throw new AtomicGroupUnsupportedError(
      `${methodName} could not fit into a single ${GROUP_LIMIT}-transaction group${detail}`,
    )
  }

  // Rebuild with the real signer for execution
  return buildBudgetedCall(config, methodName, args, numOutcomes, outcomeIndex, winningNoops, opts)
}

/**
 * Build an ATC with budget-pooling noop calls + the actual method call,
 * with optional prepended transactions (payments).
 */
async function callWithBudget(
  config: ClientConfig,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  numOutcomes: number,
  outcomeIndex: number = 0,
  noopCount: number = 10,
  opts?: BudgetedCallOptions,
): Promise<BudgetedMethodResult> {
  const built = await planBudgetedCall(config, methodName, args, numOutcomes, outcomeIndex, noopCount, opts)
  const result = await built.atc.execute(config.algodClient, 4)
  return Object.assign(result.methodResults[result.methodResults.length - 1], {
    txId: result.txIDs[result.txIDs.length - 1],
  })
}

export async function simulateBudgetedCall(
  config: ClientConfig,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  numOutcomes: number,
  outcomeIndex: number = 0,
  noopCount: number = 10,
  opts?: BudgetedCallOptions,
): Promise<BudgetSimulationResult> {
  const built = await planBudgetedCall(config, methodName, args, numOutcomes, outcomeIndex, noopCount, opts)
  return simulateBuiltCall(config, methodName, built)
}

async function getProtocolConfigAppId(
  algod: algosdk.Algodv2,
  appId: number | bigint,
): Promise<number | undefined> {
  const gs = await readGlobalState(algod, appId)
  const protocolConfigId = Number(stateValue<bigint>(gs, 'pc', 'protocol_config_id') ?? 0n)
  return protocolConfigId > 0 ? protocolConfigId : undefined
}

function getProtocolBudgetForeignApps(
  marketAppId: number | bigint,
): number[] {
  return [Number(marketAppId)]
}

// ---------------------------------------------------------------------------
// Wallet asset helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the caller wallet is opted into an ASA such as USDC.
 */
export async function optInToAsa(config: ClientConfig, assetId: number) {
  const txn = await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, assetId)
  if (!txn) return undefined

  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction(txn)
  const result = await atc.execute(config.algodClient, 4)
  return { txId: result.txIDs[result.txIDs.length - 1] }
}

/**
 * Deprecated no-op retained only to keep test helpers and low-level scripts
 * compiling during the ledger-only migration. Outcome ASAs are gone.
 */
export async function registerOutcomeAsa(
  config: ClientConfig,
  outcomeIndex: number,
  assetId: number,
  numOutcomes: number,
) {
  void config
  void outcomeIndex
  void assetId
  void numOutcomes
  return undefined
}

/**
 * Store resolution logic DAG on-chain. Must be called before bootstrap.
 * Creator-only, CREATED status only.
 */
export async function storeMainBlueprint(config: ClientConfig, data: Uint8Array) {
  return callWithBudget(config, 'store_main_blueprint', [data], 2, 0, 10, {
    extraBoxes: [{ appIndex: Number(config.appId), name: new TextEncoder().encode('mb') }],
  })
}

export async function storeDisputeBlueprint(config: ClientConfig, data: Uint8Array) {
  return callWithBudget(config, 'store_dispute_blueprint', [data], 2, 0, 10, {
    extraBoxes: [{ appIndex: Number(config.appId), name: new TextEncoder().encode('db') }],
  })
}

export async function storeResolutionLogic(config: ClientConfig, data: Uint8Array) {
  await storeMainBlueprint(config, data)
  return storeDisputeBlueprint(config, data)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Sequential bootstrap helper for ledger-only markets.
 *
 * This is mainly useful in low-level tests. Production UX should use the atomic
 * factory create path instead.
 */
export async function bootstrap(
  config: ClientConfig,
  depositAmount: bigint,
  currencyAsaId: number,
  _legacyOutcomeAsaIds: number[] = [],
) {
  const state = await getMarketState(config.algodClient, Number(config.appId))
  const numOutcomes = Number(state.numOutcomes)
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()

  // Step 1: Opt-in to app for local state
  const optInParams = await config.algodClient.getTransactionParams().do()
  const optInTxn = algosdk.makeApplicationOptInTxnFromObject({
    sender: config.sender,
    appIndex: Number(config.appId),
    suggestedParams: optInParams,
  })
  const optInAtc = new algosdk.AtomicTransactionComposer()
  optInAtc.addTransaction({ txn: optInTxn, signer: config.signer })
  await optInAtc.execute(config.algodClient, 4)

  // Step 2: Fund app MBR
  const suggestedParams = await config.algodClient.getTransactionParams().do()
  const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: appAddr,
    amount: 1_000_000n + BigInt(numOutcomes) * 100_000n,
    suggestedParams,
  })
  const mbrAtc = new algosdk.AtomicTransactionComposer()
  mbrAtc.addTransaction({ txn: mbrPayment, signer: config.signer })
  await mbrAtc.execute(config.algodClient, 4)

  // Step 3: Initialize the market so the app opts into the currency ASA.
  await callMethod(config, methods, 'initialize', [], {
    appForeignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })

  // Step 4: Ensure the caller can receive USDC refunds / payouts.
  await optInToAsa(config, currencyAsaId)

  // Step 5: Store both blueprints (contract requires both boxes before bootstrap)
  await storeResolutionLogic(config, new TextEncoder().encode('default'))

  // Step 6: Bootstrap with grouped USDC deposit
  const sp = await config.algodClient.getTransactionParams().do()
  const bootstrapFundingAmount =
    depositAmount +
    requiredProposerFeeFromState(
      state.minProposalBond,
      state.proposalBond,
      state.proposalBondCap,
      state.proposerFeeBps,
      state.proposerFeeFloorBps,
      state.challengeWindowSecs,
      true,
    )
  const depositTxn = makeAssetTransfer(config.sender, appAddr, currencyAsaId, bootstrapFundingAmount, sp)
  // Bootstrap needs: q boxes + user_fees + total shares + both blueprint boxes
  const bootstrapBoxes = [
    ...bootstrapBoxRefs(Number(config.appId), numOutcomes),
    { appIndex: Number(config.appId), name: boxNameAddr('uf:', config.sender) },
  ]

  return callWithBudget(config, 'bootstrap', [depositAmount, { txn: depositTxn, signer: config.signer }], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: bootstrapBoxes,
  })
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export async function buy(
  config: ClientConfig,
  outcomeIndex: number,
  maxCost: bigint,
  numOutcomes: number,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<BuySharesResult> {
  assertWholeShareMultiple(shares, 'buy')
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, currencyAsaId, maxCost, sp)

  const prependTxns = (await Promise.all([
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ])).filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const budgetAppId = numOutcomes >= HIGH_OUTCOME_BUDGET_MIN_OUTCOMES
    ? await getProtocolConfigAppId(config.algodClient, config.appId)
    : undefined
  const budgetForeignApps = budgetAppId
    ? getProtocolBudgetForeignApps(config.appId)
    : undefined

  const usdcBefore = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  const result = await callWithBudget(config, 'buy', [outcomeIndex, shares, maxCost, { txn: paymentTxn, signer: config.signer }], numOutcomes, outcomeIndex, noopsFor(numOutcomes), {
    prependTxns,
    foreignAssets: [currencyAsaId],
    innerTxnCount: 1,
    budgetAppId,
    budgetForeignApps,
  })
  const usdcAfter = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  const totalCost = usdcBefore - usdcAfter
  return {
    txId: result.txId,
    shares,
    totalCost,
    refundAmount: maxCost - totalCost,
  }
}

export async function sell(
  config: ClientConfig,
  outcomeIndex: number,
  minReturn: bigint,
  numOutcomes: number,
  _outcomeAsaIdOrNull: number | null,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<SellSharesResult> {
  assertWholeShareMultiple(shares, 'sell')
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const budgetAppId = numOutcomes >= HIGH_OUTCOME_BUDGET_MIN_OUTCOMES
    ? await getProtocolConfigAppId(config.algodClient, config.appId)
    : undefined
  const budgetForeignApps = budgetAppId
    ? getProtocolBudgetForeignApps(config.appId)
    : undefined

  const usdcBefore = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  const result = await callWithBudget(config, 'sell', [outcomeIndex, shares, minReturn], numOutcomes, outcomeIndex, noopsFor(numOutcomes), {
    prependTxns,
    foreignAssets: [currencyAsaId],
    innerTxnCount: 1,
    budgetAppId,
    budgetForeignApps,
  })
  const usdcAfter = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  return {
    txId: result.txId,
    shares,
    netReturn: usdcAfter - usdcBefore,
  }
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

export async function provideLiquidity(
  config: ClientConfig,
  depositAmount: bigint,
  numOutcomes: number,
  currencyAsaId: number,
) {
  return enterActiveLpForDeposit(config, depositAmount, numOutcomes, currencyAsaId)
}

export async function withdrawLiquidity(
  config: ClientConfig,
  sharesToBurn: bigint,
  numOutcomes: number,
  currencyAsaId: number,
) {
  void config
  void sharesToBurn
  void numOutcomes
  void currencyAsaId
  throw new Error('Active LP withdrawals are disabled in the current market line. Claim LP residual after settlement instead.')
}

export async function enterActiveLpForDeposit(
  config: ClientConfig,
  maxDeposit: bigint,
  numOutcomes: number,
  currencyAsaId: number,
  options?: {
    expectedPrices?: bigint[]
    priceTolerance?: bigint
  },
): Promise<EnterActiveLpResult> {
  const state = await getMarketState(config.algodClient, Number(config.appId))
  assertActiveLpSkewWithinCap(state)
  const expectedPrices = options?.expectedPrices ?? state.prices
  const targetDeltaB = targetDeltaBForActiveLpDepositFromPrices(maxDeposit, expectedPrices)
  if (targetDeltaB <= 0n) {
    throw new Error('Deposit is too small to add any active LP depth at the current market price.')
  }

  return enterActiveLp(
    config,
    targetDeltaB,
    maxDeposit,
    numOutcomes,
    currencyAsaId,
    {
      expectedPrices,
      priceTolerance: options?.priceTolerance,
    },
  )
}

export async function enterActiveLp(
  config: ClientConfig,
  targetDeltaB: bigint,
  maxDeposit: bigint,
  numOutcomes: number,
  currencyAsaId: number,
  options?: {
    expectedPrices?: bigint[]
    priceTolerance?: bigint
  },
): Promise<EnterActiveLpResult> {
  const prependTxns = (await Promise.all([
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
    buildAppOptInIfNeeded(config.algodClient, config.sender, config.signer, config.appId),
  ])).filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const state = await getMarketState(config.algodClient, Number(config.appId))
  assertActiveLpSkewWithinCap(state)
  const expectedPrices = options?.expectedPrices ?? state.prices
  if (expectedPrices.length !== numOutcomes) {
    throw new Error(`expected ${numOutcomes} prices, received ${expectedPrices.length}`)
  }

  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, currencyAsaId, maxDeposit, sp)
  const budgetAppId = numOutcomes >= HIGH_OUTCOME_BUDGET_MIN_OUTCOMES
    ? await getProtocolConfigAppId(config.algodClient, config.appId)
    : undefined
  const budgetForeignApps = budgetAppId
    ? getProtocolBudgetForeignApps(config.appId)
    : undefined

  const result = await callWithBudget(
    config,
    'enter_lp_active',
    [targetDeltaB, maxDeposit, expectedPrices, options?.priceTolerance ?? 1n, { txn: paymentTxn, signer: config.signer }],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    {
      prependTxns,
      boxOverride: [
        ...pricingBoxRefs(Number(config.appId), numOutcomes),
        { appIndex: Number(config.appId), name: boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, config.sender) },
      ],
      foreignAssets: [currencyAsaId],
      innerTxnCount: 1,
      budgetAppId,
      budgetForeignApps,
    },
  )

  return {
    txId: result.txId,
    targetDeltaB,
    maxDeposit,
  }
}

export async function claimLpFees(
  config: ClientConfig,
): Promise<{ txId: string }> {
  const result = await callMethod(config, methods, 'claim_lp_fees', [], {
    boxes: [{ appIndex: Number(config.appId), name: boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, config.sender) }],
  })
  return { txId: result.txID }
}

export async function withdrawLpFees(
  config: ClientConfig,
  amount: bigint,
  currencyAsaId: number,
): Promise<{ txId: string; amount: bigint }> {
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))

  const result = await callMethod(config, methods, 'withdraw_lp_fees', [amount], {
    prependTxns,
    appForeignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })
  return { txId: result.txID, amount }
}

export async function claimLpResidual(
  config: ClientConfig,
  currencyAsaId: number,
): Promise<{ txId: string }> {
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const state = await getMarketState(config.algodClient, Number(config.appId))
  const numOutcomes = Math.max(2, Number(state.numOutcomes ?? state.prices.length ?? 0))
  const result = await callWithBudget(
    config,
    'claim_lp_residual',
    [],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    {
      prependTxns,
      boxOverride: marketBoxRefs(Number(config.appId), numOutcomes, config.sender),
      foreignAssets: [currencyAsaId],
      innerTxnCount: 1,
    },
  )
  return { txId: result.txId }
}

export async function getLpAccountState(
  algod: algosdk.Algodv2,
  appId: number,
  address: string,
): Promise<LpAccountState> {
  const [localState, claimableFeesBox] = await Promise.all([
    readAccountLocalState(algod, appId, address),
    readBox(algod, appId, boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, address)).catch(() => new Uint8Array()),
  ])

  const decodeLocalU64 = (key: string) => {
    const value = localState[key]
    return typeof value === 'bigint' ? value : 0n
  }

  return {
    lpShares: decodeLocalU64(MARKET_LOCAL_LP_SHARES),
    feeSnapshot: decodeLocalU64(MARKET_LOCAL_FEE_SNAPSHOT),
    withdrawableFeeSurplus: decodeLocalU64(MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS),
    lpWeightedEntrySum: decodeLocalU64(MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM),
    residualClaimed: decodeLocalU64(MARKET_LOCAL_RESIDUAL_CLAIMED),
    claimableFees: claimableFeesBox.length >= 8 ? algosdk.decodeUint64(claimableFeesBox, 'bigint') : 0n,
  }
}

export async function collectLpFees(
  config: ClientConfig,
  currencyAsaId: number,
): Promise<CollectLpFeesResult> {
  const before = await getLpAccountState(config.algodClient, Number(config.appId), config.sender)
  let claimTxId: string | undefined

  if (before.claimableFees > 0n) {
    const claimResult = await claimLpFees(config)
    claimTxId = claimResult.txId
  }

  const afterClaim = await getLpAccountState(config.algodClient, Number(config.appId), config.sender)
  if (afterClaim.withdrawableFeeSurplus <= 0n) {
    return {
      claimTxId,
      withdrawTxId: undefined,
      withdrawnAmount: 0n,
    }
  }

  const withdrawResult = await withdrawLpFees(config, afterClaim.withdrawableFeeSurplus, currencyAsaId)
  return {
    claimTxId,
    withdrawTxId: withdrawResult.txId,
    withdrawnAmount: withdrawResult.amount,
  }
}

// ---------------------------------------------------------------------------
// Resolution lifecycle
// ---------------------------------------------------------------------------

export async function triggerResolution(config: ClientConfig, numOutcomes = 2) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const liveStatus = Number(stateValue<bigint>(gs, 'st', 'status') ?? 0n)
  if (liveStatus !== STATUS_ACTIVE) {
    throw new Error('This market is not active anymore.')
  }

  const liveDeadline = Number(stateValue<bigint>(gs, 'dl', 'deadline') ?? 0n)
  const latestTimestamp = await getLatestBlockTimestamp(config.algodClient)
  if (liveDeadline > 0 && latestTimestamp > 0 && latestTimestamp < liveDeadline) {
    throw new Error("This market's deadline has not passed on-chain yet. Refresh and try again in a moment.")
  }

  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  return callWithBudget(config, 'trigger_resolution', [], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function proposeResolution(
  config: ClientConfig,
  outcomeIndex: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolutionAuthority = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ra', 'resolution_authority'))
  const resolvedBondAmount = bondAmount ?? (
    resolutionAuthority === config.sender
      ? 0n
      : requiredBondFromState(
          stateValue<bigint>(gs, 'prb', 'proposal_bond') ?? 0n,
          stateValue<bigint>(gs, 'pbb', 'proposal_bond_bps') ?? 0n,
          stateValue<bigint>(gs, 'pbc', 'proposal_bond_cap') ?? 0n,
          stateValue<bigint>(gs, 'pb', 'pool_balance') ?? 0n,
          stateValue<bigint>(gs, 'bd', 'bootstrap_deposit') ?? 0n,
        )
  )
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'propose_resolution',
    [outcomeIndex, evidenceHash, { txn: paymentTxn, signer: config.signer }],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function proposeEarlyResolution(
  config: ClientConfig,
  outcomeIndex: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolvedBondAmount = bondAmount ?? 0n
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'propose_early_resolution',
    [outcomeIndex, evidenceHash, { txn: paymentTxn, signer: config.signer }],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function challengeResolution(
  config: ClientConfig,
  reasonCode: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolvedBondAmount = bondAmount ?? requiredBondFromState(
    stateValue<bigint>(gs, 'cb', 'challenge_bond') ?? 0n,
    stateValue<bigint>(gs, 'cbb', 'challenge_bond_bps') ?? 0n,
    stateValue<bigint>(gs, 'cbc', 'challenge_bond_cap') ?? 0n,
    stateValue<bigint>(gs, 'pb', 'pool_balance') ?? 0n,
    stateValue<bigint>(gs, 'bd', 'bootstrap_deposit') ?? 0n,
  )
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const bondTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'challenge_resolution',
    [{ txn: bondTxn, signer: config.signer }, reasonCode, evidenceHash],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function finalizeResolution(config: ClientConfig, numOutcomes = 2) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer),
  ])
  return callWithBudget(config, 'finalize_resolution', [], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function registerDispute(
  config: ClientConfig,
  disputeRefHash: Uint8Array,
  backendKind: number,
  deadline: number,
  numOutcomes = 2,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  return callWithBudget(config, 'register_dispute', [disputeRefHash, backendKind, BigInt(deadline)], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

async function resolveDisputeCall(
  config: ClientConfig,
  methodName: string,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes: number,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const originalProposal = Number(stateValue<bigint>(gs, 'po', 'proposed_outcome') ?? 0n)
  const payoutRecipients = outcomeIndex === originalProposal
    ? [proposer]
    : [challenger]
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer, challenger, ...payoutRecipients),
  ])
  return callWithBudget(config, methodName, [outcomeIndex, rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function creatorResolveDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'creator_resolve_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function adminResolveDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'admin_resolve_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function finalizeDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'finalize_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function abortEarlyResolution(
  config: ClientConfig,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer, challenger),
  ])
  return callWithBudget(config, 'abort_early_resolution', [rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function cancelDisputeAndMarket(
  config: ClientConfig,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), challenger),
  ])
  return callWithBudget(config, 'cancel_dispute_and_market', [rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

// ---------------------------------------------------------------------------
// Claims & refunds
// ---------------------------------------------------------------------------

export async function claim(
  config: ClientConfig,
  outcomeIndex: number,
  numOutcomes: number,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<ClaimSharesResult> {
  assertWholeShareMultiple(shares, 'claim')
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const usdcBefore = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  const result = await callWithBudget(config, 'claim', [outcomeIndex, shares], numOutcomes, outcomeIndex, noopsFor(numOutcomes), {
    prependTxns,
    foreignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })
  const usdcAfter = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  return {
    txId: result.txId,
    shares,
    payout: usdcAfter - usdcBefore,
  }
}

export async function cancel(config: ClientConfig, numOutcomes = 2) {
  return callWithBudget(config, 'cancel', [], numOutcomes, 0, 4)
}

export async function refund(
  config: ClientConfig,
  outcomeIndex: number,
  numOutcomes: number,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<RefundSharesResult> {
  assertWholeShareMultiple(shares, 'refund')
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const usdcBefore = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  const result = await callWithBudget(config, 'refund', [outcomeIndex, shares], numOutcomes, outcomeIndex, 10, {
    prependTxns,
    foreignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })
  const usdcAfter = await getAssetBalance(config.algodClient, config.sender, currencyAsaId)
  return {
    txId: result.txId,
    shares,
    refundAmount: usdcAfter - usdcBefore,
  }
}

export async function withdrawPendingPayouts(
  config: ClientConfig,
  currencyAsaId: number,
) {
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  return callWithBudget(config, 'withdraw_pending_payouts', [], 2, 0, 4, {
    prependTxns,
    extraBoxes: [{ appIndex: Number(config.appId), name: boxNameAddr('pp:', config.sender) }],
    foreignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })
}

export async function postComment(
  config: ClientConfig,
  message: string,
  numOutcomes: number,
) {
  const method = methods.get('post_comment')
  if (!method) {
    throw new Error('Comment methods are missing from the ABI spec')
  }

  const allBoxes = deduplicateBoxes(commentBoxRefs(Number(config.appId), numOutcomes, config.sender))
  const { methodBoxes, noopBoxChunks } = splitCommentBoxRefs(allBoxes)
  const suggestedParams = await config.algodClient.getTransactionParams().do()
  const atc = new algosdk.AtomicTransactionComposer()

  for (const [index, boxes] of noopBoxChunks.entries()) {
    atc.addTransaction({
      txn: makeBareAppNoOp(config.sender, Number(config.appId), suggestedParams, {
        note: new TextEncoder().encode(`npost_comment${index}`),
        boxes,
      }),
      signer: config.signer,
    })
  }

  atc.addMethodCall({
    appID: Number(config.appId),
    method,
    methodArgs: [message],
    sender: config.sender,
    suggestedParams,
    signer: config.signer,
    boxes: methodBoxes.length > 0 ? methodBoxes : undefined,
  })

  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowUnnamedResources: false,
    allowEmptySignatures: true,
  })
  const { simulateResponse } = await atc.simulate(config.algodClient, request)
  const txnGroup = simulateResponse.txnGroups[0]
  if (!txnGroup) {
    throw new Error('No simulate transaction group returned for post_comment')
  }
  if (txnGroup.failureMessage) {
    throw new Error(txnGroup.failureMessage)
  }

  const result = await atc.execute(config.algodClient, 4)
  return Object.assign(result.methodResults[result.methodResults.length - 1], {
    txId: result.txIDs[result.txIDs.length - 1],
  })
}

// ---------------------------------------------------------------------------
// Protocol fees
// ---------------------------------------------------------------------------

export async function withdrawProtocolFees(
  config: ClientConfig,
  protocolConfigAppId: number,
  currencyAsaId: number,
) {
  return callMethod(config, methods, 'withdraw_protocol_fees', [], {
    appForeignApps: [protocolConfigAppId],
    appForeignAssets: [currencyAsaId],
    innerTxnCount: 1,
  })
}

// ---------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------

/**
 * Read full market state from on-chain global state + box storage.
 */
export async function getMarketState(
  algod: algosdk.Algodv2,
  appId: number,
): Promise<MarketState> {
  const gs = await readGlobalState(algod, appId)

  const numOutcomes = Number(stateValue<bigint>(gs, 'no', 'num_outcomes') ?? 2n)

  // Read outcome quantities from boxes
  const quantities: bigint[] = []
  for (let i = 0; i < numOutcomes; i++) {
    try {
      const val = await readBox(algod, appId, boxName('q', i))
      quantities.push(algosdk.decodeUint64(val, 'bigint'))
    } catch {
      quantities.push(0n)
    }
  }

  const b = gs['b'] as bigint ?? 0n
  const prices = b > 0n ? calculatePrices(quantities, b) : quantities.map(() => 0n)
  const poolBalance = stateValue<bigint>(gs, 'pb', 'pool_balance') ?? 0n
  const bootstrapDeposit = stateValue<bigint>(gs, 'bd', 'bootstrap_deposit') ?? 0n
  const minChallengeBond = stateValue<bigint>(gs, 'cb', 'challenge_bond') ?? 0n
  const minProposalBond = stateValue<bigint>(gs, 'prb', 'proposal_bond') ?? 0n
  const challengeBondBps = Number(stateValue<bigint>(gs, 'cbb', 'challenge_bond_bps') ?? 0n)
  const proposalBondBps = Number(stateValue<bigint>(gs, 'pbb', 'proposal_bond_bps') ?? 0n)
  const challengeBondCap = stateValue<bigint>(gs, 'cbc', 'challenge_bond_cap') ?? 0n
  const proposalBondCap = stateValue<bigint>(gs, 'pbc', 'proposal_bond_cap') ?? 0n
  const proposerFeeBps = Number(stateValue<bigint>(gs, 'pfd', 'proposer_fee_bps') ?? 0n)
  const proposerFeeFloorBps = Number(stateValue<bigint>(gs, 'pff', 'proposer_fee_floor_bps') ?? 0n)
  const challengeBond = requiredBondFromState(minChallengeBond, BigInt(challengeBondBps), challengeBondCap, poolBalance, bootstrapDeposit)
  const proposalBond = requiredBondFromState(minProposalBond, BigInt(proposalBondBps), proposalBondCap, poolBalance, bootstrapDeposit)

  return {
    appId,
    contractVersion: Number(gs['contract_version'] ?? BigInt(CURRENT_MARKET_CONTRACT_VERSION)),
    creator: algosdk.encodeAddress(stateValue<Uint8Array>(gs, 'cr', 'creator') ?? new Uint8Array(32)),
    status: Number(stateValue<bigint>(gs, 'st', 'status') ?? 0n),
    numOutcomes,
    b,
    poolBalance,
    lpSharesTotal: stateValue<bigint>(gs, 'lst', 'lp_shares_total') ?? 0n,
    lpFeeBps: Number(stateValue<bigint>(gs, 'lfb', 'lp_fee_bps') ?? 0n),
    protocolFeeBps: Number(stateValue<bigint>(gs, 'pfb', 'protocol_fee_bps') ?? 0n),
    residualLinearLambdaFp: stateValue<bigint>(gs, 'rlf', 'residual_linear_lambda_fp') ?? 0n,
    lpEntryMaxPriceFp: stateValue<bigint>(gs, 'lpm', 'lp_entry_max_price_fp') ?? BigInt(DEFAULT_LP_ENTRY_MAX_PRICE_FP),
    activationTimestamp: Number(stateValue<bigint>(gs, 'ats', 'activation_timestamp') ?? 0n),
    settlementTimestamp: Number(stateValue<bigint>(gs, 'sts', 'settlement_timestamp') ?? 0n),
    withdrawableFeeSurplus: stateValue<bigint>(gs, 'withdraw_fee_surplus', 'wfs') ?? 0n,
    totalResidualClaimed: stateValue<bigint>(gs, 'rct', 'total_residual_claimed') ?? 0n,
    deadline: Number(stateValue<bigint>(gs, 'dl', 'deadline') ?? 0n),
    questionHash: stateValue<Uint8Array>(gs, 'qh', 'question_hash') ?? new Uint8Array(32),
    mainBlueprintHash: stateValue<Uint8Array>(gs, 'mbh', 'main_blueprint_hash') ?? new Uint8Array(32),
    disputeBlueprintHash: stateValue<Uint8Array>(gs, 'dbh', 'dispute_blueprint_hash') ?? new Uint8Array(32),
    resolutionAuthority: algosdk.encodeAddress(stateValue<Uint8Array>(gs, 'ra', 'resolution_authority') ?? new Uint8Array(32)),
    marketAdmin: algosdk.encodeAddress(stateValue<Uint8Array>(gs, 'ma', 'market_admin') ?? new Uint8Array(32)),
    proposedOutcome: Number(stateValue<bigint>(gs, 'po', 'proposed_outcome') ?? 0n),
    proposalTimestamp: Number(stateValue<bigint>(gs, 'pts', 'proposal_timestamp') ?? 0n),
    winningOutcome: Number(stateValue<bigint>(gs, 'wo', 'winning_outcome') ?? 0n),
    challengeWindowSecs: Number(stateValue<bigint>(gs, 'cws', 'challenge_window_secs') ?? 0n),
    challengeBond,
    proposalBond,
    minChallengeBond,
    minProposalBond,
    challengeBondBps,
    proposalBondBps,
    challengeBondCap,
    proposalBondCap,
    proposerFeeBps,
    proposerFeeFloorBps,
    bootstrapDeposit,
    resolutionBudgetBalance: stateValue<bigint>(gs, 'rbb', 'resolution_budget_balance') ?? 0n,
    gracePeriodSecs: Number(stateValue<bigint>(gs, 'gps', 'grace_period_secs') ?? 0n),
    proposerBondHeld: stateValue<bigint>(gs, 'pbh', 'proposer_bond_held') ?? 0n,
    challengerBondHeld: stateValue<bigint>(gs, 'cbh', 'challenger_bond_held') ?? 0n,
    disputeSinkBalance: stateValue<bigint>(gs, 'dsb', 'dispute_sink_balance') ?? 0n,
    cancellable: (stateValue<bigint>(gs, 'cn', 'cancellable') ?? 0n) !== 0n,
    quantities,
    prices,
  }
}
