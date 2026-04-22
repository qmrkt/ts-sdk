import algosdk from 'algosdk'
import { type ClientConfig, loadMethods, boxName, ceilDiv, withMinFlatFee, withExplicitFlatFee, textEncoder, SECONDS_PER_DAY } from './base.js'
import {
  DEFAULT_LP_ENTRY_MAX_PRICE_FP as DEFAULT_LP_ENTRY_MAX_PRICE_FP_NUMBER,
} from './market-schema.js'
import { readConfig, type ProtocolConfig } from './protocol-config.js'
import { marketFactorySpec as spec } from './contract-specs.js'

const methods = loadMethods(spec)
export const FACTORY_CREATE_MBR = 5_000_000n
const ATOMIC_MARKET_MBR_FLOOR = 2_500_000n
const RETRY_LIMIT = 8
const MIN_OUTCOMES = 2
export const MAX_ACTIVE_LP_OUTCOMES = 8
export const DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT = BigInt(DEFAULT_LP_ENTRY_MAX_PRICE_FP_NUMBER)
export const DEFAULT_LP_ENTRY_MAX_PRICE_FP = DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT
export const ACCOUNT_BASE_MBR = 100_000n
export const ASA_HOLDING_MBR = 100_000n
const BOX_FLAT_MBR = 2_500n
const BOX_BYTE_MBR = 400n
// Per-slot MBR contributions for the new market account.
export const APP_PAGE_MBR = 100_000n
export const APP_GLOBAL_UINT_MBR = 28_500n
export const APP_GLOBAL_BYTES_MBR = 50_000n
// Must match the numbers compiled into the factory's market_create inner-txn.
export const QUESTION_MARKET_EXTRA_PAGES = 3n
export const QUESTION_MARKET_GLOBAL_UINTS = 48n
export const QUESTION_MARKET_GLOBAL_BYTES = 15n
export class AtomicCreateUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AtomicCreateUnsupportedError'
  }
}

interface PendingTransactionResultLike {
  applicationIndex?: unknown
  'application-index'?: unknown
  innerTxns?: unknown
  'inner-txns'?: unknown
}

function extractCreatedAppIdFromPendingResult(result: PendingTransactionResultLike | null | undefined): number | undefined {
  const directAppId = Number(result?.applicationIndex ?? result?.['application-index'] ?? 0)
  if (directAppId > 0) {
    return directAppId
  }

  const innerTxns = result?.innerTxns ?? result?.['inner-txns']
  if (!Array.isArray(innerTxns)) {
    return undefined
  }

  for (const inner of innerTxns) {
    const nestedAppId = extractCreatedAppIdFromPendingResult(
      inner && typeof inner === 'object' ? (inner as PendingTransactionResultLike) : undefined,
    )
    if (nestedAppId !== undefined) {
      return nestedAppId
    }
  }

  return undefined
}

async function readConfirmedCreatedAppId(
  algod: algosdk.Algodv2,
  txId: string,
): Promise<number> {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    const pending = await algod.pendingTransactionInformation(txId).do()
    const createdAppId = extractCreatedAppIdFromPendingResult(pending)
    if (createdAppId !== undefined) {
      return createdAppId
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`could not determine created app ID from confirmed transaction ${txId}`)
}

export interface CreateMarketParams {
  currencyAsa: number
  questionHash: Uint8Array
  numOutcomes: number
  initialB: bigint
  lpFeeBps: number
  /** IPFS CID for the combined blueprint (main + dispute) */
  blueprintCid: Uint8Array
  deadline: number
  challengeWindowSecs: number
  marketAdmin?: string
  gracePeriodSecs?: number
  cancellable: boolean
  bootstrapDeposit: bigint
  lpEntryMaxPriceFp?: bigint
  protocolConfigAppId: number
  note?: Uint8Array
}

export interface CreateMarketAtomicParams extends CreateMarketParams {
  marketMbrFunding?: bigint
  bootstrapFundingAmount?: bigint
}

export function getAtomicCreateOutcomeLimit(): number {
  return MAX_ACTIVE_LP_OUTCOMES
}

export function lmsrBootstrapMultiplier(numOutcomes: number): bigint {
  if (numOutcomes <= 2) return 1n
  if (numOutcomes <= 7) return 2n
  return 3n
}

export function minimumBootstrapDeposit(initialB: bigint, numOutcomes: number): bigint {
  return initialB * lmsrBootstrapMultiplier(numOutcomes)
}

export function getChallengeWindowSupportError(
  challengeWindowSecs: number,
  minChallengeWindowSecs: number,
): string | undefined {
  if (challengeWindowSecs < minChallengeWindowSecs) {
    return `market creation requires a challenge window of at least ${minChallengeWindowSecs} seconds`
  }
  return undefined
}

