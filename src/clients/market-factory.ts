import algosdk from 'algosdk'
import { type ClientConfig, loadMethods, boxName, boxNameAddr, bootstrapBoxRefs } from './base.js'
import {
  DEFAULT_LP_ENTRY_MAX_PRICE_FP as DEFAULT_LP_ENTRY_MAX_PRICE_FP_NUMBER,
} from './market-schema.js'
import { readConfig, type ProtocolConfig } from './protocol-config.js'
import { marketFactorySpec as spec, questionMarketSpec as marketSpec } from './contract-specs.js'

const methods = loadMethods(spec)
const marketMethods = loadMethods(marketSpec)
const FACTORY_CREATE_MBR = 5_000_000n
const ATOMIC_MARKET_MBR_FLOOR = 2_500_000n
const MAX_CREATE_RETRIES = 8
const GROUP_LIMIT = 16
// Includes the payment/asset-transfer txn args embedded inside ATC method calls.
const BASE_ATOMIC_CREATE_TXNS = 9
const MAX_REFS_PER_TXN = 8
const MIN_OUTCOMES = 2
export const MAX_ACTIVE_LP_OUTCOMES = 8
export const DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT = BigInt(DEFAULT_LP_ENTRY_MAX_PRICE_FP_NUMBER)
export const DEFAULT_LP_ENTRY_MAX_PRICE_FP = DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT
const ACCOUNT_BASE_MBR = 100_000n
const ASA_HOLDING_MBR = 100_000n
const BOX_FLAT_MBR = 2_500n
const BOX_BYTE_MBR = 400n
const MIN_TXN_FEE = 1_000n
const SECONDS_PER_DAY = 86_400n
const textEncoder = new TextEncoder()

export class AtomicCreateUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AtomicCreateUnsupportedError'
  }
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

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

async function advanceRound(
  config: ClientConfig,
  receiver: string,
) {
  const sp = await config.algodClient.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver,
    amount: 0,
    suggestedParams: withMinFlatFee(sp),
    note: new TextEncoder().encode(`factory-retry:${Date.now()}`),
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: config.signer })
  await atc.execute(config.algodClient, 4)
}

