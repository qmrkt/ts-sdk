import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import algosdk from 'algosdk'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { createMarketAtomic, type CreateMarketAtomicParams } from '../market-factory'
import {
  buy,
  cancel,
  claimLpResidual,
  challengeResolution,
  claim,
  finalizeDispute,
  finalizeResolution,
  getMarketState,
  proposeResolution,
  provideLiquidity,
  refund,
  sell,
  triggerResolution,
  withdrawPendingPayouts,
} from '../question-market'
import { boxNameAddr, boxNameAddrIdx, readBox, type ClientConfig } from '../base'
import { MARKET_BOX_USER_SHARES_PREFIX } from '../market-schema'
import { getLocalnetAccountByAddress, loadLocalnetWalletAccounts } from './localnet-accounts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEPLOYMENT_PATH = path.resolve(__dirname, '../../../protocol-deployment.json')
const TSX_CLI = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs')

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://localhost'
const ALGOD_PORT = 4001

const STARTING_USDC = 100_000_000n
const BOOTSTRAP_DEPOSIT = 50_000_000n
const BUY_MAX_COST = 10_000_000n
const TEST_DEADLINE_BUFFER = 365n * 86_400n

let algod: algosdk.Algodv2
let deployer: string
let signer: algosdk.TransactionSigner
let deployment: {
  protocolConfigAppId: number
  marketFactoryAppId: number
  usdcAsaId: number
  deployer: string
}

async function currentBlockTimestamp(): Promise<bigint> {
  const status = await algod.status().do()
  const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
  const block = await algod.block(round).do()
  const timestamp = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
  return BigInt(timestamp)
}

async function mineTick(): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: deployer,
    amount: 0,
    suggestedParams,
    note: new TextEncoder().encode(`atomicity-tick:${Date.now()}:${Math.random()}`),
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  await atc.execute(algod, 4)
}

async function resetBlockOffsetTimestamp(): Promise<void> {
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
    await mineTick()
  } catch {
    // Older algods may not expose the localnet-only block offset API.
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
  await mineTick()
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
  } catch {}
  if (await currentBlockTimestamp() >= target) {
    return
  }
  throw new Error(`Could not advance block time past ${target}`)
}

async function fundAlgo(receiver: string, amount: number): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver,
    amount,
    suggestedParams,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  await atc.execute(algod, 4)
}

async function ensureAsaOptIn(
  address: string,
  txnSigner: algosdk.TransactionSigner,
  assetId: number,
): Promise<void> {
  try {
    await algod.accountAssetInformation(address, assetId).do()
  } catch {
    const suggestedParams = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: address,
      receiver: address,
      assetIndex: assetId,
      amount: 0n,
      suggestedParams,
    })
    const atc = new algosdk.AtomicTransactionComposer()
    atc.addTransaction({ txn, signer: txnSigner })
    await atc.execute(algod, 4)
  }
}

async function sendAsset(
  sender: string,
  txnSigner: algosdk.TransactionSigner,
  receiver: string,
  assetId: number,
  amount: bigint,
): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    assetIndex: assetId,
    amount,
    suggestedParams,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: txnSigner })
  await atc.execute(algod, 4)
}

async function getAssetBalance(address: string, assetId: number): Promise<bigint> {
  const info = await algod.accountAssetInformation(address, assetId).do()
  return BigInt((info as any).assetHolding?.amount ?? (info as any)['asset-holding']?.amount ?? 0)
}

async function getUserOutcomeShares(
  appId: number,
  address: string,
  outcomeIndex: number,
): Promise<bigint> {
  try {
    const value = await readBox(algod, appId, boxNameAddrIdx(MARKET_BOX_USER_SHARES_PREFIX, address, outcomeIndex))
    return algosdk.decodeUint64(value, 'bigint')
  } catch {
    return 0n
  }
}

async function getPendingPayoutAmount(
  appId: number,
  address: string,
): Promise<bigint> {
  try {
    const value = await readBox(algod, appId, boxNameAddr('pp:', address))
    return algosdk.decodeUint64(value, 'bigint')
  } catch {
    return 0n
  }
}

async function hasAssetHolding(address: string, assetId: number): Promise<boolean> {
  try {
    await algod.accountAssetInformation(address, assetId).do()
    return true
  } catch {
    return false
  }
}

async function closeAsaHolding(
  address: string,
  txnSigner: algosdk.TransactionSigner,
  assetId: number,
  closeTo: string,
): Promise<void> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: closeTo,
    closeRemainderTo: closeTo,
    assetIndex: assetId,
    amount: 0n,
    suggestedParams,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: txnSigner })
  await atc.execute(algod, 4)
}