export function requiredResolutionBudgetFromConfig(
  protocolConfig: Pick<ProtocolConfig, 'proposalBond' | 'proposalBondCap' | 'proposerFeeBps' | 'proposerFeeFloorBps'>,
  challengeWindowSecs: number,
): bigint {
  const floorFee = ceilDiv(protocolConfig.proposalBond * BigInt(protocolConfig.proposerFeeFloorBps), 10_000n)
  const dailyFee = ceilDiv(protocolConfig.proposalBondCap * BigInt(protocolConfig.proposerFeeBps), 10_000n)
  const windowFee = ceilDiv(dailyFee * BigInt(challengeWindowSecs), SECONDS_PER_DAY)
  return windowFee > floorFee ? windowFee : floorFee
}

function boxMbr(name: Uint8Array, size: number): bigint {
  return BOX_FLAT_MBR + BOX_BYTE_MBR * BigInt(name.length + size)
}

export function estimateAtomicMarketMbrFunding(
  _params: Pick<CreateMarketAtomicParams, 'numOutcomes'>,
): bigint {
  // Actual MBR cost on the new market app's account:
  //   base + ASA opt-in + extra program pages + global state slots.
  // All values sourced from the Algorand MBR rules in effect since round ~30M.
  return (
    ACCOUNT_BASE_MBR +
    ASA_HOLDING_MBR +
    QUESTION_MARKET_EXTRA_PAGES * APP_PAGE_MBR +
    QUESTION_MARKET_GLOBAL_UINTS * APP_GLOBAL_UINT_MBR +
    QUESTION_MARKET_GLOBAL_BYTES * APP_GLOBAL_BYTES_MBR
  )
}

/**
 * Total ALGO the creator wallet must forward to the factory in txn 1 of the
 * atomic create group. Matches the sum used inside `createMarketAtomic`.
 */
export function estimateAtomicCreatorAlgoFunding(
  params: Pick<CreateMarketAtomicParams, 'numOutcomes'>,
): bigint {
  return estimateAtomicMarketMbrFunding(params) + FACTORY_CREATE_MBR
}

