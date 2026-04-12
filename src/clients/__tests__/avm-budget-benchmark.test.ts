import { describe, it, expect, beforeAll } from 'vitest'
import algosdk from 'algosdk'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { createMarketAtomic, minimumBootstrapDeposit } from '../market-factory'
import { readConfig, type ProtocolConfig } from '../protocol-config'
import {
  buy,
  cancelDisputeAndMarket,
  challengeResolution,
  claimLpFees,
  enterActiveLpForDeposit,
  finalizeDispute,
  getMarketState,
  proposeResolution,
  recommendedNoopsFor,
  simulateBudgetedCall,
  targetDeltaBForActiveLpDepositFromPrices,
  triggerResolution,
  withdrawLpFees,
  type BudgetSimulationResult,
} from '../question-market'
import { boxNameAddr, marketBoxRefs, pricingBoxRefs, readGlobalState, type ClientConfig } from '../base'
import { MARKET_BOX_USER_FEES_PREFIX } from '../market-schema'
import { getLocalnetAccountAtIndex, getLocalnetAccountByAddress } from './localnet-accounts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEPLOYMENT_PATH = path.resolve(__dirname, '../../../protocol-deployment.json')

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://localhost'
const ALGOD_PORT = 4001

const NUM_OUTCOMES = 3
const BOOTSTRAP_DEPOSIT = minimumBootstrapDeposit(50_000_000n, NUM_OUTCOMES)
const BUY_COST = 25_000_000n
const LP_DEPOSIT = 12_000_000n
const SHARE_UNIT = 1_000_000n
const MIN_GROUP_HEADROOM = 100
const BENCHMARK_CHALLENGE_WINDOW_SECS = 20_000

let algod: algosdk.Algodv2
let deployment: {
  protocolConfigAppId: number
  marketFactoryAppId: number
  usdcAsaId: number
  deployer: string
}
let protocolConfig: ProtocolConfig
let deployer: string
let signer: algosdk.TransactionSigner
let challengerAddr: string
let challengerSigner: algosdk.TransactionSigner
let marketAdminAddr: string
let marketAdminSigner: algosdk.TransactionSigner

interface PreparedMarket {
  appId: number
  deadline: number
  challengeWindowSecs: number
  creatorConfig: ClientConfig
  challengerConfig: ClientConfig
  adminConfig: ClientConfig
}

interface BudgetScenario extends BudgetSimulationResult {
  scenario: string
}

function activeLpBudgetOptions() {
  return {
    budgetAppId: deployment.protocolConfigAppId,
    budgetForeignApps: [deployment.marketFactoryAppId],
  }
}

function makeEvidence(seed: number): Uint8Array {
  const value = new Uint8Array(32)
  value[0] = seed
  return value
}

function decodeAddressStateValue(value: bigint | Uint8Array | undefined): string | undefined {
  if (!(value instanceof Uint8Array) || value.length !== 32) return undefined
  if (value.every((byte) => byte === 0)) return undefined
  return algosdk.encodeAddress(value)
}

async function currentBlockTimestamp(): Promise<bigint> {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: deployer,
    amount: 0,
    suggestedParams: sp,
    note: new TextEncoder().encode(`budget-ts:${Date.now()}:${Math.random()}`),
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  const result = await atc.execute(algod, 4)
  const info = await algod.pendingTransactionInformation(result.txIDs[0]).do()
  const round = Number(info.confirmedRound ?? 0)
  const block = await algod.block(round).do()
  const timestamp = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
  return BigInt(timestamp)
}

async function resetBlockOffsetTimestamp(): Promise<void> {
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
    await currentBlockTimestamp()
  } catch {
    // Localnet-only helper may be unavailable outside test algod.
  }
}

