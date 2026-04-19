/**
 * Adversarial stress test suite for question.market
 *
 * Tests edge cases, boundary conditions, concurrent operations, and
 * attack vectors that could break the protocol in production.
 *
 * Run: cd sdk && pnpm exec vitest run src/clients/__tests__/stress-test.ts
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import algosdk from 'algosdk'
import { createHash } from 'crypto'

import { createMarketAtomic, type CreateMarketAtomicParams } from '../market-factory'
import {
  buy, sell, getMarketState,
  triggerResolution, proposeResolution, finalizeResolution, claim,
  provideLiquidity, withdrawLiquidity, cancel, refund,
} from '../question-market'
import type { ClientConfig } from '../base'
import { getFundedLocalnetAccount, getLocalnetAccountByAddress, loadLocalnetWalletAccounts } from './localnet-accounts'
import { deployLocalnetProtocol } from './localnet-deployment'

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://127.0.0.1'
const ALGOD_PORT = 4001

type Account = { addr: string; signer: algosdk.TransactionSigner }
type Deployment = { protocolConfigAppId: number; marketFactoryAppId: number; usdcAsaId: number; deployer: string }

let algod: algosdk.Algodv2
let deployment: Deployment
let accounts: Account[] // [deployer, trader1, trader2]

// ── Helpers ──

async function getAccounts(count: number): Promise<Account[]> {
  const walletAccounts = await loadLocalnetWalletAccounts(algod, count + 2)
  const deployerAccount = deployment?.deployer
    ? await getLocalnetAccountByAddress(algod, deployment.deployer)
    : await getFundedLocalnetAccount(algod)
  const others = walletAccounts.filter((account) => account.addr !== deployerAccount.addr)
  return [
    { addr: deployerAccount.addr, signer: deployerAccount.signer },
    ...others.slice(0, Math.max(0, count - 1)).map((account) => ({ addr: account.addr, signer: account.signer })),
  ]
}

async function currentBlockTs(): Promise<bigint> {
  const status = await algod.status().do()
  const block = await algod.block(Number(status.lastRound)).do()
  return BigInt(block.block.header.timestamp)
}

async function mineTick(account: Account) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0,
    suggestedParams: sp,
    note: new TextEncoder().encode(`advance:${Date.now()}`),
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: account.signer })
  await atc.execute(algod, 4)
}

async function resetBlockOffsetTimestamp(account: Account) {
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
    await mineTick(account)
  } catch {
    // Localnet-only helper may be unavailable outside test algod.
  }
}

async function advanceTimePast(target: bigint, account: Account) {
  const ts = await currentBlockTs()
  if (ts < target) {
    let offset = 0
    try {
      const response = await (algod as any).getBlockOffsetTimestamp().do()
      offset = Number((response as any).offset ?? 0)
    } catch {}
    await (algod as any).setBlockOffsetTimestamp(offset + Number(target - ts + 1n)).do()
  }
  await mineTick(account)
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
  } catch {}
  if ((await currentBlockTs()) >= target) return
  throw new Error(`Could not advance block time past ${target}`)
}

async function fundUsdc(to: Account, amount: bigint) {
  const deployer = accounts[0]
  try { await algod.accountAssetInformation(to.addr, deployment.usdcAsaId).do() } catch {
    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: to.addr, receiver: to.addr, assetIndex: deployment.usdcAsaId, amount: 0n, suggestedParams: sp,
    })
    const atc = new algosdk.AtomicTransactionComposer()
    atc.addTransaction({ txn, signer: to.signer })
    await atc.execute(algod, 4)
  }
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: to.addr, assetIndex: deployment.usdcAsaId, amount, suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: deployer.signer })
  await atc.execute(algod, 4)
}

async function fundAlgo(to: Account, amount: bigint) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: accounts[0].addr, receiver: to.addr, amount, suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: accounts[0].signer })
  await atc.execute(algod, 4)
}

async function optInApp(account: Account, appId: number) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makeApplicationOptInTxnFromObject({
    sender: account.addr, appIndex: appId, suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: account.signer })
  await atc.execute(algod, 4)
}

/** Create a market with the full bootstrap flow, ready for trading */
async function createAndBootstrapMarket(opts: {
  creator: Account
  numOutcomes?: number
  liquidityUsdc?: bigint
  deadlineOffsetSecs?: number
  challengeWindowSecs?: number
  cancellable?: boolean
}): Promise<{ appId: number; deadline: number }> {
  const {
    creator, numOutcomes = 2, liquidityUsdc = 50_000_000n,
    deadlineOffsetSecs = 120, challengeWindowSecs = 10, cancellable = true,
  } = opts

  const blockTs = await currentBlockTs()
  const deadline = Number(blockTs) + Math.max(deadlineOffsetSecs, challengeWindowSecs + 30, 120)

  const config: ClientConfig = {
    algodClient: algod, appId: deployment.marketFactoryAppId,
    sender: creator.addr, signer: creator.signer,
  }

  const result = await createMarketAtomic(config, {
    creator: creator.addr,
    currencyAsa: deployment.usdcAsaId,
    questionHash: new TextEncoder().encode(`Stress test ${Date.now()}`),
    numOutcomes,
    initialB: 0n,
    lpFeeBps: 200,
    blueprintCid: new TextEncoder().encode("QmTestCid"),
    deadline,
    challengeWindowSecs,
    cancellable,
    bootstrapDeposit: liquidityUsdc,
    protocolConfigAppId: deployment.protocolConfigAppId,
  })

  return { appId: result.marketAppId, deadline }
}