function extractCreatedAppIdFromPendingResult(result: any): number | undefined {
  const directAppId = Number(result?.applicationIndex ?? result?.['application-index'] ?? 0)
  if (directAppId > 0) {
    return directAppId
  }

  const innerTxns = result?.innerTxns ?? result?.['inner-txns'] ?? []
  if (!Array.isArray(innerTxns)) {
    return undefined
  }

  for (const inner of innerTxns) {
    const nestedAppId = extractCreatedAppIdFromPendingResult(inner)
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
  for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt += 1) {
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
  // Deprecated: creator is derived from the transaction sender in MarketFactory.
  creator?: string
  currencyAsa: number
  questionHash: Uint8Array
  numOutcomes: number
  initialB: bigint
  lpFeeBps: number
  blueprintHash?: Uint8Array
  mainBlueprintHash?: Uint8Array
  disputeBlueprintHash?: Uint8Array
  deadline: number
  challengeWindowSecs: number
  marketAdmin?: string
  // Deprecated: proposal/challenge bonds are protocol-configured in M3.
  proposalBond?: bigint
  gracePeriodSecs?: number
  cancellable: boolean
  bootstrapDeposit: bigint
  lpEntryMaxPriceFp?: bigint
  protocolConfigAppId: number
  note?: Uint8Array
}

export interface CreateMarketAtomicParams extends CreateMarketParams {
  mainBlueprint: Uint8Array
  disputeBlueprint: Uint8Array
  marketMbrFunding?: bigint
  bootstrapFundingAmount?: bigint
  noopCount?: number
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

function atomicCreateBoxRefs(appId: number, numOutcomes: number, sender: string): algosdk.BoxReference[] {
  return deduplicateBoxes([
    ...bootstrapBoxRefs(appId, numOutcomes),
    { appIndex: appId, name: boxNameAddr('uf:', sender) },
  ])
}

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

function chunkBoxes(refs: algosdk.BoxReference[], chunkSize = MAX_REFS_PER_TXN): algosdk.BoxReference[][] {
  const chunks: algosdk.BoxReference[][] = []
  for (let i = 0; i < refs.length; i += chunkSize) {
    chunks.push(refs.slice(i, i + chunkSize))
  }
  return chunks
}

function boxMbr(name: Uint8Array, size: number): bigint {
  return BOX_FLAT_MBR + BOX_BYTE_MBR * BigInt(name.length + size)
}

export function estimateAtomicMarketMbrFunding(
  params: Pick<CreateMarketAtomicParams, 'numOutcomes' | 'mainBlueprint' | 'disputeBlueprint'>,
): bigint {
  const baseFunding =
    ACCOUNT_BASE_MBR +
    ASA_HOLDING_MBR +
    boxMbr(textEncoder.encode('tus'), params.numOutcomes * 8) +
    boxMbr(textEncoder.encode('mb'), params.mainBlueprint.length) +
    boxMbr(textEncoder.encode('db'), params.disputeBlueprint.length)

  let outcomeStorageFunding = 0n
  for (let i = 0; i < params.numOutcomes; i++) {
    outcomeStorageFunding += boxMbr(boxName('q', i), 8)
  }

  const totalFunding = baseFunding + outcomeStorageFunding
  return totalFunding > ATOMIC_MARKET_MBR_FLOOR
    ? totalFunding
    : ATOMIC_MARKET_MBR_FLOOR
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

function extractCreatedAppId(txnGroup: algosdk.modelsv2.SimulateTransactionGroupResult): bigint {
  if (txnGroup.failureMessage) {
    throw new Error(`create_market simulation failed: ${txnGroup.failureMessage}`)
  }
  const methodTxnResult = txnGroup.txnResults[txnGroup.txnResults.length - 1]!
  const innerTxns = methodTxnResult.txnResult.innerTxns
  if (!innerTxns || innerTxns.length === 0) {
    throw new Error('Simulation produced no inner transactions')
  }
  for (const itxn of innerTxns) {
    if (itxn.applicationIndex !== undefined && itxn.applicationIndex > 0n) {
      return itxn.applicationIndex
    }
  }
  throw new Error('Could not determine created app ID from simulation')
}

function buildFactoryCreateComposer(
  config: ClientConfig,
  params: CreateMarketParams,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.AtomicTransactionComposer {
  const method = methods.get('create_market')!
  const factoryAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const atc = new algosdk.AtomicTransactionComposer()

  const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: factoryAddr,
    amount: FACTORY_CREATE_MBR,
    suggestedParams,
  })
  const fundingTxn = { txn: mbrPayment, signer: config.signer }

  const callSp = { ...suggestedParams }
  callSp.flatFee = true
  callSp.fee = BigInt(2000)

  atc.addMethodCall({
    appID: Number(config.appId),
    method,
    methodArgs: [...buildCreateMarketMethodArgs(params, config.sender), fundingTxn],
    sender: config.sender,
    suggestedParams: callSp,
    signer: config.signer,
    note: params.note,
    appForeignApps: [params.protocolConfigAppId],
  })

  return atc
}

async function simulateCreatedAppId(
  config: ClientConfig,
  params: CreateMarketParams,
  suggestedParams: algosdk.SuggestedParams,
): Promise<bigint> {
  const atc = buildFactoryCreateComposer(config, params, suggestedParams)
  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowUnnamedResources: true,
    allowEmptySignatures: true,
  })
  const { simulateResponse } = await atc.simulate(config.algodClient, request)
  const txnGroup = simulateResponse.txnGroups[0]
  if (!txnGroup) {
    throw new Error('No simulate transaction group returned for create_market')
  }
  return extractCreatedAppId(txnGroup)
}

type BuiltAtomicGroup = {
  atc: algosdk.AtomicTransactionComposer
  predictedAppId: bigint
  totalTxns: number
}