async function advanceTimePast(target: bigint): Promise<void> {
  const ts = await currentBlockTimestamp()
  if (ts < target) {
    let offset = 0
    try {
      const response = await (algod as any).getBlockOffsetTimestamp().do()
      offset = Number((response as any).offset ?? 0)
    } catch {}
    await (algod as any).setBlockOffsetTimestamp(offset + Number(target - ts + 1n)).do()
  }
  if (await currentBlockTimestamp() >= target) {
    try {
      await (algod as any).setBlockOffsetTimestamp(0).do()
    } catch {}
    return
  }
  throw new Error(`Could not advance block time past ${target}`)
}

async function makeAssetTransfer(
  config: ClientConfig,
  receiver: string,
  assetId: number,
  amount: bigint,
): Promise<algosdk.TransactionWithSigner> {
  const suggestedParams = await config.algodClient.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: config.sender,
    receiver,
    assetIndex: assetId,
    amount,
    suggestedParams,
  })
  return { txn, signer: config.signer }
}

async function ensureAlgoFunding(target: string, amount: number): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: target,
    amount,
    suggestedParams,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  await atc.execute(algod, 4)
}

async function ensureUsdcOptIn(address: string, txnSigner: algosdk.TransactionSigner): Promise<void> {
  try {
    await algod.accountAssetInformation(address, deployment.usdcAsaId).do()
  } catch {
    const suggestedParams = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: address,
      receiver: address,
      assetIndex: deployment.usdcAsaId,
      amount: 0n,
      suggestedParams,
    })
    const atc = new algosdk.AtomicTransactionComposer()
    atc.addTransaction({ txn, signer: txnSigner })
    await atc.execute(algod, 4)
  }
}

async function buildAppOptInIfNeeded(
  address: string,
  txnSigner: algosdk.TransactionSigner,
  appId: number,
): Promise<algosdk.TransactionWithSigner | undefined> {
  try {
    await algod.accountApplicationInformation(address, appId).do()
    return undefined
  } catch {
    const suggestedParams = await algod.getTransactionParams().do()
    const txn = algosdk.makeApplicationOptInTxnFromObject({
      sender: address,
      appIndex: appId,
      suggestedParams,
    })
    return { txn, signer: txnSigner }
  }
}

async function fundUsdc(address: string, amount: bigint): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: address,
    assetIndex: deployment.usdcAsaId,
    amount,
    suggestedParams,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  await atc.execute(algod, 4)
}

async function createPreparedMarket(
  label: string,
  challengeWindowSecs = BENCHMARK_CHALLENGE_WINDOW_SECS,
): Promise<PreparedMarket> {
  await resetBlockOffsetTimestamp()
  const resolvedChallengeWindowSecs = Math.max(challengeWindowSecs, protocolConfig.minChallengeWindowSecs)
  // Simulated create_market runs against the chain's current block timestamp, not wall clock.
  // Anchor deadlines to on-chain time so benchmark setup remains valid even when local wall
  // clock is far ahead of a paused/slow localnet.
  // Leave enough slack for atomic create + immediate active-path simulations before we
  // deliberately advance into resolution/dispute states. We control later transitions with
  // setBlockOffsetTimestamp, so a safer initial buffer does not slow the benchmark down.
  const deadline = Number(await currentBlockTimestamp()) + Math.max(resolvedChallengeWindowSecs + 30, 120)

  const factoryConfig: ClientConfig = {
    algodClient: algod,
    appId: deployment.marketFactoryAppId,
    sender: deployer,
    signer,
  }

  const atomicResult = await createMarketAtomic(factoryConfig, {
    creator: deployer,
    currencyAsa: deployment.usdcAsaId,
    questionHash: new TextEncoder().encode(`AVM budget ${label}`),
    numOutcomes: NUM_OUTCOMES,
    // Benchmark the shipped atomic create path and let protocol config materialize b.
    initialB: 0n,
    lpFeeBps: 200,
    mainBlueprint: new TextEncoder().encode(`budget-main-${label}`),
    disputeBlueprint: new TextEncoder().encode(`budget-dispute-${label}`),
    deadline,
    challengeWindowSecs: resolvedChallengeWindowSecs,
    marketAdmin: marketAdminAddr,
    gracePeriodSecs: protocolConfig.minGracePeriodSecs,
    cancellable: true,
    bootstrapDeposit: BOOTSTRAP_DEPOSIT,
    protocolConfigAppId: deployment.protocolConfigAppId,
  })

  const appId = atomicResult.marketAppId
  const creatorConfig: ClientConfig = {
    algodClient: algod,
    appId,
    sender: deployer,
    signer,
  }
  const challengerConfig: ClientConfig = {
    algodClient: algod,
    appId,
    sender: challengerAddr,
    signer: challengerSigner,
  }
  const adminConfig: ClientConfig = {
    algodClient: algod,
    appId,
    sender: marketAdminAddr,
    signer: marketAdminSigner,
  }

  return {
    appId,
    deadline,
    challengeWindowSecs: resolvedChallengeWindowSecs,
    creatorConfig,
    challengerConfig,
    adminConfig,
  }
}

