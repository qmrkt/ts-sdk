import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { boxNameAddr } from '../base'

const internalMocks = vi.hoisted(() => ({
  SHARE_UNIT: 1_000_000n,
  assertWholeShareMultiple: vi.fn(),
  buildAsaOptInIfNeeded: vi.fn(),
  callWithBudget: vi.fn(),
  getAssetBalance: vi.fn(),
  getProtocolBudgetForeignApps: vi.fn(),
  getProtocolConfigAppId: vi.fn(),
  makeAssetTransfer: vi.fn(),
  noopsFor: vi.fn(),
}))

vi.mock('../question-market/internal.js', () => ({
  SHARE_UNIT: internalMocks.SHARE_UNIT,
  assertWholeShareMultiple: internalMocks.assertWholeShareMultiple,
  buildAsaOptInIfNeeded: internalMocks.buildAsaOptInIfNeeded,
  callWithBudget: internalMocks.callWithBudget,
  getAssetBalance: internalMocks.getAssetBalance,
  getProtocolBudgetForeignApps: internalMocks.getProtocolBudgetForeignApps,
  getProtocolConfigAppId: internalMocks.getProtocolConfigAppId,
  makeAssetTransfer: internalMocks.makeAssetTransfer,
  noopsFor: internalMocks.noopsFor,
}))

import {
  buy,
  claim,
  refund,
  sell,
  withdrawPendingPayouts,
} from '../question-market/trading'

function makeConfig() {
  const sender = algosdk.getApplicationAddress(700).toString()
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
    appId: 77,
    sender,
    signer: vi.fn() as any,
  }
}

describe('question-market trading wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    internalMocks.noopsFor.mockReturnValue(14)
    internalMocks.getProtocolBudgetForeignApps.mockReturnValue([77])
    internalMocks.getProtocolConfigAppId.mockResolvedValue(404)
  })

  it('builds buy calls with pooled budget and derives the spent amount from balances', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'opt-in' }, signer: config.signer }
    const paymentTxn = { kind: 'payment' }
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.makeAssetTransfer.mockReturnValue(paymentTxn)
    internalMocks.getAssetBalance
      .mockResolvedValueOnce(1_000n)
      .mockResolvedValueOnce(830n)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'buy-tx' })

    await expect(buy(config, 1, 200n, 3, 31566704)).resolves.toEqual({
      txId: 'buy-tx',
      shares: internalMocks.SHARE_UNIT,
      totalCost: 170n,
      refundAmount: 30n,
    })

    expect(internalMocks.makeAssetTransfer).toHaveBeenCalledWith(
      config.sender,
      algosdk.getApplicationAddress(Number(config.appId)).toString(),
      31566704,
      200n,
      expect.any(Object),
    )
    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'buy',
      [1, internalMocks.SHARE_UNIT, 200n, { txn: paymentTxn, signer: config.signer }],
      3,
      1,
      14,
      {
        prependTxns: [optInTxn],
        foreignAssets: [31566704],
        innerTxnCount: 1,
        budgetAppId: 404,
        budgetForeignApps: [77],
      },
    )
  })

  it('builds sell calls with protocol budget resources and returns the net proceeds', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'opt-in' }, signer: config.signer }
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.getAssetBalance
      .mockResolvedValueOnce(400n)
      .mockResolvedValueOnce(560n)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'sell-tx' })

    await expect(sell(config, 0, 10n, 2, null, 31566704)).resolves.toEqual({
      txId: 'sell-tx',
      shares: internalMocks.SHARE_UNIT,
      netReturn: 160n,
    })

    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'sell',
      [0, internalMocks.SHARE_UNIT, 10n],
      2,
      0,
      14,
      {
        prependTxns: [optInTxn],
        foreignAssets: [31566704],
        innerTxnCount: 1,
        budgetAppId: 404,
        budgetForeignApps: [77],
      },
    )
  })

  it('uses fixed refund noops and derives payout deltas for claim and refund flows', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'opt-in' }, signer: config.signer }
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.getAssetBalance
      .mockResolvedValueOnce(50n)
      .mockResolvedValueOnce(125n)
      .mockResolvedValueOnce(125n)
      .mockResolvedValueOnce(215n)
    internalMocks.callWithBudget
      .mockResolvedValueOnce({ txId: 'claim-tx' })
      .mockResolvedValueOnce({ txId: 'refund-tx' })

    await expect(claim(config, 1, 2, 31566704)).resolves.toEqual({
      txId: 'claim-tx',
      shares: internalMocks.SHARE_UNIT,
      payout: 75n,
    })
    await expect(refund(config, 1, 2, 31566704)).resolves.toEqual({
      txId: 'refund-tx',
      shares: internalMocks.SHARE_UNIT,
      refundAmount: 90n,
    })

    expect(internalMocks.callWithBudget).toHaveBeenNthCalledWith(
      1,
      config,
      'claim',
      [1, internalMocks.SHARE_UNIT],
      2,
      1,
      14,
      {
        prependTxns: [optInTxn],
        foreignAssets: [31566704],
        innerTxnCount: 1,
      },
    )
    expect(internalMocks.callWithBudget).toHaveBeenNthCalledWith(
      2,
      config,
      'refund',
      [1, internalMocks.SHARE_UNIT],
      2,
      1,
      10,
      {
        prependTxns: [optInTxn],
        foreignAssets: [31566704],
        innerTxnCount: 1,
      },
    )
  })

  it('prepends USDC opt-in before withdrawing pending payouts', async () => {
    const config = makeConfig()
    const optInTxn = { txn: { kind: 'opt-in' }, signer: config.signer }
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'withdraw-tx' })

    await withdrawPendingPayouts(config, 31566704)

    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'withdraw_pending_payouts',
      [],
      2,
      0,
      4,
      {
        prependTxns: [optInTxn],
        extraBoxes: [{ appIndex: Number(config.appId), name: boxNameAddr('pp:', config.sender) }],
        foreignAssets: [31566704],
        innerTxnCount: 1,
      },
    )
  })
})