function buildAtomicCreateComposer(
  config: ClientConfig,
  params: CreateMarketAtomicParams,
  suggestedParams: algosdk.SuggestedParams,
  predictedAppId: bigint,
  noopCount: number,
): BuiltAtomicGroup {
  const createMethod = methods.get('create_market')!
  const initializeMethod = marketMethods.get('initialize')!
  const storeMainBlueprintMethod = marketMethods.get('store_main_blueprint')!
  const storeDisputeBlueprintMethod = marketMethods.get('store_dispute_blueprint')!
  const bootstrapMethod = marketMethods.get('bootstrap')!
  const marketAppId = Number(predictedAppId)
  const marketAddr = algosdk.getApplicationAddress(marketAppId).toString()
  const marketMbrFunding = params.marketMbrFunding ?? estimateAtomicMarketMbrFunding(params)
  const bootstrapFundingAmount = params.bootstrapFundingAmount ?? params.bootstrapDeposit
  const totalTxns = BASE_ATOMIC_CREATE_TXNS + noopCount
  if (totalTxns > GROUP_LIMIT) {
    throw new AtomicCreateUnsupportedError(`atomic market creation needs ${totalTxns} transactions`)
  }
  const allBoxes = atomicCreateBoxRefs(marketAppId, params.numOutcomes, config.sender)
  const noopBoxChunks = chunkBoxes(allBoxes)
  if (noopCount < noopBoxChunks.length) {
    throw new AtomicCreateUnsupportedError(
      `atomic market creation needs at least ${noopBoxChunks.length} noop transactions to cover ${allBoxes.length} box refs`,
    )
  }

  const atc = new algosdk.AtomicTransactionComposer()

  const factoryMbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: algosdk.getApplicationAddress(Number(config.appId)).toString(),
    amount: FACTORY_CREATE_MBR,
    suggestedParams: withMinFlatFee(suggestedParams),
  })
  const factoryFundingTxn = { txn: factoryMbrPayment, signer: config.signer }

  const createSp = { ...suggestedParams }
  createSp.flatFee = true
  createSp.fee = BigInt(2000)
  atc.addMethodCall({
    appID: Number(config.appId),
    method: createMethod,
    methodArgs: [...buildCreateMarketMethodArgs(params, config.sender), factoryFundingTxn],
    sender: config.sender,
    suggestedParams: createSp,
    signer: config.signer,
    note: params.note,
    appForeignApps: [params.protocolConfigAppId],
  })

  const marketMbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: marketAddr,
    amount: marketMbrFunding,
    suggestedParams: withMinFlatFee(suggestedParams),
  })
  atc.addTransaction({ txn: marketMbrPayment, signer: config.signer })

  const optInTxn = algosdk.makeApplicationOptInTxnFromObject({
    sender: config.sender,
    appIndex: marketAppId,
    suggestedParams: withMinFlatFee(suggestedParams),
  })
  atc.addTransaction({ txn: optInTxn, signer: config.signer })

  for (let i = 0; i < noopCount; i++) {
    const txn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: config.sender,
      appIndex: marketAppId,
      suggestedParams: withMinFlatFee(suggestedParams),
      boxes: noopBoxChunks[i]?.length ? noopBoxChunks[i] : undefined,
      note: textEncoder.encode(`atomic-noop:${i}`),
    })
    atc.addTransaction({ txn, signer: config.signer })
  }

  const initializeSp = { ...suggestedParams }
  initializeSp.flatFee = true
  initializeSp.fee = BigInt((params.numOutcomes + 2) * 1000)
  atc.addMethodCall({
    appID: marketAppId,
    method: initializeMethod,
    methodArgs: [],
    sender: config.sender,
    suggestedParams: initializeSp,
    signer: config.signer,
    appForeignAssets: [params.currencyAsa],
  })

  atc.addMethodCall({
    appID: marketAppId,
    method: storeMainBlueprintMethod,
    methodArgs: [params.mainBlueprint],
    sender: config.sender,
    suggestedParams: withMinFlatFee(suggestedParams),
    signer: config.signer,
    boxes: [{ appIndex: marketAppId, name: textEncoder.encode('mb') }],
  })

  atc.addMethodCall({
    appID: marketAppId,
    method: storeDisputeBlueprintMethod,
    methodArgs: [params.disputeBlueprint],
    sender: config.sender,
    suggestedParams: withMinFlatFee(suggestedParams),
    signer: config.signer,
    boxes: [{ appIndex: marketAppId, name: textEncoder.encode('db') }],
  })

  const depositTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver: marketAddr,
    assetIndex: params.currencyAsa,
    amount: bootstrapFundingAmount,
    suggestedParams: withMinFlatFee(suggestedParams),
  })
  atc.addMethodCall({
    appID: marketAppId,
    method: bootstrapMethod,
    methodArgs: [params.bootstrapDeposit, { txn: depositTxn, signer: config.signer }],
    sender: config.sender,
    suggestedParams: withMinFlatFee(suggestedParams, 2n),
    signer: config.signer,
  })

  return { atc, predictedAppId, totalTxns }
}

