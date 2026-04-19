/**
 * SDK E2E test against localnet.
 *
 * Prerequisites:
 *   - AlgoKit localnet running: `algokit localnet start`
 *
 * Run: pnpm exec vitest run src/clients/__tests__/e2e-localnet.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import algosdk from 'algosdk'

import {
  createMarket,
  createMarketAtomic,
  DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT,
  listMarketIds,
  MAX_ACTIVE_LP_OUTCOMES,
  minimumBootstrapDeposit,
  type CreateMarketAtomicParams,
  type CreateMarketParams,
} from '../market-factory'
import { buy, sell, getMarketState, storeResolutionLogic, optInToAsa, triggerResolution, proposeResolution, proposeEarlyResolution, challengeResolution, finalizeResolution, finalizeDispute, abortEarlyResolution, adminResolveDispute, claim, provideLiquidity, withdrawLiquidity, withdrawPendingPayouts, enterActiveLpForDeposit } from '../question-market'
import { readConfig } from '../protocol-config'
import type { ClientConfig } from '../base'
import { getLocalnetAccountByAddress } from './localnet-accounts'
import { deployLocalnetProtocol } from './localnet-deployment'

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://127.0.0.1'
const ALGOD_PORT = 4001
const KMD_TOKEN = 'a'.repeat(64)
const KMD_SERVER = 'http://127.0.0.1'
const KMD_PORT = 4002

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
    note: new TextEncoder().encode(`e2e-tick:${Date.now()}:${Math.random()}`),
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

async function createOutcomeAsa(
  algodClient: algosdk.Algodv2,
  sender: string,
  txnSigner: algosdk.TransactionSigner,
  name: string,
): Promise<number> {
  const sp = await algodClient.getTransactionParams().do()
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender,
    total: BigInt(10_000_000_000),
    decimals: 6,
    defaultFrozen: false,
    unitName: name.slice(0, 8),
    assetName: `Outcome ${name}`,
    suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: txnSigner })
  const result = await atc.execute(algodClient, 4)
  const txInfo = await algodClient.pendingTransactionInformation(result.txIDs[0]).do()
  return Number(txInfo.assetIndex!)
}

async function getLocalnetSigner(algodClient: algosdk.Algodv2): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
  const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)
  const wallets = await kmd.listWallets()
  const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet')
  if (!defaultWallet) throw new Error('No default wallet')

  const handle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token
  const keys = await kmd.listKeys(handle)
  let bestAddr = ''
  let bestBalance = -1n

  for (const candidate of keys.addresses) {
    try {
      const acctInfo = await algodClient.accountInformation(candidate).do()
      const balance = BigInt(acctInfo.amount ?? 0)
      if (balance > bestBalance) {
        bestBalance = balance
        bestAddr = candidate
      }
    } catch {
      // Ignore inaccessible accounts and keep scanning the wallet.
    }
  }

  if (!bestAddr) {
    throw new Error('No funded localnet account found')
  }
  const skResp = await kmd.exportKey(handle, '', bestAddr)
  await kmd.releaseWalletHandle(handle)

  return {
    addr: bestAddr,
    signer: algosdk.makeBasicAccountTransactionSigner({ addr: bestAddr, sk: skResp.private_key } as any),
  }
}

async function getLocalnetSignerAt(index: number): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
  const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)
  const wallets = await kmd.listWallets()
  const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet')
  if (!defaultWallet) throw new Error('No default wallet')

  const handle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token
  const keys = await kmd.listKeys(handle)
  let addr = keys.addresses[index]
  while (!addr && keys.addresses.length <= index) {
    const generated = await kmd.generateKey(handle)
    keys.addresses.push(generated.address)
    addr = keys.addresses[index]
  }
  if (!addr) throw new Error(`No localnet key at index ${index}`)
  const skResp = await kmd.exportKey(handle, '', addr)
  await kmd.releaseWalletHandle(handle)

  const account = { addr, sk: skResp.private_key } as any
  return {
    addr,
    signer: algosdk.makeBasicAccountTransactionSigner(account),
  }
}

describe('E2E: Market lifecycle on localnet', () => {
  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)

    // Check localnet is running
    try {
      await algod.status().do()
    } catch {
      throw new Error('Localnet not running. Start with: algokit localnet start')
    }

    deployment = deployLocalnetProtocol({ reset: true })
    const localnet = await getLocalnetAccountByAddress(algod, deployment.deployer)
    deployer = localnet.addr
    signer = localnet.signer
  }, 120_000)

  beforeEach(async () => {
    if (!algod || !deployer) return
    await resetBlockOffsetTimestamp()
  })

  it('reads protocol config', async () => {
    const config = await readConfig(algod, deployment.protocolConfigAppId)
    expect(config.maxOutcomes).toBeGreaterThan(0)
    expect(config.minBootstrapDeposit).toBeGreaterThan(0n)
    expect(config.marketFactoryId).toBe(deployment.marketFactoryAppId)
  })

  it('creates a market via atomic factory', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const config: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }
    const protocolConfig = await readConfig(algod, deployment.protocolConfigAppId)
    const bootstrapDeposit = minimumBootstrapDeposit(protocolConfig.defaultB, 2)

    const result = await createMarketAtomic(config, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Test market e2e?'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })

    expect(result.marketAppId).toBeGreaterThan(0)
    expect(result.txId).toBeTruthy()

    // Read market state -- atomic create bootstraps to ACTIVE
    const state = await getMarketState(algod, result.marketAppId)
    expect(state.status).toBe(1) // ACTIVE
    expect(state.numOutcomes).toBe(2)
    expect(state.poolBalance).toBe(bootstrapDeposit)
  })

  it('rejects unsafe initial_b above bootstrap deposit', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const config: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    await expect(createMarketAtomic(config, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Unsafe high-b market?'),
      numOutcomes: 2,
      initialB: 100_000_000n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: 10_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })).rejects.toThrow()
  })

  it('atomically creates and trades a binary market', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const noteBytes = new TextEncoder().encode('question.market:j{"q":"Atomic test?","o":["Yes","No"]}')
    const atomicResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Atomic test?'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
      note: noteBytes,
    })

    expect(atomicResult.marketAppId).toBeGreaterThan(0)

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: atomicResult.marketAppId,
      sender: deployer,
      signer,
    }

    const beforeTrade = await getMarketState(algod, atomicResult.marketAppId)
    expect(beforeTrade.status).toBe(1)
    expect(beforeTrade.poolBalance).toBe(50_000_000n)
    expect(beforeTrade.lpSharesTotal).toBe(50_000_000n)

    const buyResult = await buy(marketConfig, 0, 20_000_000n, 2, deployment.usdcAsaId, 5_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)

    const afterBuy = await getMarketState(algod, atomicResult.marketAppId)
    expect(afterBuy.poolBalance).toBeGreaterThan(beforeTrade.poolBalance)

    const sellResult = await sell(marketConfig, 0, 1n, 2, null, deployment.usdcAsaId, 2_000_000n)
    expect(sellResult.netReturn).toBeGreaterThan(0n)
    const stateAfterSell = await getMarketState(algod, atomicResult.marketAppId)
    expect(stateAfterSell.poolBalance).toBeLessThan(afterBuy.poolBalance)
  })

  it('atomically creates and trades a multi-outcome market', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const atomicResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Atomic multi-outcome test?'),
      numOutcomes: 3,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: 100_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })

    expect(atomicResult.marketAppId).toBeGreaterThan(0)

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: atomicResult.marketAppId,
      sender: deployer,
      signer,
    }

    const beforeTrade = await getMarketState(algod, atomicResult.marketAppId)
    expect(beforeTrade.status).toBe(1)
    expect(beforeTrade.numOutcomes).toBe(3)
    expect(beforeTrade.poolBalance).toBe(100_000_000n)

    const buyResult = await buy(marketConfig, 1, 20_000_000n, 3, deployment.usdcAsaId, 5_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)
    const afterBuy = await getMarketState(algod, atomicResult.marketAppId)
    expect(afterBuy.poolBalance).toBeGreaterThan(beforeTrade.poolBalance)

    const sellResult = await sell(marketConfig, 1, 1n, 3, null, deployment.usdcAsaId, 2_000_000n)
    expect(sellResult.netReturn).toBeGreaterThan(0n)
    const stateAfterSell = await getMarketState(algod, atomicResult.marketAppId)
    expect(stateAfterSell.poolBalance).toBeLessThan(afterBuy.poolBalance)
  })

  it('atomically creates a market at the deployed max_outcomes limit', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const maxOutcomes = MAX_ACTIVE_LP_OUTCOMES
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const atomicResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode(`Atomic max outcome test (${maxOutcomes})?`),
      numOutcomes: maxOutcomes,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: minimumBootstrapDeposit(50_000_000n, maxOutcomes),
      protocolConfigAppId: deployment.protocolConfigAppId,
    })

    expect(atomicResult.marketAppId).toBeGreaterThan(0)

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: atomicResult.marketAppId,
      sender: deployer,
      signer,
    }

    let state = await getMarketState(algod, atomicResult.marketAppId)
    expect(state.status).toBe(1)
    expect(state.numOutcomes).toBe(maxOutcomes)
    expect(state.prices).toHaveLength(maxOutcomes)
  })

  it('trades successfully on a market at the deployed max_outcomes limit', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const maxOutcomes = MAX_ACTIVE_LP_OUTCOMES
    const targetOutcome = maxOutcomes - 1
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const atomicResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode(`Atomic max outcome trading test (${maxOutcomes})?`),
      numOutcomes: maxOutcomes,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: minimumBootstrapDeposit(50_000_000n, maxOutcomes),
      protocolConfigAppId: deployment.protocolConfigAppId,
    })

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: atomicResult.marketAppId,
      sender: deployer,
      signer,
    }

    const beforeTrade = await getMarketState(algod, atomicResult.marketAppId)
    const buyResult = await buy(
      marketConfig,
      targetOutcome,
      30_000_000n,
      maxOutcomes,
      deployment.usdcAsaId,
      2_000_000n,
    )
    expect(buyResult.shares).toBe(2_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)

    const afterBuy = await getMarketState(algod, atomicResult.marketAppId)
    expect(afterBuy.poolBalance).toBeGreaterThan(beforeTrade.poolBalance)

    const sellResult = await sell(
      marketConfig,
      targetOutcome,
      1n,
      maxOutcomes,
      null,
      deployment.usdcAsaId,
      1_000_000n,
    )
    expect(sellResult.shares).toBe(1_000_000n)
    expect(sellResult.netReturn).toBeGreaterThan(0n)

    const afterSell = await getMarketState(algod, atomicResult.marketAppId)
    expect(afterSell.poolBalance).toBeLessThan(afterBuy.poolBalance)

    await expect(
      withdrawLiquidity(marketConfig, 1_000_000n, maxOutcomes, deployment.usdcAsaId),
    ).rejects.toThrow('disabled')
  }, 180_000)

  it('rejects the generic sequential create helper before signing', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    await expect(
      createMarket(factoryConfig, {
        creator: deployer,
        currencyAsa: deployment.usdcAsaId,
        questionHash: new TextEncoder().encode('Disabled sequential create'),
        numOutcomes: 2,
        initialB: 0n,
        lpFeeBps: 200,
        blueprintHash: new TextEncoder().encode('legacy-disabled'),
        deadline,
        challengeWindowSecs: 3600,
        cancellable: true,
        bootstrapDeposit: 50_000_000n,
        protocolConfigAppId: deployment.protocolConfigAppId,
      }),
    ).rejects.toThrow(/createMarket\(\) is disabled/i)
  })

  it('preserves custom LP skew caps and allows entry while the market stays below them', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const atomicResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Skew cap test?'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: 50_000_000n,
      lpEntryMaxPriceFp: 550_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: atomicResult.marketAppId,
      sender: deployer,
      signer,
    }

    const initialState = await getMarketState(algod, atomicResult.marketAppId)
    expect(initialState.lpEntryMaxPriceFp).toBe(550_000n)
    expect(DEFAULT_LP_ENTRY_MAX_PRICE_FP_BIGINT).toBe(800_000n)

    const lpResult = await enterActiveLpForDeposit(marketConfig, 5_000_000n, 2, deployment.usdcAsaId)
    expect(lpResult.txId).toBeTruthy()

    const afterEntry = await getMarketState(algod, atomicResult.marketAppId)
    expect(afterEntry.poolBalance).toBeGreaterThan(initialState.poolBalance)
  }, 180_000)

  it('creates, buys, and sells on a market', async () => {
    const deadline = Number(await currentBlockTimestamp()) + 86_400
    // Create a fresh market atomically
    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const result = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Trade test?'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 3600,
      cancellable: true,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = result.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }

    const beforeTrade = await getMarketState(algod, marketAppId)
    expect(beforeTrade.status).toBe(1) // ACTIVE
    expect(beforeTrade.poolBalance).toBeGreaterThan(0n)

    const buyResult = await buy(marketConfig, 0, 20_000_000n, 2, deployment.usdcAsaId, 5_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)
    const afterBuy = await getMarketState(algod, marketAppId)
    expect(afterBuy.poolBalance).toBeGreaterThan(beforeTrade.poolBalance)

    const sellResult = await sell(marketConfig, 0, 1n, 2, null, deployment.usdcAsaId, 2_000_000n)
    expect(sellResult.netReturn).toBeGreaterThan(0n)
    const stateAfterSell = await getMarketState(algod, marketAppId)
    expect(stateAfterSell.poolBalance).toBeLessThan(afterBuy.poolBalance)
  })

  it('full lifecycle: create -> trade -> resolve -> claim', async () => {
    // ---------------------------------------------------------------
    // Helper: advance localnet block timestamp by sending self-pays.
    // Each transaction mined in a new block advances time by ~1s on
    // localnet, but we cannot control the wall-clock mapping, so we
    // poll until the on-chain timestamp exceeds the target.
    // ---------------------------------------------------------------
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    async function mineTick(): Promise<void> {
      const sp = await algod.getTransactionParams().do()
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: deployer,
        amount: 0,
        suggestedParams: sp,
        note: new TextEncoder().encode(`tick:${Date.now()}:${Math.random()}`),
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn, signer })
      await atc.execute(algod, 4)
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
      if (await currentBlockTimestamp() >= target) return
      throw new Error(`Could not advance block time past ${target}`)
    }

    // ---------------------------------------------------------------
    // 1. Create a second signer (trader2) from KMD.
    // ---------------------------------------------------------------
    const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)
    const wallets = await kmd.listWallets()
    const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet')
    const handle = (await kmd.initWalletHandle(defaultWallet!.id, '')).wallet_handle_token
    const keys = await kmd.listKeys(handle)

    // deployer = keys.addresses[0]; trader2 = keys.addresses[1]
    let trader2Addr = keys.addresses[1]
    if (!trader2Addr) {
      // Only one account; generate a second
      const genResp = await kmd.generateKey(handle)
      trader2Addr = genResp.address
    }
    const skResp2 = await kmd.exportKey(handle, '', trader2Addr)
    await kmd.releaseWalletHandle(handle)
    const trader2Account = { addr: trader2Addr, sk: skResp2.private_key } as any
    const trader2Signer = algosdk.makeBasicAccountTransactionSigner(trader2Account)

    // Fund trader2 with ALGO and USDC
    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: trader2Addr,
        amount: 10_000_000, // 10 ALGO
        suggestedParams: sp,
      })
      const fundAtc = new algosdk.AtomicTransactionComposer()
      fundAtc.addTransaction({ txn: fundAlgo, signer })
      await fundAtc.execute(algod, 4)
    }

    // Opt trader2 into USDC
    {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: trader2Addr,
        receiver: trader2Addr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: trader2Signer })
      await atc.execute(algod, 4)
    }

    // Send trader2 some USDC
    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: trader2Addr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000), // 100 USDC
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    // ---------------------------------------------------------------
    // 2. Create market with deadline based on block timestamp.
    //    Use a very short block-based deadline so the suite doesn't
    //    depend on aggressive timestamp jumps from localnet.
    // ---------------------------------------------------------------
    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400
    const challengeWindow = 604_800

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const lifecycleResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Resolution lifecycle test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: challengeWindow,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = lifecycleResult.marketAppId
    expect(marketAppId).toBeGreaterThan(0)

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(1) // ACTIVE

    // ---------------------------------------------------------------
    // 4. Deployer buys outcome 0, trader2 buys outcome 1
    // ---------------------------------------------------------------
    const preTradeState = await getMarketState(algod, marketAppId)
    const buyResult = await buy(marketConfig, 0, 20_000_000n, 2, deployment.usdcAsaId, 5_000_000n)
    expect(buyResult.totalCost).toBeGreaterThan(0n)
    state = await getMarketState(algod, marketAppId)
    expect(state.poolBalance).toBeGreaterThan(preTradeState.poolBalance)

    // Some flows already opt the trader into local state; only do the manual
    // opt-in if the account is not enrolled yet.
    try {
      await algod.accountApplicationInformation(trader2Addr, marketAppId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optInTxn = algosdk.makeApplicationOptInTxnFromObject({
        sender: trader2Addr,
        appIndex: marketAppId,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optInTxn, signer: trader2Signer })
      await atc.execute(algod, 4)
    }

    // trader2 buys outcome 1
    const trader2MarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: trader2Addr,
      signer: trader2Signer,
    }
    await buy(trader2MarketConfig, 1, 10_000_000n, 2, deployment.usdcAsaId)

    // ---------------------------------------------------------------
    // 5. Advance time past the deadline
    // ---------------------------------------------------------------
    await advanceTimePast(BigInt(shortDeadline + 1))

    // ---------------------------------------------------------------
    // 6. Trigger resolution
    // ---------------------------------------------------------------
    await triggerResolution(marketConfig, 2)
    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(2) // RESOLUTION_PENDING

    // ---------------------------------------------------------------
    // 7. Propose resolution: outcome 0 wins
    // ---------------------------------------------------------------
    const evidenceHash = new Uint8Array(32)
    evidenceHash[0] = 0xAB
    await proposeResolution(marketConfig, 0, evidenceHash)
    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(3) // RESOLUTION_PROPOSED
    expect(state.proposedOutcome).toBe(0)

    // ---------------------------------------------------------------
    // 8. Advance time past challenge window
    // ---------------------------------------------------------------
    const proposalTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalTs + challengeWindow + 1))

    // ---------------------------------------------------------------
    // 9. Finalize resolution
    // ---------------------------------------------------------------
    await finalizeResolution(marketConfig, 2)
    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(5) // RESOLVED
    expect(state.winningOutcome).toBe(0)

    // ---------------------------------------------------------------
    // 10. Winner (deployer, outcome 0) claims
    // ---------------------------------------------------------------
    // Get deployer's USDC balance before claim
    const preClaimInfo = await algod.accountAssetInformation(deployer, deployment.usdcAsaId).do()
    const preClaimBalance = BigInt((preClaimInfo as any).assetHolding?.amount ?? (preClaimInfo as any)['asset-holding']?.amount ?? 0)

    await claim(marketConfig, 0, 2, deployment.usdcAsaId)

    const postClaimInfo = await algod.accountAssetInformation(deployer, deployment.usdcAsaId).do()
    const postClaimBalance = BigInt((postClaimInfo as any).assetHolding?.amount ?? (postClaimInfo as any)['asset-holding']?.amount ?? 0)
    expect(postClaimBalance).toBeGreaterThan(preClaimBalance)

    // ---------------------------------------------------------------
    // 11. Loser (trader2, outcome 1) tries to claim winning outcome -> should fail or get 0
    // ---------------------------------------------------------------
    // Trader2 bought outcome 1, but outcome 0 won. Claiming outcome 1
    // should either fail or return 0 USDC.
    const preLoserInfo = await algod.accountAssetInformation(trader2Addr, deployment.usdcAsaId).do()
    const preLoserBalance = BigInt((preLoserInfo as any).assetHolding?.amount ?? (preLoserInfo as any)['asset-holding']?.amount ?? 0)

    let loserClaimFailed = false
    try {
      await claim(trader2MarketConfig, 1, 2, deployment.usdcAsaId)
    } catch {
      loserClaimFailed = true
    }

    if (!loserClaimFailed) {
      // If claim succeeded, verify no USDC was gained
      const postLoserInfo = await algod.accountAssetInformation(trader2Addr, deployment.usdcAsaId).do()
      const postLoserBalance = BigInt((postLoserInfo as any).assetHolding?.amount ?? (postLoserInfo as any)['asset-holding']?.amount ?? 0)
      expect(postLoserBalance).toBeLessThanOrEqual(preLoserBalance)
    }
    // Either way, the loser does not profit. Test passes.
  })

  it('full dispute lifecycle: propose -> challenge -> finalize_dispute', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    async function mineTick(): Promise<void> {
      const sp = await algod.getTransactionParams().do()
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: deployer,
        amount: 0,
        suggestedParams: sp,
        note: new TextEncoder().encode(`tick:${Date.now()}:${Math.random()}`),
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn, signer })
      await atc.execute(algod, 4)
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
        await mineTick()
        try {
          await (algod as any).setBlockOffsetTimestamp(0).do()
        } catch {}
        if (await currentBlockTimestamp() >= target) {
          return
        }
      }
      throw new Error(`Could not advance block time past ${target}`)
    }

    const challenger = await getLocalnetSignerAt(1)
    const challengerAddr = challenger.addr
    const challengerSigner = challenger.signer

    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        amount: 10_000_000,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: fundAlgo, signer })
      await atc.execute(algod, 4)
    }

    try {
      await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: challengerAddr,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: challengerSigner })
      await atc.execute(algod, 4)
    }

    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400
    const challengeWindow = 600

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const disputeResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Dispute lifecycle test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: challengeWindow,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = disputeResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challengerAddr,
      signer: challengerSigner,
    }

    await buy(marketConfig, 0, 10_000_000n, 2, deployment.usdcAsaId)
    await advanceTimePast(BigInt(shortDeadline + 1))

    await triggerResolution(marketConfig, 2)
    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0xAB
    await proposeResolution(marketConfig, 0, proposalEvidenceHash)

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(3)
    expect(state.proposedOutcome).toBe(0)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengeWindowSecs).toBe(challengeWindow)
    expect(state.proposalTimestamp).toBeGreaterThan(state.deadline)
    expect(Number(await currentBlockTimestamp())).toBeLessThan(
      state.proposalTimestamp + state.challengeWindowSecs,
    )

    const challengerPreInfo = await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    const challengerPreBalance = BigInt((challengerPreInfo as any).assetHolding?.amount ?? (challengerPreInfo as any)['asset-holding']?.amount ?? 0)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0xCD
    await challengeResolution(challengerMarketConfig, 2, challengeEvidenceHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(6)
    expect(state.challengerBondHeld).toBe(state.challengeBond)

    const challengerAfterChallengeInfo = await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    const challengerAfterChallengeBalance = BigInt((challengerAfterChallengeInfo as any).assetHolding?.amount ?? (challengerAfterChallengeInfo as any)['asset-holding']?.amount ?? 0)
    expect(challengerAfterChallengeBalance).toBeLessThan(challengerPreBalance)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0xEF
    await finalizeDispute(marketConfig, 1, rulingHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(5)
    expect(state.winningOutcome).toBe(1)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(0n)

    const challengerAfterFinalizeInfo = await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    const challengerAfterFinalizeBalance = BigInt((challengerAfterFinalizeInfo as any).assetHolding?.amount ?? (challengerAfterFinalizeInfo as any)['asset-holding']?.amount ?? 0)
    expect(challengerAfterFinalizeBalance).toBe(challengerAfterChallengeBalance)

    await withdrawPendingPayouts(challengerMarketConfig, deployment.usdcAsaId)

    const challengerAfterWithdrawInfo = await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    const challengerAfterWithdrawBalance = BigInt((challengerAfterWithdrawInfo as any).assetHolding?.amount ?? (challengerAfterWithdrawInfo as any)['asset-holding']?.amount ?? 0)
    expect(challengerAfterWithdrawBalance).toBeGreaterThan(challengerAfterChallengeBalance)
  })

  it('early proposal can finalize unchallenged before the normal deadline flow', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    async function mineTick(): Promise<void> {
      const sp = await algod.getTransactionParams().do()
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: deployer,
        amount: 0,
        suggestedParams: sp,
        note: new TextEncoder().encode(`tick:${Date.now()}:${Math.random()}`),
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn, signer })
      await atc.execute(algod, 4)
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
      if (await currentBlockTimestamp() >= target) return
      throw new Error(`Could not advance block time past ${target}`)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400
    const challengeWindow = 120

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const earlyResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Early resolution finalization test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: challengeWindow,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = earlyResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }

    const evidenceHash = new Uint8Array(32)
    evidenceHash[0] = 0xAA
    await proposeEarlyResolution(marketConfig, 0, evidenceHash)

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(3)
    expect(state.proposedOutcome).toBe(0)
    expect(state.proposerBondHeld).toBe(0n)

    const proposalTs = await currentBlockTimestamp()
    await advanceTimePast(proposalTs + BigInt(challengeWindow + 1))

    await finalizeResolution(marketConfig, 2)
    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(5)
    expect(state.winningOutcome).toBe(0)
    expect(state.proposerBondHeld).toBe(0n)
  })

  it('challenged early proposal can still finalize_dispute before the deadline', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    const challenger = await getLocalnetSignerAt(1)
    const challengerAddr = challenger.addr
    const challengerSigner = challenger.signer

    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        amount: 10_000_000,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: fundAlgo, signer })
      await atc.execute(algod, 4)
    }

    try {
      await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: challengerAddr,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: challengerSigner })
      await atc.execute(algod, 4)
    }

    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const earlyDisputeResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Early resolution finalize dispute test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: 120,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = earlyDisputeResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challengerAddr,
      signer: challengerSigner,
    }

    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0x5a
    await proposeEarlyResolution(marketConfig, 0, proposalEvidenceHash)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0x6b
    await challengeResolution(challengerMarketConfig, 4, challengeEvidenceHash, 2)

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(6)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(state.challengeBond)

    expect(Number(await currentBlockTimestamp())).toBeLessThan(shortDeadline)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0x7c
    await finalizeDispute(marketConfig, 0, rulingHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(5)
    expect(state.winningOutcome).toBe(0)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(0n)
  })

  it('challenged early proposal can abort back to ACTIVE before deadline and resume trading', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    const challenger = await getLocalnetSignerAt(1)
    const challengerAddr = challenger.addr
    const challengerSigner = challenger.signer

    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        amount: 10_000_000,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: fundAlgo, signer })
      await atc.execute(algod, 4)
    }

    try {
      await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: challengerAddr,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: challengerSigner })
      await atc.execute(algod, 4)
    }

    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const abortActiveResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Early resolution abort to active test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: 120,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = abortActiveResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challengerAddr,
      signer: challengerSigner,
    }

    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0xAB
    await proposeEarlyResolution(marketConfig, 0, proposalEvidenceHash)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0xCD
    await challengeResolution(challengerMarketConfig, 5, challengeEvidenceHash, 2)

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(6)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(state.challengeBond)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0xEF
    await abortEarlyResolution(marketConfig, rulingHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(1)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(0n)

    const resumedTrade = await buy(marketConfig, 1, 20_000_000n, 2, deployment.usdcAsaId, 5_000_000n)
    expect(resumedTrade.totalCost).toBeGreaterThan(0n)
    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(1)
    expect(state.poolBalance).toBeGreaterThan(50_000_000n)
  })

  it('challenged early proposal can abort to RESOLUTION_PENDING after the deadline', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    async function mineTick(): Promise<void> {
      const sp = await algod.getTransactionParams().do()
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: deployer,
        amount: 0,
        suggestedParams: sp,
        note: new TextEncoder().encode(`tick:${Date.now()}:${Math.random()}`),
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn, signer })
      await atc.execute(algod, 4)
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
      if (await currentBlockTimestamp() >= target) return
      throw new Error(`Could not advance block time past ${target}`)
    }

    const challenger = await getLocalnetSignerAt(1)
    const challengerAddr = challenger.addr
    const challengerSigner = challenger.signer

    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        amount: 10_000_000,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: fundAlgo, signer })
      await atc.execute(algod, 4)
    }

    try {
      await algod.accountAssetInformation(challengerAddr, deployment.usdcAsaId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: challengerAddr,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: challengerSigner })
      await atc.execute(algod, 4)
    }

    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challengerAddr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 300
    const challengeWindow = 604_800

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const abortPendingResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Early resolution abort to pending test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: challengeWindow,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = abortPendingResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challengerAddr,
      signer: challengerSigner,
    }

    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0x11
    await proposeEarlyResolution(marketConfig, 0, proposalEvidenceHash)

    await advanceTimePast(BigInt(shortDeadline + 1))

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0x22
    await challengeResolution(challengerMarketConfig, 9, challengeEvidenceHash, 2)

    let state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(6)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0x33
    await abortEarlyResolution(marketConfig, rulingHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(2)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(0n)

    const reproposeEvidenceHash = new Uint8Array(32)
    reproposeEvidenceHash[0] = 0x44
    await proposeResolution(marketConfig, 1, reproposeEvidenceHash)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(3)
    expect(state.proposedOutcome).toBe(1)
  })

  it('market admin can resolve a disputed market', async () => {
    async function currentBlockTimestamp(): Promise<bigint> {
      const status = await algod.status().do()
      const round = Number(status.lastRound ?? (status as any)['last-round'] ?? 0)
      const block = await algod.block(round).do()
      const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
      return BigInt(ts)
    }

    async function mineTick(): Promise<void> {
      const sp = await algod.getTransactionParams().do()
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: deployer,
        amount: 0,
        suggestedParams: sp,
        note: new TextEncoder().encode(`tick:${Date.now()}:${Math.random()}`),
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn, signer })
      await atc.execute(algod, 4)
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
      if (await currentBlockTimestamp() >= target) return
      throw new Error(`Could not advance block time past ${target}`)
    }

    const challenger = await getLocalnetSignerAt(1)
    const marketAdmin = await getLocalnetSignerAt(2)

    {
      const sp = await algod.getTransactionParams().do()
      const fundAlgo = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challenger.addr,
        amount: 10_000_000,
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: fundAlgo, signer })
      await atc.execute(algod, 4)
    }

    try {
      await algod.accountAssetInformation(challenger.addr, deployment.usdcAsaId).do()
    } catch {
      const sp = await algod.getTransactionParams().do()
      const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: challenger.addr,
        receiver: challenger.addr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(0),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: optIn, signer: challenger.signer })
      await atc.execute(algod, 4)
    }

    {
      const sp = await algod.getTransactionParams().do()
      const sendUsdc = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer,
        receiver: challenger.addr,
        assetIndex: deployment.usdcAsaId,
        amount: BigInt(100_000_000),
        suggestedParams: sp,
      })
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addTransaction({ txn: sendUsdc, signer })
      await atc.execute(algod, 4)
    }

    const blockNow = Number(await currentBlockTimestamp())
    const shortDeadline = blockNow + 86_400
    const challengeWindow = 600

    const factoryConfig: ClientConfig = {
      algodClient: algod,
      appId: deployment.marketFactoryAppId,
      sender: deployer,
      signer,
    }

    const adminDisputeResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('Admin dispute lifecycle test'),
      numOutcomes: 2,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline: shortDeadline,
      challengeWindowSecs: challengeWindow,
      marketAdmin: marketAdmin.addr,
      cancellable: false,
      bootstrapDeposit: 50_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const marketAppId = adminDisputeResult.marketAppId

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: deployer,
      signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challenger.addr,
      signer: challenger.signer,
    }
    const marketAdminConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: marketAdmin.addr,
      signer: marketAdmin.signer,
    }

    await buy(marketConfig, 0, 10_000_000n, 2, deployment.usdcAsaId)
    await advanceTimePast(BigInt(shortDeadline + 1))

    await triggerResolution(marketConfig, 2)
    const proposalEvidenceHash = new Uint8Array(32)
    proposalEvidenceHash[0] = 0xAA
    await proposeResolution(marketConfig, 0, proposalEvidenceHash)

    let state = await getMarketState(algod, marketAppId)
    expect(state.challengeWindowSecs).toBe(challengeWindow)
    expect(state.proposalTimestamp).toBeGreaterThan(state.deadline)
    expect(Number(await currentBlockTimestamp())).toBeLessThan(
      state.proposalTimestamp + state.challengeWindowSecs,
    )

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0xBB
    await challengeResolution(challengerMarketConfig, 7, challengeEvidenceHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(6)
    expect(state.marketAdmin).toBe(marketAdmin.addr)

    const challengerAfterChallengeInfo = await algod.accountAssetInformation(challenger.addr, deployment.usdcAsaId).do()
    const challengerAfterChallengeBalance = BigInt((challengerAfterChallengeInfo as any).assetHolding?.amount ?? (challengerAfterChallengeInfo as any)['asset-holding']?.amount ?? 0)

    const rulingHash = new Uint8Array(32)
    rulingHash[0] = 0xCC
    await adminResolveDispute(marketAdminConfig, 1, rulingHash, 2)

    state = await getMarketState(algod, marketAppId)
    expect(state.status).toBe(5)
    expect(state.winningOutcome).toBe(1)
    expect(state.proposerBondHeld).toBe(0n)
    expect(state.challengerBondHeld).toBe(0n)

    const challengerAfterFinalizeInfo = await algod.accountAssetInformation(challenger.addr, deployment.usdcAsaId).do()
    const challengerAfterFinalizeBalance = BigInt((challengerAfterFinalizeInfo as any).assetHolding?.amount ?? (challengerAfterFinalizeInfo as any)['asset-holding']?.amount ?? 0)
    expect(challengerAfterFinalizeBalance).toBe(challengerAfterChallengeBalance)

    await withdrawPendingPayouts(challengerMarketConfig, deployment.usdcAsaId)

    const challengerAfterWithdrawInfo = await algod.accountAssetInformation(challenger.addr, deployment.usdcAsaId).do()
    const challengerAfterWithdrawBalance = BigInt((challengerAfterWithdrawInfo as any).assetHolding?.amount ?? (challengerAfterWithdrawInfo as any)['asset-holding']?.amount ?? 0)
    expect(challengerAfterWithdrawBalance).toBeGreaterThan(challengerAfterChallengeBalance)
  })

  it('handles 3-outcome market (box ref distribution)', async () => {
    // This test validates that callWithBudget correctly distributes box refs
    // across noops so that no single txn exceeds MaxAppTotalTxnReferences=8.
    // 3 outcomes = 8 box refs, plus 2 foreign assets = would be 10 on one txn.
    const status = await algod.status().do()
    const block = await algod.block(Number(status.lastRound)).do()
    const blockTs = BigInt(block.block.header.timestamp)
    const deadline = Number(blockTs) + 7200

    const factoryConfig: ClientConfig = {
      algodClient: algod, appId: deployment.marketFactoryAppId,
      sender: deployer, signer,
    }
    const threeOutcomeResult = await createMarketAtomic(factoryConfig, {
      creator: deployer,
      currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('3-outcome test'),
      numOutcomes: 3,
      initialB: 0n,
      lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline,
      challengeWindowSecs: 120,
      cancellable: true,
      bootstrapDeposit: 100_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const appId = threeOutcomeResult.marketAppId
    expect(appId).toBeGreaterThan(0)

    const mc: ClientConfig = { algodClient: algod, appId, sender: deployer, signer }

    const state = await getMarketState(algod, appId)
    expect(state.status).toBe(1) // ACTIVE

    // Buy each of the 3 outcomes - this is the critical test
    for (let i = 0; i < 3; i++) {
      await buy(mc, i, 3_000_000n, 3, deployment.usdcAsaId)
    }

    const stateAfter = await getMarketState(algod, appId)
    expect(stateAfter.poolBalance).toBeGreaterThan(state.poolBalance)
    expect(stateAfter.status).toBe(1)
  })

  it('3-outcome market: buy + sell + LP withdrawal stays disabled', async () => {
    const status = await algod.status().do()
    const block = await algod.block(Number(status.lastRound)).do()
    const blockTs = BigInt(block.block.header.timestamp)
    const deadline = Number(blockTs) + 7200

    const factoryConfig: ClientConfig = {
      algodClient: algod, appId: deployment.marketFactoryAppId,
      sender: deployer, signer,
    }
    const threeOutcomeLpResult = await createMarketAtomic(factoryConfig, {
      creator: deployer, currencyAsa: deployment.usdcAsaId,
      questionHash: new TextEncoder().encode('5-outcome test'),
      numOutcomes: 3, initialB: 0n, lpFeeBps: 200,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
      deadline, challengeWindowSecs: 120,
      cancellable: true, bootstrapDeposit: 100_000_000n,
      protocolConfigAppId: deployment.protocolConfigAppId,
    })
    const appId = threeOutcomeLpResult.marketAppId

    const mc: ClientConfig = { algodClient: algod, appId, sender: deployer, signer }

    // Buy all 3 outcomes
    for (let i = 0; i < 3; i++) {
      await buy(mc, i, 3_000_000n, 3, deployment.usdcAsaId)
    }

    // Sell one back
    await sell(mc, 0, 0n, 3, null, deployment.usdcAsaId)

    await expect(withdrawLiquidity(mc, 5_000_000n, 3, deployment.usdcAsaId)).rejects.toThrow('disabled')

    const state = await getMarketState(algod, appId)
    expect(state.status).toBe(1)
    for (let i = 0; i < 3; i++) {
      expect(state.quantities[i]).toBeGreaterThanOrEqual(0n)
    }
  })
}, { timeout: 180_000 })
