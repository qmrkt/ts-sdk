import algosdk from 'algosdk'
import {
  boxNameAddr,
  callMethod,
  loadMethods,
  marketBoxRefs,
  pricingBoxRefs,
  readBox,
  type ClientConfig,
} from '../base.js'
import { questionMarketSpec as spec } from '../contract-specs.js'
import {
  MARKET_BOX_USER_FEES_PREFIX,
  MARKET_LOCAL_FEE_SNAPSHOT,
  MARKET_LOCAL_LP_SHARES,
  MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM,
  MARKET_LOCAL_RESIDUAL_CLAIMED,
  MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS,
} from '../market-schema.js'
import {
  AtomicGroupUnsupportedError,
  assertActiveLpSkewWithinCap,
  buildAppOptInIfNeeded,
  buildAsaOptInIfNeeded,
  callWithBudget,
  getMarketState,
  getProtocolBudgetForeignApps,
  getProtocolConfigAppId,
  makeAssetTransfer,
  noopsFor,
  readAccountLocalState,
  targetDeltaBForActiveLpDepositFromPrices,
  type CollectLpFeesResult,
  type EnterActiveLpResult,
  type LpAccountState,
} from './internal.js'

const methods = loadMethods(spec)
const ACTIVE_LP_DELTA_RETRY_LIMIT = 8

function shouldRetryActiveLpDelta(error: unknown): boolean {
  if (error instanceof AtomicGroupUnsupportedError) return true
  return /max_deposit|assert failed/i.test(String((error as Error | undefined)?.message ?? error ?? ''))
}

function reduceActiveLpTargetDeltaB(targetDeltaB: bigint): bigint {
  const reduction = targetDeltaB / 20n
  return targetDeltaB - (reduction > 0n ? reduction : 1n)
}

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

  let candidateDeltaB = targetDeltaB
  let lastError: unknown

  for (let attempt = 0; attempt < ACTIVE_LP_DELTA_RETRY_LIMIT && candidateDeltaB > 0n; attempt += 1) {
    try {
      return await enterActiveLp(
        config,
        candidateDeltaB,
        maxDeposit,
        numOutcomes,
        currencyAsaId,
        {
          expectedPrices,
          priceTolerance: options?.priceTolerance,
        },
      )
    } catch (error) {
      lastError = error
      if (!shouldRetryActiveLpDelta(error) || candidateDeltaB <= 1n) {
        throw error
      }
      const nextDeltaB = reduceActiveLpTargetDeltaB(candidateDeltaB)
      if (nextDeltaB >= candidateDeltaB) {
        throw error
      }
      candidateDeltaB = nextDeltaB
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Active LP entry failed after exhausting target delta retries.')
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
  const budgetAppId = numOutcomes >= 2
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