type AtomicCreateSimulation = {
  failureMessage?: string
  usedUnnamedResources: boolean
}

async function simulateAtomicCreateGroup(
  config: ClientConfig,
  built: BuiltAtomicGroup,
): Promise<AtomicCreateSimulation> {
  const request = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowUnnamedResources: false,
    allowEmptySignatures: true,
  })
  const { simulateResponse } = await built.atc.simulate(config.algodClient, request)
  const txnGroup = simulateResponse.txnGroups[0]
  if (!txnGroup) {
    throw new AtomicCreateUnsupportedError('atomic create simulation returned no transaction group')
  }

  return {
    failureMessage: txnGroup.failureMessage ?? undefined,
    usedUnnamedResources:
      Boolean(txnGroup.unnamedResourcesAccessed) ||
      txnGroup.txnResults.some((result) => Boolean(result.unnamedResourcesAccessed)),
  }
}

async function planAtomicCreateComposer(
  config: ClientConfig,
  params: CreateMarketAtomicParams,
  suggestedParams: algosdk.SuggestedParams,
  predictedAppId: bigint,
): Promise<BuiltAtomicGroup> {
  const allBoxes = atomicCreateBoxRefs(Number(predictedAppId), params.numOutcomes, config.sender)
  const minNoops = Math.ceil(allBoxes.length / MAX_REFS_PER_TXN)
  const maxNoops = GROUP_LIMIT - BASE_ATOMIC_CREATE_TXNS
  const initialNoops = params.noopCount === undefined
    ? minNoops
    : Math.max(minNoops, Math.min(params.noopCount, maxNoops))

  if (initialNoops > maxNoops) {
    throw new AtomicCreateUnsupportedError(
      `atomic market creation needs at least ${BASE_ATOMIC_CREATE_TXNS + minNoops} transactions, exceeding the ${GROUP_LIMIT}-transaction limit`,
    )
  }

  let lastFailure: AtomicCreateSimulation | undefined
  for (let candidateNoops = initialNoops; candidateNoops <= maxNoops; candidateNoops++) {
    const built = buildAtomicCreateComposer(config, params, suggestedParams, predictedAppId, candidateNoops)
    const simulation = await simulateAtomicCreateGroup(config, built)
    if (!simulation.failureMessage && !simulation.usedUnnamedResources) {
      return built
    }
    lastFailure = simulation
  }

  const detail = lastFailure?.failureMessage ? `: ${lastFailure.failureMessage}` : ''
  throw new AtomicCreateUnsupportedError(
    `atomic market creation could not fit into a single ${GROUP_LIMIT}-transaction group${detail}`,
  )
}

function isRetryableAtomicCreateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('invalid Box reference') ||
    message.includes('application does not exist') ||
    message.includes('unavailable App')
  )
}

/**
 * Build canonical `create_market` ABI args, excluding the funding payment txn.
 */
