import algosdk from 'algosdk'
import { boxNameAddr, type ClientConfig } from '../base.js'
import {
  assertWholeShareMultiple,
  buildAsaOptInIfNeeded,
  callWithBudget,
  getAssetBalance,
  getProtocolBudgetForeignApps,
  getProtocolConfigAppId,
  makeAssetTransfer,
  noopsFor,
  SHARE_UNIT,
  type BuySharesResult,
  type SellSharesResult,
  type ClaimSharesResult,
  type RefundSharesResult,
} from './internal.js'

export async function buy(
  config: ClientConfig,
  outcomeIndex: number,
  maxCost: bigint,
  numOutcomes: number,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<BuySharesResult> {
  assertWholeShareMultiple(shares, 'buy')
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()

  const [sp, optInTxn, budgetAppId, usdcBefore] = await Promise.all([
    config.algodClient.getTransactionParams().do(),
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
    numOutcomes >= 2 ? getProtocolConfigAppId(config.algodClient, config.appId) : undefined,
    getAssetBalance(config.algodClient, config.sender, currencyAsaId),
  ])

  const paymentTxn = makeAssetTransfer(config.sender, appAddr, currencyAsaId, maxCost, sp)
  const prependTxns = [optInTxn].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const budgetForeignApps = budgetAppId
    ? getProtocolBudgetForeignApps(config.appId)
    : undefined
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

  const [optInTxn, budgetAppId, usdcBefore] = await Promise.all([
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
    numOutcomes >= 2 ? getProtocolConfigAppId(config.algodClient, config.appId) : undefined,
    getAssetBalance(config.algodClient, config.sender, currencyAsaId),
  ])

  const prependTxns = [optInTxn].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const budgetForeignApps = budgetAppId
    ? getProtocolBudgetForeignApps(config.appId)
    : undefined
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

export async function claim(
  config: ClientConfig,
  outcomeIndex: number,
  numOutcomes: number,
  currencyAsaId: number,
  shares: bigint = SHARE_UNIT,
): Promise<ClaimSharesResult> {
  assertWholeShareMultiple(shares, 'claim')

  const [optInTxn, usdcBefore] = await Promise.all([
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
    getAssetBalance(config.algodClient, config.sender, currencyAsaId),
  ])

  const prependTxns = [optInTxn].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
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

  const [optInTxn, usdcBefore] = await Promise.all([
    buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, currencyAsaId),
    getAssetBalance(config.algodClient, config.sender, currencyAsaId),
  ])

  const prependTxns = [optInTxn].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
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
