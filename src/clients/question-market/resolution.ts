import algosdk from 'algosdk'
import { marketBoxRefs, readGlobalState, type ClientConfig } from '../base.js'
import {
  buildAsaOptInIfNeeded,
  callWithBudget,
  decodeAddressStateValue,
  deduplicateBoxes,
  getLatestBlockTimestamp,
  makeAssetTransfer,
  noopsFor,
  payoutBoxRefs,
  requiredBondFromState,
  stateValue,
} from './internal.js'

const STATUS_ACTIVE = 1

export async function triggerResolution(config: ClientConfig, numOutcomes = 2) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const liveStatus = Number(stateValue<bigint>(gs, 'st', 'status') ?? 0n)
  if (liveStatus !== STATUS_ACTIVE) {
    throw new Error('This market is not active anymore.')
  }

  const liveDeadline = Number(stateValue<bigint>(gs, 'dl', 'deadline') ?? 0n)
  const latestTimestamp = await getLatestBlockTimestamp(config.algodClient)
  if (liveDeadline > 0 && latestTimestamp > 0 && latestTimestamp < liveDeadline) {
    throw new Error("This market's deadline has not passed on-chain yet. Refresh and try again in a moment.")
  }

  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  return callWithBudget(config, 'trigger_resolution', [], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function proposeResolution(
  config: ClientConfig,
  outcomeIndex: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolutionAuthority = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ra', 'resolution_authority'))
  const resolvedBondAmount = bondAmount ?? (
    resolutionAuthority === config.sender
      ? 0n
      : requiredBondFromState(
          stateValue<bigint>(gs, 'prb', 'proposal_bond') ?? 0n,
          stateValue<bigint>(gs, 'pbb', 'proposal_bond_bps') ?? 0n,
          stateValue<bigint>(gs, 'pbc', 'proposal_bond_cap') ?? 0n,
          stateValue<bigint>(gs, 'pb', 'pool_balance') ?? 0n,
          stateValue<bigint>(gs, 'bd', 'bootstrap_deposit') ?? 0n,
        )
  )
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'propose_resolution',
    [outcomeIndex, evidenceHash, { txn: paymentTxn, signer: config.signer }],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function proposeEarlyResolution(
  config: ClientConfig,
  outcomeIndex: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolvedBondAmount = bondAmount ?? 0n
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const paymentTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'propose_early_resolution',
    [outcomeIndex, evidenceHash, { txn: paymentTxn, signer: config.signer }],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function challengeResolution(
  config: ClientConfig,
  reasonCode: number,
  evidenceHash: Uint8Array,
  numOutcomes = 2,
  currencyAsaId?: number,
  bondAmount?: bigint,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  const gs = await readGlobalState(config.algodClient, config.appId)
  const resolvedCurrencyAsa = currencyAsaId ?? Number(stateValue<bigint>(gs, 'ca', 'currency_asa') ?? 0n)
  const resolvedBondAmount = bondAmount ?? requiredBondFromState(
    stateValue<bigint>(gs, 'cb', 'challenge_bond') ?? 0n,
    stateValue<bigint>(gs, 'cbb', 'challenge_bond_bps') ?? 0n,
    stateValue<bigint>(gs, 'cbc', 'challenge_bond_cap') ?? 0n,
    stateValue<bigint>(gs, 'pb', 'pool_balance') ?? 0n,
    stateValue<bigint>(gs, 'bd', 'bootstrap_deposit') ?? 0n,
  )
  const prependTxns = [
    await buildAsaOptInIfNeeded(config.algodClient, config.sender, config.signer, resolvedCurrencyAsa),
  ].filter((txn): txn is algosdk.TransactionWithSigner => Boolean(txn))
  const sp = await config.algodClient.getTransactionParams().do()
  const appAddr = algosdk.getApplicationAddress(Number(config.appId)).toString()
  const bondTxn = makeAssetTransfer(config.sender, appAddr, resolvedCurrencyAsa, resolvedBondAmount, sp)

  return callWithBudget(
    config,
    'challenge_resolution',
    [{ txn: bondTxn, signer: config.signer }, reasonCode, evidenceHash],
    numOutcomes,
    0,
    noopsFor(numOutcomes),
    { boxOverride: qBoxes, prependTxns },
  )
}

export async function finalizeResolution(config: ClientConfig, numOutcomes = 2) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer),
  ])
  return callWithBudget(config, 'finalize_resolution', [], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function registerDispute(
  config: ClientConfig,
  disputeRefHash: Uint8Array,
  backendKind: number,
  deadline: number,
  numOutcomes = 2,
) {
  const qBoxes = marketBoxRefs(Number(config.appId), numOutcomes)
  return callWithBudget(config, 'register_dispute', [disputeRefHash, backendKind, BigInt(deadline)], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

async function resolveDisputeCall(
  config: ClientConfig,
  methodName: string,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes: number,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const originalProposal = Number(stateValue<bigint>(gs, 'po', 'proposed_outcome') ?? 0n)
  const payoutRecipients = outcomeIndex === originalProposal
    ? [proposer]
    : [challenger]
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer, challenger, ...payoutRecipients),
  ])
  return callWithBudget(config, methodName, [outcomeIndex, rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function creatorResolveDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'creator_resolve_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function adminResolveDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'admin_resolve_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function finalizeDispute(
  config: ClientConfig,
  outcomeIndex: number,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  return resolveDisputeCall(config, 'finalize_dispute', outcomeIndex, rulingHash, numOutcomes)
}

export async function abortEarlyResolution(
  config: ClientConfig,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const proposer = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'pr', 'proposer'))
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), proposer, challenger),
  ])
  return callWithBudget(config, 'abort_early_resolution', [rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}

export async function cancelDisputeAndMarket(
  config: ClientConfig,
  rulingHash: Uint8Array,
  numOutcomes = 2,
) {
  const gs = await readGlobalState(config.algodClient, config.appId)
  const challenger = decodeAddressStateValue(stateValue<Uint8Array>(gs, 'ch', 'challenger'))
  const qBoxes = deduplicateBoxes([
    ...marketBoxRefs(Number(config.appId), numOutcomes),
    ...payoutBoxRefs(Number(config.appId), challenger),
  ])
  return callWithBudget(config, 'cancel_dispute_and_market', [rulingHash], numOutcomes, 0, noopsFor(numOutcomes), {
    boxOverride: qBoxes,
  })
}