export function buildCreateMarketMethodArgs(
  params: CreateMarketParams,
  sender: string,
): algosdk.ABIValue[] {
  const mainBlueprintHash = params.mainBlueprintHash ?? params.blueprintHash ?? new Uint8Array(0)
  const disputeBlueprintHash = params.disputeBlueprintHash ?? params.blueprintHash ?? new Uint8Array(0)
  return [
    BigInt(params.currencyAsa),
    params.questionHash,
    BigInt(params.numOutcomes),
    params.initialB,
    BigInt(params.lpFeeBps),
    mainBlueprintHash,
    disputeBlueprintHash,
    BigInt(params.deadline),
    BigInt(params.challengeWindowSecs),
    params.marketAdmin ?? params.creator ?? sender,
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
  if ((params.proposalBond ?? 0n) > 0n) {
    throw new AtomicCreateUnsupportedError(
      'proposalBond is no longer a per-market create parameter; resolution bonds are protocol-configured',
    )
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
 * Legacy sequential factory create helper.
 *
 * This only performs the factory `create_market` call. Callers must still fund,
 * opt into, initialize, store blueprints, and bootstrap the market in separate
 * groups. That is not safe for end-user UX and should only be used in explicit
 * test, migration, or low-level contract scenarios.
 */
export async function createMarketLegacy(
  config: ClientConfig,
  params: CreateMarketParams,
): Promise<number> {
  const resolvedParams = await resolveInitialB(config, params)
  const factoryAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()

  for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
    const sp2 = await config.algodClient.getTransactionParams().do()
    const execAtc = buildFactoryCreateComposer(config, resolvedParams, sp2)

    try {
      const result = await execAtc.execute(config.algodClient, 4)
      const createTxId = result.txIDs[result.txIDs.length - 1]!
      return await readConfirmedCreatedAppId(config.algodClient, createTxId)
    } catch (err: any) {
      if (attempt < MAX_CREATE_RETRIES - 1 && isRetryableAtomicCreateError(err)) {
        await advanceRound(config, factoryAddr)
        continue // App ID drifted, retry
      }
      throw err
    }
  }
  throw new Error('createMarketLegacy failed after retries: app ID drift')
}

/**
 * Disabled sequential create entrypoint.
 *
 * `createMarket()` used to expose the non-atomic factory-only flow. Keeping that
 * behavior under a generic name is too dangerous because callers can interpret
 * it as a complete market-creation helper and accidentally strand funds across
 * later bootstrap steps. Use `createMarketAtomic()` for supported atomic flows,
 * or opt into the sequential helper explicitly via `createMarketLegacy()`.
 */
export async function createMarket(
  _config: ClientConfig,
  _params: CreateMarketParams,
): Promise<number> {
  throw new AtomicCreateUnsupportedError(
    'createMarket() is disabled because it only performs the sequential factory create step. ' +
      'Use createMarketAtomic() for atomic market creation, or createMarketLegacy() only for explicit low-level/test flows.',
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

  const mainBlueprintHash = await sha256(params.mainBlueprint)
  const disputeBlueprintHash = await sha256(params.disputeBlueprint)
  const atomicParams: CreateMarketAtomicParams = {
    ...params,
    initialB: resolvedInitialB.initialB,
    mainBlueprintHash,
    disputeBlueprintHash,
    bootstrapFundingAmount:
      params.bootstrapFundingAmount ??
      (params.bootstrapDeposit + requiredResolutionBudgetFromConfig(protocolConfig, params.challengeWindowSecs)),
  }
  const factoryAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()

  for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
    const suggestedParams = await config.algodClient.getTransactionParams().do()
    const predictedAppId = await simulateCreatedAppId(config, atomicParams, suggestedParams)
    let built: BuiltAtomicGroup
    try {
      built = await planAtomicCreateComposer(config, atomicParams, suggestedParams, predictedAppId)
    } catch (error) {
      if (attempt < MAX_CREATE_RETRIES - 1 && isRetryableAtomicCreateError(error)) {
        await advanceRound(config, factoryAddr)
        continue
      }
      if (error instanceof AtomicCreateUnsupportedError) {
        throw error
      }
      throw new AtomicCreateUnsupportedError(`atomic create simulation failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const result = await built.atc.execute(config.algodClient, 4)
      const marketAppId = Number(built.predictedAppId)
      return {
        marketAppId,
        txId: result.txIDs[result.txIDs.length - 1]!,
      }
    } catch (error) {
      if (attempt < MAX_CREATE_RETRIES - 1 && isRetryableAtomicCreateError(error)) {
        await advanceRound(config, factoryAddr)
        continue
      }
      throw error
    }
  }

  throw new Error('atomic market creation failed after retries: app ID drift')
}
export async function listMarketIds(
  _algod: algosdk.Algodv2,
  _factoryAppId: number | bigint,
): Promise<number[]> {
  return []
}