async function createFundedUser(
  index: number,
  usdcAmount: bigint = STARTING_USDC,
): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
  const accounts = await loadLocalnetWalletAccounts(algod, index + 2)
  const account = accounts
    .slice(index)
    .find((candidate) => candidate.addr !== deployer)
    ?? accounts.find((candidate) => candidate.addr !== deployer)

  if (!account) {
    throw new Error('No non-deployer localnet account available for atomicity test')
  }

  const user = { addr: account.addr, signer: account.signer }
  await fundAlgo(user.addr, 10_000_000)
  await ensureAsaOptIn(user.addr, user.signer, deployment.usdcAsaId)
  if (usdcAmount > 0n) {
    await sendAsset(deployer, signer, user.addr, deployment.usdcAsaId, usdcAmount)
  }
  return user
}

async function createBootstrappedBinaryMarket(
  label: string,
  opts?: {
    cancellable?: boolean
    shortDeadline?: boolean
    deadlineBufferSecs?: bigint
    owner?: { addr: string; signer: algosdk.TransactionSigner }
  },
): Promise<{
  appId: number
  deadline: number
  challengeWindowSecs: number
  marketConfig: ClientConfig
}> {
  const shortDeadline = opts?.shortDeadline ?? false
  const owner = opts?.owner ?? { addr: deployer, signer }
  // Keep the dispute window short enough for fast localnet tests, but not so
  // tight that localnet block timestamp jumps can race the challenge window.
  const challengeWindowSecs = shortDeadline ? 600 : 3600
  const deadlineBufferSecs = opts?.deadlineBufferSecs ?? TEST_DEADLINE_BUFFER
  await mineTick()
  const latestBlockTimestamp = await currentBlockTimestamp()
  const deadline = Number(latestBlockTimestamp + deadlineBufferSecs)

  const factoryConfig: ClientConfig = {
    algodClient: algod,
    appId: deployment.marketFactoryAppId,
    sender: owner.addr,
    signer: owner.signer,
  }

  const params: CreateMarketAtomicParams = {
    creator: owner.addr,
    currencyAsa: deployment.usdcAsaId,
    questionHash: new TextEncoder().encode(`Atomicity ${label}`),
    numOutcomes: 2,
    initialB: 0n,
    lpFeeBps: 200,
    blueprintCid: new TextEncoder().encode("QmTestBlueprintCid"),
    deadline,
    challengeWindowSecs,
    cancellable: opts?.cancellable ?? true,
    bootstrapDeposit: BOOTSTRAP_DEPOSIT,
    protocolConfigAppId: deployment.protocolConfigAppId,
  }

  const result = await createMarketAtomic(factoryConfig, params)
  const appId = result.marketAppId
  const marketConfig: ClientConfig = {
    algodClient: algod,
    appId,
    sender: owner.addr,
    signer: owner.signer,
  }

  return {
    appId,
    deadline,
    challengeWindowSecs,
    marketConfig,
  }
}