function validateAtomicOutcomeCount(numOutcomes: number): void {
  if (numOutcomes < MIN_OUTCOMES) {
    throw new AtomicCreateUnsupportedError(`atomic market creation requires at least ${MIN_OUTCOMES} outcomes`)
  }
  if (numOutcomes > MAX_ACTIVE_LP_OUTCOMES) {
    throw new AtomicCreateUnsupportedError(`atomic market creation supports at most ${MAX_ACTIVE_LP_OUTCOMES} outcomes`)
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle) {
    throw new AtomicCreateUnsupportedError('crypto.subtle is unavailable for atomic blueprint hashing')
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', data.slice())
  return new Uint8Array(digest)
}

/**
 * Build canonical `create_market` ABI args, excluding the funding payment txn.
 */
export function buildCreateMarketMethodArgs(
  params: CreateMarketParams,
  sender: string,
): algosdk.ABIValue[] {
  return [
    BigInt(params.currencyAsa),
    params.questionHash,
    BigInt(params.numOutcomes),
    params.initialB,
    BigInt(params.lpFeeBps),
    params.blueprintCid,
    BigInt(params.deadline),
    BigInt(params.challengeWindowSecs),
    params.marketAdmin ?? sender,
    BigInt(params.gracePeriodSecs ?? 0),
    params.cancellable,
    params.lpEntryMaxPriceFp ?? DEFAULT_LP_ENTRY_MAX_PRICE_FP,
  ]
}

async function resolveInitialB(
  config: ClientConfig,
  params: CreateMarketParams,
): Promise<CreateMarketParams> {
  const protocolConfig = await readConfig(config.algodClient, params.protocolConfigAppId)
  const challengeWindowSupportError = getChallengeWindowSupportError(
    params.challengeWindowSecs,
    protocolConfig.minChallengeWindowSecs,
  )
  if (challengeWindowSupportError) {
    throw new AtomicCreateUnsupportedError(challengeWindowSupportError)
  }
  let initialB = params.initialB
  if (initialB <= 0n) {
    if (protocolConfig.defaultB <= 0n) {
      throw new AtomicCreateUnsupportedError('protocol config defaultB must be set before market creation')
    }
    initialB = protocolConfig.defaultB
  }
  const requiredBootstrapDeposit = minimumBootstrapDeposit(initialB, params.numOutcomes)
  if (params.bootstrapDeposit < requiredBootstrapDeposit) {
    throw new AtomicCreateUnsupportedError(
      `market creation requires at least ${Number(requiredBootstrapDeposit) / 1_000_000} bootstrap units for ${params.numOutcomes} outcomes at b=${Number(initialB) / 1_000_000}`,
    )
  }
  return {
    ...params,
    initialB,
  }
}

/**
 * Disabled sequential create entrypoint.
 *
 * `createMarket()` used to expose the non-atomic factory-only flow. Use
 * `createMarketAtomic()` for all market creation.
 */
export async function createMarket(
  _config: ClientConfig,
  _params: CreateMarketParams,
): Promise<number> {
  throw new AtomicCreateUnsupportedError(
    'createMarket() is disabled. Use createMarketAtomic() for atomic market creation.',
  )
}

export async function createMarketAtomic(
  config: ClientConfig,
  params: CreateMarketAtomicParams,
): Promise<{ marketAppId: number; txId: string }> {
  validateAtomicOutcomeCount(params.numOutcomes)
  const resolvedInitialB = await resolveInitialB(config, params)
  const protocolConfig = await readConfig(config.algodClient, params.protocolConfigAppId)
  const requiredBootstrapDeposit = minimumBootstrapDeposit(
    resolvedInitialB.initialB,
    params.numOutcomes,
  )
  if (params.bootstrapDeposit < requiredBootstrapDeposit) {
    throw new AtomicCreateUnsupportedError(
      `atomic market creation requires at least ${Number(requiredBootstrapDeposit) / 1_000_000} bootstrap units for ${params.numOutcomes} outcomes at b=${Number(resolvedInitialB.initialB) / 1_000_000}`,
    )
  }

  const bootstrapFundingAmount =
    params.bootstrapFundingAmount ??
    (params.bootstrapDeposit + requiredResolutionBudgetFromConfig(protocolConfig, params.challengeWindowSecs))
  const factoryAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()

  // The factory does everything via inner transactions:
  //   1. Creates the market app (from box-stored bytecode)
  //   2. Funds it with MBR
  //   3. Calls initialize (ASA opt-in)
  //   4. Forwards USDC to market + calls bootstrap
  // Returns the created app ID. No prediction needed.

  // MBR: account base + ASA + global state slots + extra pages.
  // Default matches the exact cost published by estimateAtomicMarketMbrFunding
  // so the UI's displayed ALGO total equals what gets sent on-chain.
  const mbrFunding = params.marketMbrFunding ?? estimateAtomicMarketMbrFunding(params)
  const totalAlgoFunding = mbrFunding + FACTORY_CREATE_MBR

  const sp = await config.algodClient.getTransactionParams().do()
  const atc = new algosdk.AtomicTransactionComposer()

  // Txn 1: ALGO payment to factory (for market MBR + factory reserve)
  const algoFundingTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: factoryAddr,
    amount: totalAlgoFunding,
    suggestedParams: withMinFlatFee(sp),
  })

  // Txn 2: USDC payment to factory (bootstrap deposit + resolution budget)
  const usdcFundingTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: factoryAddr,
    assetIndex: params.currencyAsa,
    amount: bootstrapFundingAmount,
    suggestedParams: withMinFlatFee(sp),
  })

  // Txn 3: factory.create_market (does everything via inner txns, returns app ID)
  const createMethod = methods.get('create_market')!
  const te = new TextEncoder()

  // Box IO budget: each box ref in the group adds 1024 bytes of read+write budget.
  // The approval program is ~8KB, so we need ~8 refs total for "ap".
  // Max 8 box refs per transaction, so spread across multiple txns in the group.
  const apBoxRef: algosdk.BoxReference = { appIndex: Number(config.appId), name: te.encode('ap') }
  const cpBoxRef: algosdk.BoxReference = { appIndex: Number(config.appId), name: te.encode('cp') }

  // Add noop ABI calls for extra box IO budget (each carries box refs)
  const noopMethod = methods.get('noop')!
  const PADDING_TXNS = 2
  for (let i = 0; i < PADDING_TXNS; i++) {
    atc.addMethodCall({
      appID: Number(config.appId),
      method: noopMethod,
      methodArgs: [],
      sender: config.sender,
      suggestedParams: withMinFlatFee(sp),
      signer: config.signer,
      boxes: Array.from({ length: 8 }, () => apBoxRef),
      note: te.encode(`bp:${i}`),
    })
  }

  atc.addMethodCall({
    appID: Number(config.appId),
    method: createMethod,
    methodArgs: [
      ...buildCreateMarketMethodArgs(
        { ...params, initialB: resolvedInitialB.initialB },
        config.sender,
      ),
      params.bootstrapDeposit,
      { txn: algoFundingTxn, signer: config.signer },
      { txn: usdcFundingTxn, signer: config.signer },
    ],
    sender: config.sender,
    // Fee covers all inner txns: create + fund + setup(with inner ASA opt-in) + usdc_forward + bootstrap
    suggestedParams: withExplicitFlatFee(sp, BigInt((params.numOutcomes + 10) * 1000)),
    signer: config.signer,
    note: params.note,
    appForeignApps: [params.protocolConfigAppId],
    appForeignAssets: [params.currencyAsa],
    boxes: [apBoxRef, apBoxRef, apBoxRef, apBoxRef, cpBoxRef],
  })

  const result = await atc.execute(config.algodClient, 4)
  const txId = result.txIDs[result.txIDs.length - 1]!

  // Extract the app ID from the ABI return value (last method result, after noop padding)
  const methodResult = result.methodResults[result.methodResults.length - 1]
  let marketAppId: number
  if (methodResult?.returnValue !== undefined) {
    marketAppId = Number(methodResult.returnValue)
  } else {
    marketAppId = await readConfirmedCreatedAppId(config.algodClient, txId)
  }

  return { marketAppId, txId }
}
export async function listMarketIds(
  _algod: algosdk.Algodv2,
  _factoryAppId: number | bigint,
): Promise<number[]> {
  return []
}
