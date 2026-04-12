import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { boxNameAddr } from '../base'
import {
  MARKET_LOCAL_FEE_SNAPSHOT,
  MARKET_LOCAL_LP_SHARES,
  MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM,
  MARKET_LOCAL_RESIDUAL_CLAIMED,
  MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS,
} from '../market-schema'

const baseMocks = vi.hoisted(() => ({
  callMethod: vi.fn(),
  loadMethods: vi.fn(() => new Map()),
  marketBoxRefs: vi.fn(),
  pricingBoxRefs: vi.fn(),
  readBox: vi.fn(),
}))

const internalMocks = vi.hoisted(() => ({
  assertActiveLpSkewWithinCap: vi.fn(),
  buildAppOptInIfNeeded: vi.fn(),
  buildAsaOptInIfNeeded: vi.fn(),
  callWithBudget: vi.fn(),
  getMarketState: vi.fn(),
  getProtocolBudgetForeignApps: vi.fn(),
  getProtocolConfigAppId: vi.fn(),
  makeAssetTransfer: vi.fn(),
  noopsFor: vi.fn(),
  readAccountLocalState: vi.fn(),
  targetDeltaBForActiveLpDepositFromPrices: vi.fn(),
}))

vi.mock('../base.js', async () => {
  const actual = await vi.importActual<typeof import('../base')>('../base.js')
  return {
    ...actual,
    callMethod: baseMocks.callMethod,
    loadMethods: baseMocks.loadMethods,
    marketBoxRefs: baseMocks.marketBoxRefs,
    pricingBoxRefs: baseMocks.pricingBoxRefs,
    readBox: baseMocks.readBox,
  }
})

vi.mock('../question-market/internal.js', () => ({
  assertActiveLpSkewWithinCap: internalMocks.assertActiveLpSkewWithinCap,
  buildAppOptInIfNeeded: internalMocks.buildAppOptInIfNeeded,
  buildAsaOptInIfNeeded: internalMocks.buildAsaOptInIfNeeded,
  callWithBudget: internalMocks.callWithBudget,
  getMarketState: internalMocks.getMarketState,
  getProtocolBudgetForeignApps: internalMocks.getProtocolBudgetForeignApps,
  getProtocolConfigAppId: internalMocks.getProtocolConfigAppId,
  makeAssetTransfer: internalMocks.makeAssetTransfer,
  noopsFor: internalMocks.noopsFor,
  readAccountLocalState: internalMocks.readAccountLocalState,
  targetDeltaBForActiveLpDepositFromPrices: internalMocks.targetDeltaBForActiveLpDepositFromPrices,
}))

import {
  collectLpFees,
  enterActiveLpForDeposit,
  getLpAccountState,
  withdrawLiquidity,
} from '../question-market/liquidity'

function makeConfig() {
  const sender = algosdk.getApplicationAddress(701).toString()
  return {
    algodClient: {
      getTransactionParams: vi.fn(() => ({
        do: vi.fn().mockResolvedValue({
          fee: 1_000n,
          firstValid: 1n,
          lastValid: 2n,
          genesisHash: 'abc',
          genesisID: 'localnet-v1',
        }),
      })),
    } as any,
    appId: 88,
    sender,
    signer: vi.fn() as any,
  }
}