describe('E2E: Atomic flow regressions on localnet', () => {
  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)

    try {
      await algod.status().do()
    } catch {
      throw new Error('Localnet not running. Start with: algokit localnet start')
    }

    const { execFileSync } = await import('child_process')
    execFileSync('algokit', ['localnet', 'reset'], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: 'pipe',
    })
    execFileSync(process.execPath, [TSX_CLI, 'src/scripts/deploy-localnet.ts'], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: 'pipe',
    })

    deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'))
    const deployerAccount = await getLocalnetAccountByAddress(algod, deployment.deployer)
    deployer = deployerAccount.addr
    signer = deployerAccount.signer
  }, 120_000)

  beforeEach(async () => {
    if (!algod || !deployer) return
    await resetBlockOffsetTimestamp()
  })

  it('groups first buy without prior position setup', async () => {
    const market = await createBootstrappedBinaryMarket('first-buy')
    const trader = await createFundedUser(3)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    expect(await getUserOutcomeShares(market.appId, trader.addr, 0)).toBe(0n)

    await buy(traderConfig, 0, BUY_MAX_COST, 2, deployment.usdcAsaId)

    expect(await getUserOutcomeShares(market.appId, trader.addr, 0)).toBeGreaterThan(0n)
  })

  it('supports multi-share buy and sell results in a single call', async () => {
    const market = await createBootstrappedBinaryMarket('multi-share-trade')
    const trader = await createFundedUser(13)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    const buyResult = await buy(traderConfig, 0, 30_000_000n, 2, deployment.usdcAsaId, 3_000_000n)
    expect(buyResult.shares).toBe(3_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)
    expect(await getUserOutcomeShares(market.appId, trader.addr, 0)).toBe(3_000_000n)

    const sellResult = await sell(traderConfig, 0, 1n, 2, null, deployment.usdcAsaId, 2_000_000n)
    expect(sellResult.shares).toBe(2_000_000n)
    expect(sellResult.netReturn).toBeGreaterThan(0n)
    expect(await getUserOutcomeShares(market.appId, trader.addr, 0)).toBe(1_000_000n)
  })

  it('groups USDC opt-in inside sell after the seller closes their holding', async () => {
    const market = await createBootstrappedBinaryMarket('sell-opt-in')
    const trader = await createFundedUser(4)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    await buy(traderConfig, 0, BUY_MAX_COST, 2, deployment.usdcAsaId)
    await closeAsaHolding(trader.addr, trader.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(false)

    await sell(traderConfig, 0, 1n, 2, null, deployment.usdcAsaId)

    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(true)
    expect(await getAssetBalance(trader.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
  })

  it('groups first LP app opt-in and later USDC opt-in for residual claims', async () => {
    const market = await createBootstrappedBinaryMarket('lp-flow')
    const lp = await createFundedUser(5)
    const lpConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: lp.addr,
      signer: lp.signer,
    }

    await expect(algod.accountApplicationInformation(lp.addr, market.appId).do()).rejects.toBeTruthy()

    await provideLiquidity(lpConfig, 10_000_000n, 2, deployment.usdcAsaId)
    await algod.accountApplicationInformation(lp.addr, market.appId).do()

    await closeAsaHolding(lp.addr, lp.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(lp.addr, deployment.usdcAsaId)).toBe(false)

    await cancel(market.marketConfig, 2)
    await claimLpResidual(lpConfig, deployment.usdcAsaId)

    expect(await hasAssetHolding(lp.addr, deployment.usdcAsaId)).toBe(true)
    expect(await getAssetBalance(lp.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
  })

  it('groups USDC opt-in inside claim after the winner closes their holding', async () => {
    const market = await createBootstrappedBinaryMarket('claim-flow', { cancellable: false, shortDeadline: true })
    const trader = await createFundedUser(6)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    await buy(traderConfig, 0, BUY_MAX_COST, 2, deployment.usdcAsaId)
    await closeAsaHolding(trader.addr, trader.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(false)

    await advanceTimePast(BigInt(market.deadline + 1))
    await triggerResolution(market.marketConfig, 2)
    const resolutionPendingState = await getMarketState(algod, market.appId)
    if (resolutionPendingState.gracePeriodSecs > 0) {
      await advanceTimePast(BigInt(market.deadline + resolutionPendingState.gracePeriodSecs + 1))
    }

    const evidenceHash = new Uint8Array(32)
    evidenceHash[0] = 0x11
    await proposeResolution(market.marketConfig, 0, evidenceHash, 2, deployment.usdcAsaId)

    const proposalTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalTs + market.challengeWindowSecs + 1))
    await finalizeResolution(market.marketConfig, 2)

    await claim(traderConfig, 0, 2, deployment.usdcAsaId)

    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(true)
    expect(await getAssetBalance(trader.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
  })

  it('supports multi-share refund results in single calls', async () => {
    const refundMarket = await createBootstrappedBinaryMarket('multi-share-refund', { cancellable: true })
    const trader = await createFundedUser(15)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: refundMarket.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    await buy(traderConfig, 0, 30_000_000n, 2, deployment.usdcAsaId, 3_000_000n)
    await cancel(refundMarket.marketConfig, 2)

    const refundResult = await refund(traderConfig, 0, 2, deployment.usdcAsaId, 2_000_000n)
    expect(refundResult.shares).toBe(2_000_000n)
    expect(refundResult.refundAmount).toBeGreaterThan(0n)

    const finalRefundResult = await refund(traderConfig, 0, 2, deployment.usdcAsaId, 1_000_000n)
    expect(finalRefundResult.shares).toBe(1_000_000n)
    expect(finalRefundResult.refundAmount).toBeGreaterThan(0n)
  })

  it('supports multi-share claim results in single calls', async () => {
    const claimMarket = await createBootstrappedBinaryMarket('multi-share-claim', { cancellable: false, shortDeadline: true })
    const winner = await createFundedUser(14)
    const winnerConfig: ClientConfig = {
      algodClient: algod,
      appId: claimMarket.appId,
      sender: winner.addr,
      signer: winner.signer,
    }

    await buy(winnerConfig, 0, 30_000_000n, 2, deployment.usdcAsaId, 3_000_000n)
    await advanceTimePast(BigInt(claimMarket.deadline + 1))
    await triggerResolution(claimMarket.marketConfig, 2)
    const resolutionPendingState = await getMarketState(algod, claimMarket.appId)
    if (resolutionPendingState.gracePeriodSecs > 0) {
      await advanceTimePast(BigInt(claimMarket.deadline + resolutionPendingState.gracePeriodSecs + 1))
    }

    const evidenceHash = new Uint8Array(32)
    evidenceHash[0] = 0x22
    await proposeResolution(claimMarket.marketConfig, 0, evidenceHash, 2, deployment.usdcAsaId)

    const proposalTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalTs + claimMarket.challengeWindowSecs + 1))
    await finalizeResolution(claimMarket.marketConfig, 2)

    const claimResult = await claim(winnerConfig, 0, 2, deployment.usdcAsaId, 2_000_000n)
    expect(claimResult.shares).toBe(2_000_000n)
    expect(claimResult.payout).toBeGreaterThan(0n)

    const finalClaimResult = await claim(winnerConfig, 0, 2, deployment.usdcAsaId, 1_000_000n)
    expect(finalClaimResult.shares).toBe(1_000_000n)
    expect(finalClaimResult.payout).toBeGreaterThan(0n)
  })

  it('groups USDC opt-in inside refund after the holder closes their holding', async () => {
    const market = await createBootstrappedBinaryMarket('refund-flow', { cancellable: true })
    const trader = await createFundedUser(7)
    const traderConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: trader.addr,
      signer: trader.signer,
    }

    await buy(traderConfig, 0, BUY_MAX_COST, 2, deployment.usdcAsaId)
    await closeAsaHolding(trader.addr, trader.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(false)

    await cancel(market.marketConfig, 2)
    await refund(traderConfig, 0, 2, deployment.usdcAsaId)

    expect(await hasAssetHolding(trader.addr, deployment.usdcAsaId)).toBe(true)
    expect(await getAssetBalance(trader.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
  })

  it('finalize_resolution stays live without proposer USDC opt-in', async () => {
    const proposer = await createFundedUser(9)
    const market = await createBootstrappedBinaryMarket('resolution-payout', {
      cancellable: false,
      shortDeadline: true,
      owner: proposer,
    })
    const proposerConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: proposer.addr,
      signer: proposer.signer,
    }

    await advanceTimePast(BigInt(market.deadline + 1))
    await triggerResolution(market.marketConfig, 2)
    const resolutionPendingState = await getMarketState(algod, market.appId)
    if (resolutionPendingState.gracePeriodSecs > 0) {
      await advanceTimePast(BigInt(market.deadline + resolutionPendingState.gracePeriodSecs + 1))
    }

    const evidenceHash = new Uint8Array(32)
    evidenceHash[0] = 0x22
    await proposeResolution(proposerConfig, 0, evidenceHash, 2, deployment.usdcAsaId)

    await closeAsaHolding(proposer.addr, proposer.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(proposer.addr, deployment.usdcAsaId)).toBe(false)

    const proposalTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalTs + market.challengeWindowSecs + 1))
    await finalizeResolution(market.marketConfig, 2)
    expect(await hasAssetHolding(proposer.addr, deployment.usdcAsaId)).toBe(false)
    const pendingPayout = await getPendingPayoutAmount(market.appId, proposer.addr)
    if (pendingPayout > 0n) {
      await withdrawPendingPayouts(proposerConfig, deployment.usdcAsaId)
      expect(await hasAssetHolding(proposer.addr, deployment.usdcAsaId)).toBe(true)
      expect(await getAssetBalance(proposer.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
    }
  })

  it('finalize_dispute stays live without challenger USDC opt-in and withdrawPendingPayouts re-opens it', async () => {
    const market = await createBootstrappedBinaryMarket('dispute-payout', {
      cancellable: false,
      shortDeadline: true,
      deadlineBufferSecs: 300n,
    })
    const challenger = await createFundedUser(8)
    const challengerConfig: ClientConfig = {
      algodClient: algod,
      appId: market.appId,
      sender: challenger.addr,
      signer: challenger.signer,
    }

    await buy(market.marketConfig, 0, BUY_MAX_COST, 2, deployment.usdcAsaId)
    await advanceTimePast(BigInt(market.deadline + 1))
    await triggerResolution(market.marketConfig, 2)

    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0x33
    await proposeResolution(market.marketConfig, 0, proposalEvidenceHash, 2, deployment.usdcAsaId)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0x44
    await challengeResolution(challengerConfig, 2, challengeEvidenceHash, 2, deployment.usdcAsaId)

    await closeAsaHolding(challenger.addr, challenger.signer, deployment.usdcAsaId, deployer)
    expect(await hasAssetHolding(challenger.addr, deployment.usdcAsaId)).toBe(false)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0x55
    await finalizeDispute(market.marketConfig, 1, rulingHash, 2)
    expect(await hasAssetHolding(challenger.addr, deployment.usdcAsaId)).toBe(false)

    await withdrawPendingPayouts(challengerConfig, deployment.usdcAsaId)

    expect(await hasAssetHolding(challenger.addr, deployment.usdcAsaId)).toBe(true)
    expect(await getAssetBalance(challenger.addr, deployment.usdcAsaId)).toBeGreaterThan(0n)
  })
}, { timeout: 240_000 })