function marketConfig(account: Account, appId: number): ClientConfig {
  return { algodClient: algod, appId, sender: account.addr, signer: account.signer }
}

async function prepareTrader(trader: Account, appId: number, usdcAmount = 100_000_000n) {
  await fundAlgo(accounts[0], 10_000_000n) // ensure deployer has ALGO
  await fundAlgo(trader, 10_000_000n)
  await fundUsdc(trader, usdcAmount)
  await optInApp(trader, appId).catch(() => {})
}

// ── Test Suite ──

describe.sequential('Stress: adversarial & edge cases', () => {
  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
    await algod.status().do()

    // Deploy fresh stack so stress tests are isolated
    deployment = deployLocalnetProtocol({ reset: true })
    accounts = await getAccounts(3)

    // Fund deployer with plenty of USDC
    await fundUsdc(accounts[0], 0n).catch(() => {})
  }, 120_000)

  beforeEach(async () => {
    if (!algod || accounts.length === 0) return
    await resetBlockOffsetTimestamp(accounts[0])
  })

  // ── 1. Boundary amounts ──

  it('rejects buy with 0 max_cost', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })
    await expect(
      buy(marketConfig(deployer, appId), 0, 0n, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 120_000)

  it('rejects buy with max_cost = 1 (below minimum cost)', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })
    // 1 microUSDC is below the LMSR cost for 1M shares
    await expect(
      buy(marketConfig(deployer, appId), 0, 1n, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 120_000)

  it('rejects buy on invalid outcome index', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })
    // Outcome 5 doesn't exist on a 2-outcome market
    await expect(
      buy(marketConfig(deployer, appId), 5, 10_000_000n, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 120_000)

  // ── 2. Temporal attacks ──

  it('rejects buy after deadline', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId, deadline } = await createAndBootstrapMarket({
      creator: deployer, deadlineOffsetSecs: 45,
    })
    // Advance past deadline
    await advanceTimePast(BigInt(deadline + 1), deployer)
    await expect(
      buy(marketConfig(deployer, appId), 0, 10_000_000n, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 180_000)

  it('rejects finalize before challenge window expires', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId, deadline } = await createAndBootstrapMarket({
      creator: deployer, deadlineOffsetSecs: 45, challengeWindowSecs: 3_600,
    })
    await advanceTimePast(BigInt(deadline + 1), deployer)
    await triggerResolution(marketConfig(deployer, appId), 2)
    const evidence = new Uint8Array(createHash('sha256').update('test').digest())
    await proposeResolution(marketConfig(deployer, appId), 0, evidence, 2)
    // Try to finalize immediately (challenge window hasn't passed)
    await expect(
      finalizeResolution(marketConfig(deployer, appId), 2)
    ).rejects.toThrow()
  }, 180_000)

  // ── 3. Double-spend / replay ──

  it('cannot claim twice on the same outcome', async () => {
    const deployer = accounts[0]
    const trader = accounts[1]
    await fundUsdc(deployer, 200_000_000n)
    const { appId, deadline } = await createAndBootstrapMarket({ creator: deployer })
    await prepareTrader(trader, appId)

    // Buy outcome 0
    await buy(marketConfig(trader, appId), 0, 5_000_000n, 2, deployment.usdcAsaId)

    // Resolve to outcome 0
    await advanceTimePast(BigInt(deadline + 1), deployer)
    await triggerResolution(marketConfig(deployer, appId), 2)
    const evidence = new Uint8Array(createHash('sha256').update('test').digest())
    await proposeResolution(marketConfig(deployer, appId), 0, evidence, 2)
    const proposedTs = await currentBlockTs()
    await advanceTimePast(proposedTs + 12n, deployer)
    await finalizeResolution(marketConfig(deployer, appId), 2)

    // First claim should succeed
    await claim(marketConfig(trader, appId), 0, 2, deployment.usdcAsaId)

    // Second claim should fail (no shares left)
    await expect(
      claim(marketConfig(trader, appId), 0, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 240_000)

  // ── 4. Sell without shares ──

  it('rejects sell when user has no shares', async () => {
    const deployer = accounts[0]
    const trader = accounts[1]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })
    await prepareTrader(trader, appId)

    // Try to sell without buying first
    await expect(
      sell(marketConfig(trader, appId), 0, 0n, 2, null, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 120_000)

  // ── 5. Multiple concurrent buyers ──

  it('handles rapid sequential buys from different wallets', async () => {
    const deployer = accounts[0]
    const trader1 = accounts[1]
    const trader2 = accounts[2]
    await fundUsdc(deployer, 500_000_000n)
    const { appId } = await createAndBootstrapMarket({
      creator: deployer, liquidityUsdc: 100_000_000n,
    })
    await prepareTrader(trader1, appId)
    await prepareTrader(trader2, appId, 200_000_000n)

    // Rapid buys: each wallet buys 3 times
    let trader1TotalCost = 0n
    let trader2TotalCost = 0n
    for (let i = 0; i < 3; i++) {
      const trader1Buy = await buy(marketConfig(trader1, appId), 0, 10_000_000n, 2, deployment.usdcAsaId)
      const trader2Buy = await buy(marketConfig(trader2, appId), 1, 10_000_000n, 2, deployment.usdcAsaId)
      trader1TotalCost += trader1Buy.totalCost
      trader2TotalCost += trader2Buy.totalCost
    }

    const state = await getMarketState(algod, appId)
    expect(trader1TotalCost).toBeGreaterThan(0n)
    expect(trader2TotalCost).toBeGreaterThan(0n)
    // Pool should have grown
    expect(state.poolBalance).toBeGreaterThan(100_000_000n)
    // Symmetric demand should keep a binary market near even odds.
    const midpoint = 500_000n
    const priceTolerance = 5_000n
    expect((state.prices[0] > midpoint ? state.prices[0] - midpoint : midpoint - state.prices[0])).toBeLessThanOrEqual(priceTolerance)
    expect((state.prices[1] > midpoint ? state.prices[1] - midpoint : midpoint - state.prices[1])).toBeLessThanOrEqual(priceTolerance)
  }, 240_000)

  // ── 6. Buy + sell round trip (slippage check) ──

  it('buy then sell returns less than cost (LMSR spread)', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })

    const balanceBefore = await getUsdcBalance(deployer.addr)

    await buy(marketConfig(deployer, appId), 0, 5_000_000n, 2, deployment.usdcAsaId)
    await sell(marketConfig(deployer, appId), 0, 0n, 2, null, deployment.usdcAsaId)

    const balanceAfter = await getUsdcBalance(deployer.addr)
    // Should have lost money due to fees
    expect(balanceAfter).toBeLessThan(balanceBefore)
  }, 120_000)

  // ── 7. LP operations ──

  it('allows active LP entry but rejects active LP withdrawal', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })

    const stateBefore = await getMarketState(algod, appId)
    const poolBefore = stateBefore.poolBalance

    // Provide 20 USDC
    await provideLiquidity(marketConfig(deployer, appId), 20_000_000n, 2, deployment.usdcAsaId)
    const stateAfter = await getMarketState(algod, appId)
    expect(stateAfter.poolBalance).toBeGreaterThan(poolBefore)
    expect(stateAfter.lpSharesTotal).toBeGreaterThan(stateBefore.lpSharesTotal)

    // Active LP withdrawals are intentionally disabled in the current market line.
    const sharesToBurn = stateAfter.lpSharesTotal / 2n
    await expect(
      withdrawLiquidity(marketConfig(deployer, appId), sharesToBurn, 2, deployment.usdcAsaId),
    ).rejects.toThrow('Active LP withdrawals are disabled')
  }, 120_000)

  // ── 8. Resolution on wrong status ──

  it('rejects trigger_resolution on active market before deadline', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })

    // Market is active, deadline hasn't passed
    await expect(
      triggerResolution(marketConfig(deployer, appId), 2)
    ).rejects.toThrow()
  }, 120_000)

  it('rejects propose_resolution before trigger', async () => {
    const deployer = accounts[0]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({ creator: deployer })

    const evidence = new Uint8Array(createHash('sha256').update('test').digest())
    // Can't propose on an ACTIVE market
    await expect(
      proposeResolution(marketConfig(deployer, appId), 0, evidence, 2)
    ).rejects.toThrow()
  }, 120_000)

  // ── 9. Cancellation ──

  it('cancel market and refund all participants', async () => {
    const deployer = accounts[0]
    const trader = accounts[1]
    await fundUsdc(deployer, 200_000_000n)
    const { appId } = await createAndBootstrapMarket({
      creator: deployer, cancellable: true,
    })
    await prepareTrader(trader, appId)

    // Trader buys
    await buy(marketConfig(trader, appId), 0, 5_000_000n, 2, deployment.usdcAsaId)
    const traderBalanceBefore = await getUsdcBalance(trader.addr)

    // Creator cancels
    await cancel(marketConfig(deployer, appId))
    const state = await getMarketState(algod, appId)
    expect(state.status).toBe(4) // CANCELLED

    // Trader refunds
    await refund(marketConfig(trader, appId), 0, 2, deployment.usdcAsaId)
    const traderBalanceAfter = await getUsdcBalance(trader.addr)
    expect(traderBalanceAfter).toBeGreaterThan(traderBalanceBefore)
  }, 180_000)

  // ── 10. Claim on wrong outcome ──

  it('claim on losing outcome yields nothing', async () => {
    const deployer = accounts[0]
    const trader = accounts[1]
    await fundUsdc(deployer, 200_000_000n)
    const { appId, deadline } = await createAndBootstrapMarket({
      creator: deployer, deadlineOffsetSecs: 45,
    })
    await prepareTrader(trader, appId)

    // Buy outcome 1 (will be the loser)
    await buy(marketConfig(trader, appId), 1, 5_000_000n, 2, deployment.usdcAsaId)
    const balanceBefore = await getUsdcBalance(trader.addr)

    // Resolve to outcome 0
    await advanceTimePast(BigInt(deadline + 1), deployer)
    await triggerResolution(marketConfig(deployer, appId), 2)
    const evidence = new Uint8Array(createHash('sha256').update('test').digest())
    await proposeResolution(marketConfig(deployer, appId), 0, evidence, 2)
    const proposedTs = await currentBlockTs()
    await advanceTimePast(proposedTs + 12n, deployer)
    await finalizeResolution(marketConfig(deployer, appId), 2)

    // Claim on losing outcome 1 should fail or yield 0
    await expect(
      claim(marketConfig(trader, appId), 1, 2, deployment.usdcAsaId)
    ).rejects.toThrow()
  }, 240_000)
}, { timeout: 600_000 })

// ── Utility ──

async function getUsdcBalance(addr: string): Promise<bigint> {
  try {
    const info = await algod.accountAssetInformation(addr, deployment.usdcAsaId).do()
    return BigInt(info.assetHolding?.amount ?? 0)
  } catch {
    return 0n
  }
}