describe('question-market liquidity wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    internalMocks.noopsFor.mockReturnValue(14)
    internalMocks.getProtocolConfigAppId.mockResolvedValue(900)
    internalMocks.getProtocolBudgetForeignApps.mockReturnValue([88])
    baseMocks.pricingBoxRefs.mockReturnValue([{ appIndex: 88, name: new Uint8Array([1]) }])
    baseMocks.marketBoxRefs.mockReturnValue([{ appIndex: 88, name: new Uint8Array([2]) }])
  })

  it('builds active LP entry calls from the current market price snapshot', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'asa-opt-in' }, signer: config.signer }
    const appOptInTxn = { txn: { kind: 'app-opt-in' }, signer: config.signer }
    const paymentTxn = { kind: 'deposit' }
    const state = {
      prices: [600_000n, 400_000n],
      lpEntryMaxPriceFp: 800_000n,
    }
    internalMocks.getMarketState.mockResolvedValue(state)
    internalMocks.targetDeltaBForActiveLpDepositFromPrices.mockReturnValue(123n)
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.buildAppOptInIfNeeded.mockResolvedValue(appOptInTxn)
    internalMocks.makeAssetTransfer.mockReturnValue(paymentTxn)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'lp-tx' })

    await expect(
      enterActiveLpForDeposit(config, 500n, 2, 31566704, { priceTolerance: 2n }),
    ).resolves.toEqual({
      txId: 'lp-tx',
      targetDeltaB: 123n,
      maxDeposit: 500n,
    })

    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'enter_lp_active',
      [123n, 500n, state.prices, 2n, { txn: paymentTxn, signer: config.signer }],
      2,
      0,
      14,
      {
        prependTxns: [optInTxn, appOptInTxn],
        boxOverride: [
          { appIndex: 88, name: new Uint8Array([1]) },
          { appIndex: 88, name: boxNameAddr('uf:', config.sender) },
        ],
        foreignAssets: [31566704],
        innerTxnCount: 1,
        budgetAppId: 900,
        budgetForeignApps: [88],
      },
    )
  })

  it('rejects active LP deposits that cannot add any depth', async () => {
    const config = makeConfig()
    internalMocks.getMarketState.mockResolvedValue({
      prices: [600_000n, 400_000n],
      lpEntryMaxPriceFp: 800_000n,
    })
    internalMocks.targetDeltaBForActiveLpDepositFromPrices.mockReturnValue(0n)

    await expect(enterActiveLpForDeposit(config, 1n, 2, 31566704)).rejects.toThrow(
      /too small to add any active LP depth/i,
    )
  })

  it('decodes LP local state and fee boxes without localnet', async () => {
    internalMocks.readAccountLocalState.mockResolvedValue({
      [MARKET_LOCAL_LP_SHARES]: 11n,
      [MARKET_LOCAL_FEE_SNAPSHOT]: 12n,
      [MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS]: 13n,
      [MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM]: 14n,
      [MARKET_LOCAL_RESIDUAL_CLAIMED]: 15n,
    })
    baseMocks.readBox.mockResolvedValue(algosdk.encodeUint64(9))

    await expect(
      getLpAccountState({} as algosdk.Algodv2, 88, algosdk.getApplicationAddress(702).toString()),
    ).resolves.toEqual({
      lpShares: 11n,
      feeSnapshot: 12n,
      withdrawableFeeSurplus: 13n,
      lpWeightedEntrySum: 14n,
      residualClaimed: 15n,
      claimableFees: 9n,
    })
  })

  it('collects claimable LP fees and withdraws the resulting surplus', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'asa-opt-in' }, signer: config.signer }
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.readAccountLocalState
      .mockResolvedValueOnce({
        [MARKET_LOCAL_LP_SHARES]: 1n,
        [MARKET_LOCAL_FEE_SNAPSHOT]: 2n,
        [MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS]: 0n,
        [MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM]: 3n,
        [MARKET_LOCAL_RESIDUAL_CLAIMED]: 4n,
      })
      .mockResolvedValueOnce({
        [MARKET_LOCAL_LP_SHARES]: 1n,
        [MARKET_LOCAL_FEE_SNAPSHOT]: 2n,
        [MARKET_LOCAL_WITHDRAWABLE_FEE_SURPLUS]: 7n,
        [MARKET_LOCAL_LP_WEIGHTED_ENTRY_SUM]: 3n,
        [MARKET_LOCAL_RESIDUAL_CLAIMED]: 4n,
      })
    baseMocks.readBox
      .mockResolvedValueOnce(algosdk.encodeUint64(5))
      .mockResolvedValueOnce(algosdk.encodeUint64(0))
    baseMocks.callMethod
      .mockResolvedValueOnce({ txID: 'claim-tx' })
      .mockResolvedValueOnce({ txID: 'withdraw-tx' })

    await expect(collectLpFees(config, 31566704)).resolves.toEqual({
      claimTxId: 'claim-tx',
      withdrawTxId: 'withdraw-tx',
      withdrawnAmount: 7n,
    })

    expect(baseMocks.callMethod).toHaveBeenNthCalledWith(
      1,
      config,
      expect.any(Map),
      'claim_lp_fees',
      [],
      {
        boxes: [{ appIndex: Number(config.appId), name: boxNameAddr('uf:', config.sender) }],
      },
    )
    expect(baseMocks.callMethod).toHaveBeenNthCalledWith(
      2,
      config,
      expect.any(Map),
      'withdraw_lp_fees',
      [7n],
      {
        prependTxns: [optInTxn],
        appForeignAssets: [31566704],
        innerTxnCount: 1,
      },
    )
  })

  it('keeps disabled LP withdrawals explicit in unit coverage too', async () => {
    await expect(withdrawLiquidity(makeConfig(), 1n, 2, 31566704)).rejects.toThrow(
      /disabled in the current market line/i,
    )
  })
})