async function measureScenario(
  results: BudgetScenario[],
  scenario: string,
  config: ClientConfig,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  outcomeIndex: number,
  opts?: {
    prependTxns?: algosdk.TransactionWithSigner[]
    boxOverride?: algosdk.BoxReference[]
    foreignAssets?: number[]
    appAccounts?: string[]
    innerTxnCount?: number
  },
): Promise<void> {
  const result = await simulateBudgetedCall(
    config,
    methodName,
    args,
    NUM_OUTCOMES,
    outcomeIndex,
    recommendedNoopsFor(NUM_OUTCOMES),
    opts,
  )

  results.push({ scenario, ...result })
  expect(result.failureMessage, scenario).toBeUndefined()
  expect(result.usedUnnamedResources, scenario).toBe(false)
  expect(result.methodReferenceCount, scenario).toBeLessThanOrEqual(8)
  expect(result.groupAppBudgetConsumed, scenario).toBeGreaterThan(0)
  expect(result.groupAppBudgetHeadroom, scenario).toBeGreaterThanOrEqual(MIN_GROUP_HEADROOM)
}

async function canUseExistingDeployment(algodClient: algosdk.Algodv2): Promise<boolean> {
  if (!fs.existsSync(DEPLOYMENT_PATH)) return false

  try {
    const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'))
    if (
      typeof parsed?.protocolConfigAppId !== 'number' ||
      typeof parsed?.marketFactoryAppId !== 'number' ||
      typeof parsed?.usdcAsaId !== 'number'
    ) {
      return false
    }

    await readConfig(algodClient, parsed.protocolConfigAppId)
    await algodClient.getApplicationByID(parsed.marketFactoryAppId).do()
    await algodClient.getAssetByID(parsed.usdcAsaId).do()
    return true
  } catch {
    return false
  }
}

function deployLocalnetProtocol(): void {
  const sdkRoot = path.resolve(__dirname, '../../..')
  const tsxCli = path.resolve(sdkRoot, 'node_modules/tsx/dist/cli.mjs')
  execFileSync('algokit', ['localnet', 'reset'], {
    cwd: sdkRoot,
    stdio: 'pipe',
  })
  execFileSync(process.execPath, [tsxCli, 'src/scripts/deploy-localnet.ts'], {
    cwd: sdkRoot,
    stdio: 'pipe',
  })
}

