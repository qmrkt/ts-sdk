import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const baseMocks = vi.hoisted(() => ({
  marketBoxRefs: vi.fn(),
  readGlobalState: vi.fn(),
}))

const internalMocks = vi.hoisted(() => ({
  buildAsaOptInIfNeeded: vi.fn(),
  callWithBudget: vi.fn(),
  decodeAddressStateValue: vi.fn(),
  deduplicateBoxes: vi.fn(),
  getLatestBlockTimestamp: vi.fn(),
  makeAssetTransfer: vi.fn(),
  noopsFor: vi.fn(),
  payoutBoxRefs: vi.fn(),
  requiredBondFromState: vi.fn(),
  stateValue: vi.fn(),
}))

vi.mock('../base.js', async () => {
  const actual = await vi.importActual<typeof import('../base')>('../base.js')
  return {
    ...actual,
    marketBoxRefs: baseMocks.marketBoxRefs,
    readGlobalState: baseMocks.readGlobalState,
  }
})

vi.mock('../question-market/internal.js', () => ({
  buildAsaOptInIfNeeded: internalMocks.buildAsaOptInIfNeeded,
  callWithBudget: internalMocks.callWithBudget,
  decodeAddressStateValue: internalMocks.decodeAddressStateValue,
  deduplicateBoxes: internalMocks.deduplicateBoxes,
  getLatestBlockTimestamp: internalMocks.getLatestBlockTimestamp,
  makeAssetTransfer: internalMocks.makeAssetTransfer,
  noopsFor: internalMocks.noopsFor,
  payoutBoxRefs: internalMocks.payoutBoxRefs,
  requiredBondFromState: internalMocks.requiredBondFromState,
  stateValue: internalMocks.stateValue,
}))

import {
  finalizeResolution,
  proposeResolution,
  triggerResolution,
} from '../question-market/resolution'

function makeConfig() {
  const sender = algosdk.getApplicationAddress(703).toString()
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
    appId: 91,
    sender,
    signer: vi.fn() as any,
  }
}

describe('question-market resolution wrappers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    internalMocks.noopsFor.mockReturnValue(14)
    internalMocks.stateValue.mockImplementation((state: Record<string, unknown>, ...keys: string[]) => {
      for (const key of keys) {
        if (key in state) return state[key]
      }
      return undefined
    })
    internalMocks.decodeAddressStateValue.mockImplementation((value: unknown) => {
      if (!(value instanceof Uint8Array) || value.length !== 32) return undefined
      return algosdk.encodeAddress(value)
    })
    internalMocks.deduplicateBoxes.mockImplementation((refs: Array<{ appIndex: number; name: Uint8Array }>) => {
      const seen = new Set<string>()
      return refs.filter((ref) => {
        const key = `${ref.appIndex}:${Buffer.from(ref.name).toString('hex')}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
    baseMocks.marketBoxRefs.mockReturnValue([{ appIndex: 91, name: new Uint8Array([1]) }])
    internalMocks.payoutBoxRefs.mockReturnValue([{ appIndex: 91, name: new Uint8Array([2]) }])
  })

  it('rejects triggerResolution while the market is still active before deadline', async () => {
    const config = makeConfig()
    baseMocks.readGlobalState.mockResolvedValue({ st: 1n, dl: 500n })
    internalMocks.getLatestBlockTimestamp.mockResolvedValue(499)

    await expect(triggerResolution(config, 2)).rejects.toThrow(/deadline has not passed/i)
    expect(internalMocks.callWithBudget).not.toHaveBeenCalled()
  })

  it('routes triggerResolution through callWithBudget once the deadline has passed', async () => {
    const config = makeConfig()
    baseMocks.readGlobalState.mockResolvedValue({ st: 1n, dl: 500n })
    internalMocks.getLatestBlockTimestamp.mockResolvedValue(500)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'trigger-tx' })

    await triggerResolution(config, 2)

    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'trigger_resolution',
      [],
      2,
      0,
      14,
      { boxOverride: [{ appIndex: 91, name: new Uint8Array([1]) }] },
    )
  })

  it('uses a zero proposal bond for the resolution authority and prepends the asset opt-in', async () => {
    const config = makeConfig()
    const resolutionAuthority = algosdk.decodeAddress(config.sender).publicKey
    const evidenceHash = new Uint8Array([9, 9, 9])
    const optInTxn = { txn: { kind: 'asa-opt-in' }, signer: config.signer }
    const bondTxn = { kind: 'bond' }
    baseMocks.readGlobalState.mockResolvedValue({
      ca: 31566704n,
      ra: resolutionAuthority,
      prb: 10n,
      pbb: 200n,
      pbc: 20n,
      pb: 100n,
      bd: 50n,
    })
    internalMocks.buildAsaOptInIfNeeded.mockResolvedValue(optInTxn)
    internalMocks.makeAssetTransfer.mockReturnValue(bondTxn)
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'proposal-tx' })

    await proposeResolution(config, 1, evidenceHash, 2)

    expect(internalMocks.requiredBondFromState).not.toHaveBeenCalled()
    expect(internalMocks.makeAssetTransfer).toHaveBeenCalledWith(
      config.sender,
      algosdk.getApplicationAddress(Number(config.appId)).toString(),
      31566704,
      0n,
      expect.any(Object),
    )
    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'propose_resolution',
      [1, evidenceHash, { txn: bondTxn, signer: config.signer }],
      2,
      0,
      14,
      {
        boxOverride: [{ appIndex: 91, name: new Uint8Array([1]) }],
        prependTxns: [optInTxn],
      },
    )
  })

  it('adds proposer payout boxes when finalizing resolution', async () => {
    const config = makeConfig()
    const proposer = algosdk.getApplicationAddress(704).toString()
    baseMocks.readGlobalState.mockResolvedValue({
      pr: algosdk.decodeAddress(proposer).publicKey,
    })
    internalMocks.callWithBudget.mockResolvedValue({ txId: 'finalize-tx' })

    await finalizeResolution(config, 2)

    expect(internalMocks.payoutBoxRefs).toHaveBeenCalledWith(Number(config.appId), proposer)
    expect(internalMocks.callWithBudget).toHaveBeenCalledWith(
      config,
      'finalize_resolution',
      [],
      2,
      0,
      14,
      {
        boxOverride: [
          { appIndex: 91, name: new Uint8Array([1]) },
          { appIndex: 91, name: new Uint8Array([2]) },
        ],
      },
    )
  })
})