describe('AVM budget benchmark: question market', () => {
  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
    await algod.status().do()

    if (!(await canUseExistingDeployment(algod))) {
      deployLocalnetProtocol()
    }

    deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'))
    protocolConfig = await readConfig(algod, deployment.protocolConfigAppId)
    const deployerAccount = await getLocalnetAccountByAddress(algod, deployment.deployer)
    deployer = deployerAccount.addr
    signer = deployerAccount.signer

    const challengerAccount = await getLocalnetAccountAtIndex(algod, 1)
    challengerAddr = challengerAccount.addr
    challengerSigner = challengerAccount.signer

    const adminAccount = await getLocalnetAccountAtIndex(algod, 2)
    marketAdminAddr = adminAccount.addr
    marketAdminSigner = adminAccount.signer

    await ensureAlgoFunding(challengerAddr, 10_000_000)
    await ensureAlgoFunding(marketAdminAddr, 10_000_000)
    await ensureUsdcOptIn(challengerAddr, challengerSigner)
    await ensureUsdcOptIn(marketAdminAddr, marketAdminSigner)
    await fundUsdc(challengerAddr, 100_000_000n)
    await fundUsdc(marketAdminAddr, 50_000_000n)
  }, 180_000)

  it('measures headroom on critical active, resolution, dispute, and cancelled paths', async () => {
    const results: BudgetScenario[] = []

    const mainMarket = await createPreparedMarket('main')
    const mainAppAddr = algosdk.getApplicationAddress(mainMarket.appId).toString()
    const activeQBoxes = marketBoxRefs(mainMarket.appId, NUM_OUTCOMES)

    await measureScenario(
      results,
      'active-buy-3-outcome',
      mainMarket.creatorConfig,
      'buy',
      [1, SHARE_UNIT, BUY_COST, await makeAssetTransfer(mainMarket.creatorConfig, mainAppAddr, deployment.usdcAsaId, BUY_COST)],
      1,
      {
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
        ...activeLpBudgetOptions(),
      },
    )
    await buy(mainMarket.creatorConfig, 1, BUY_COST, NUM_OUTCOMES, deployment.usdcAsaId)

    await measureScenario(
      results,
      'active-sell-3-outcome',
      mainMarket.creatorConfig,
      'sell',
      [1, SHARE_UNIT, 1n],
      1,
      {
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
        ...activeLpBudgetOptions(),
      },
    )

    const activeLpConfig = mainMarket.challengerConfig
    const activeLpState = await getMarketState(algod, mainMarket.appId)
    const targetDeltaB = targetDeltaBForActiveLpDepositFromPrices(LP_DEPOSIT, activeLpState.prices)
    const lpOptInTxn = await buildAppOptInIfNeeded(activeLpConfig.sender, activeLpConfig.signer, mainMarket.appId)

    await measureScenario(
      results,
      'active-enter-lp-3-outcome',
      activeLpConfig,
      'enter_lp_active',
      [
        targetDeltaB,
        LP_DEPOSIT,
        activeLpState.prices,
        1n,
        await makeAssetTransfer(activeLpConfig, mainAppAddr, deployment.usdcAsaId, LP_DEPOSIT),
      ],
      0,
      {
        prependTxns: lpOptInTxn ? [lpOptInTxn] : undefined,
        boxOverride: [
          ...pricingBoxRefs(mainMarket.appId, NUM_OUTCOMES),
          { appIndex: mainMarket.appId, name: boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, activeLpConfig.sender) },
        ],
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
        ...activeLpBudgetOptions(),
      },
    )
    await enterActiveLpForDeposit(activeLpConfig, LP_DEPOSIT, NUM_OUTCOMES, deployment.usdcAsaId, {
      expectedPrices: activeLpState.prices,
    })
    await buy(mainMarket.creatorConfig, 2, BUY_COST, NUM_OUTCOMES, deployment.usdcAsaId)

    await measureScenario(
      results,
      'active-claim-lp-fees-3-outcome',
      activeLpConfig,
      'claim_lp_fees',
      [],
      0,
    )
    await claimLpFees(activeLpConfig)

    await measureScenario(
      results,
      'active-withdraw-lp-fees-3-outcome',
      activeLpConfig,
      'withdraw_lp_fees',
      [1n],
      0,
      {
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
      },
    )
    await withdrawLpFees(activeLpConfig, 1n, deployment.usdcAsaId)

    await advanceTimePast(BigInt(mainMarket.deadline + 1))
    await measureScenario(
      results,
      'active-trigger-resolution-3-outcome',
      mainMarket.creatorConfig,
      'trigger_resolution',
      [],
      0,
      {
        boxOverride: activeQBoxes,
      },
    )
    await triggerResolution(mainMarket.creatorConfig, NUM_OUTCOMES)

    const proposalBond = 0n
    await measureScenario(
      results,
      'pending-propose-resolution-3-outcome',
      mainMarket.creatorConfig,
      'propose_resolution',
      [1, makeEvidence(0x11), await makeAssetTransfer(mainMarket.creatorConfig, mainAppAddr, deployment.usdcAsaId, proposalBond)],
      0,
      {
        boxOverride: activeQBoxes,
      },
    )
    await proposeResolution(mainMarket.creatorConfig, 1, makeEvidence(0x12), NUM_OUTCOMES, deployment.usdcAsaId, proposalBond)
    const proposedMainGs = await readGlobalState(algod, mainMarket.appId)
    const mainProposer = decodeAddressStateValue(proposedMainGs['pr'] as Uint8Array | undefined)

    await advanceTimePast(BigInt(mainMarket.deadline + 1 + mainMarket.challengeWindowSecs))
    await measureScenario(
      results,
      'proposed-finalize-resolution-3-outcome',
      mainMarket.creatorConfig,
      'finalize_resolution',
      [],
      0,
      {
        boxOverride: [
          ...activeQBoxes,
          { appIndex: mainMarket.appId, name: boxNameAddr('pp:', mainProposer!) },
        ],
      },
    )

    const disputedMarket = await createPreparedMarket('disputed')
    const disputedAppAddr = algosdk.getApplicationAddress(disputedMarket.appId).toString()
    const disputedStateBoxes = marketBoxRefs(disputedMarket.appId, NUM_OUTCOMES)

    await buy(disputedMarket.creatorConfig, 1, BUY_COST, NUM_OUTCOMES, deployment.usdcAsaId)
    await advanceTimePast(BigInt(disputedMarket.deadline + 1))
    await triggerResolution(disputedMarket.creatorConfig, NUM_OUTCOMES)
    // After crossing the deadline, localnet keeps applying the offset to later rounds.
    // Reset before dispute-path budget checks so we measure method headroom, not clock drift.
    await resetBlockOffsetTimestamp()

    const disputedMarketProposalBond = 0n
    await proposeResolution(
      disputedMarket.creatorConfig,
      0,
      makeEvidence(0x31),
      NUM_OUTCOMES,
      deployment.usdcAsaId,
      disputedMarketProposalBond,
    )

    const disputedProposedState = await getMarketState(algod, disputedMarket.appId)
    const disputedMarketChallengeBond = disputedProposedState.challengeBond
    await measureScenario(
      results,
      'proposed-challenge-resolution-3-outcome',
      disputedMarket.challengerConfig,
      'challenge_resolution',
      [await makeAssetTransfer(disputedMarket.challengerConfig, disputedAppAddr, deployment.usdcAsaId, disputedMarketChallengeBond), 9, makeEvidence(0x32)],
      0,
      {
        boxOverride: disputedStateBoxes,
      },
    )

    await challengeResolution(
      disputedMarket.challengerConfig,
      9,
      makeEvidence(0x32),
      NUM_OUTCOMES,
      deployment.usdcAsaId,
      disputedMarketChallengeBond,
    )

    const disputedGs = await readGlobalState(algod, disputedMarket.appId)
    const proposer = decodeAddressStateValue(disputedGs['pr'] as Uint8Array | undefined)
    const challenger = decodeAddressStateValue(disputedGs['ch'] as Uint8Array | undefined)

    await measureScenario(
      results,
      'disputed-register-dispute-live-3-outcome',
      disputedMarket.creatorConfig,
      'register_dispute',
      [makeEvidence(0x33), 1, BigInt(disputedMarket.deadline + 45)],
      0,
      {
        boxOverride: disputedStateBoxes,
      },
    )

    await measureScenario(
      results,
      'disputed-creator-resolve-3-outcome',
      disputedMarket.creatorConfig,
      'creator_resolve_dispute',
      [1, makeEvidence(0x34)],
      0,
      {
        boxOverride: [
          ...disputedStateBoxes,
          { appIndex: disputedMarket.appId, name: boxNameAddr('pp:', challenger!) },
        ],
      },
    )

    await measureScenario(
      results,
      'disputed-admin-resolve-3-outcome',
      disputedMarket.adminConfig,
      'admin_resolve_dispute',
      [1, makeEvidence(0x35)],
      0,
      {
        boxOverride: [
          ...disputedStateBoxes,
          { appIndex: disputedMarket.appId, name: boxNameAddr('pp:', challenger!) },
        ],
      },
    )

    await measureScenario(
      results,
      'disputed-finalize-3-outcome',
      disputedMarket.creatorConfig,
      'finalize_dispute',
      [1, makeEvidence(0x36)],
      0,
      {
        boxOverride: [
          ...disputedStateBoxes,
          { appIndex: disputedMarket.appId, name: boxNameAddr('pp:', challenger!) },
        ],
      },
    )

    await measureScenario(
      results,
      'disputed-cancel-3-outcome',
      disputedMarket.creatorConfig,
      'cancel_dispute_and_market',
      [makeEvidence(0x37)],
      0,
      {
        boxOverride: [
          ...disputedStateBoxes,
          { appIndex: disputedMarket.appId, name: boxNameAddr('pp:', challenger!) },
        ],
      },
    )

    await finalizeDispute(disputedMarket.creatorConfig, 1, makeEvidence(0x38), NUM_OUTCOMES)
    await measureScenario(
      results,
      'resolved-claim-3-outcome',
      disputedMarket.creatorConfig,
      'claim',
      [1, SHARE_UNIT],
      1,
      {
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
      },
    )

    const cancelledMarket = await createPreparedMarket('cancelled')
    await buy(cancelledMarket.creatorConfig, 0, BUY_COST, NUM_OUTCOMES, deployment.usdcAsaId)
    await advanceTimePast(BigInt(cancelledMarket.deadline + 1))
    await triggerResolution(cancelledMarket.creatorConfig, NUM_OUTCOMES)
    // Same rationale as the disputed path above: keep the benchmark focused on AVM headroom.
    await resetBlockOffsetTimestamp()

    const cancelledProposalBond = 0n
    await proposeResolution(
      cancelledMarket.creatorConfig,
      1,
      makeEvidence(0x41),
      NUM_OUTCOMES,
      deployment.usdcAsaId,
      cancelledProposalBond,
    )

    const cancelledProposedState = await getMarketState(algod, cancelledMarket.appId)
    const cancelledChallengeBond = cancelledProposedState.challengeBond
    await challengeResolution(
      cancelledMarket.challengerConfig,
      11,
      makeEvidence(0x42),
      NUM_OUTCOMES,
      deployment.usdcAsaId,
      cancelledChallengeBond,
    )
    await cancelDisputeAndMarket(cancelledMarket.creatorConfig, makeEvidence(0x43), NUM_OUTCOMES)

    await measureScenario(
      results,
      'cancelled-refund-3-outcome',
      cancelledMarket.creatorConfig,
      'refund',
      [0, SHARE_UNIT],
      0,
      {
        foreignAssets: [deployment.usdcAsaId],
        innerTxnCount: 1,
      },
    )

    expect(results.length).toBe(16)
    console.info('[avm-budget]', JSON.stringify(results, null, 2))
  }, 240_000)
})
