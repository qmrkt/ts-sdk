import { describe, expect, it } from 'vitest'

import {
  AtomicCreateUnsupportedError,
  MAX_ACTIVE_LP_OUTCOMES,
  buildCreateMarketMethodArgs,
  createMarket,
  getChallengeWindowSupportError,
  getAtomicCreateOutcomeLimit,
  lmsrBootstrapMultiplier,
  minimumBootstrapDeposit,
  type CreateMarketParams,
} from '../market-factory'
import type { ClientConfig } from '../base'

function dummyConfig(): ClientConfig {
  return {
    algodClient: {} as ClientConfig['algodClient'],
    appId: 1,
    sender: 'TESTADDR',
    signer: {} as ClientConfig['signer'],
  }
}

function dummyParams(): CreateMarketParams {
  return {
    creator: 'TESTADDR',
    currencyAsa: 123,
    questionHash: new TextEncoder().encode('Disabled sequential create'),
    numOutcomes: 2,
    initialB: 0n,
    lpFeeBps: 200,
    blueprintHash: new TextEncoder().encode('legacy-disabled'),
    deadline: 1_900_000_000,
    challengeWindowSecs: 3600,
    cancellable: true,
    bootstrapDeposit: 50_000_000n,
    protocolConfigAppId: 456,
  }
}

describe('market-factory safety guards', () => {
  it('reports the canonical atomic create outcome cap', () => {
    expect(getAtomicCreateOutcomeLimit()).toBe(MAX_ACTIVE_LP_OUTCOMES)
  })

  it('fails closed for the generic sequential create helper', async () => {
    await expect(createMarket(dummyConfig(), dummyParams())).rejects.toBeInstanceOf(
      AtomicCreateUnsupportedError,
    )
    await expect(createMarket(dummyConfig(), dummyParams())).rejects.toThrow(
      /createMarket\(\) is disabled/i,
    )
  })

  it('computes the shared LMSR bootstrap floor across outcome bands', () => {
    expect(lmsrBootstrapMultiplier(2)).toBe(1n)
    expect(lmsrBootstrapMultiplier(3)).toBe(2n)
    expect(lmsrBootstrapMultiplier(7)).toBe(2n)
    expect(lmsrBootstrapMultiplier(8)).toBe(3n)

    expect(minimumBootstrapDeposit(50_000_000n, 2)).toBe(50_000_000n)
    expect(minimumBootstrapDeposit(50_000_000n, 3)).toBe(100_000_000n)
    expect(minimumBootstrapDeposit(50_000_000n, 8)).toBe(150_000_000n)
  })

  it('rejects challenge windows below the protocol floor before signing', () => {
    expect(getChallengeWindowSupportError(3_600, 86_400)).toContain('at least 86400 seconds')
    expect(getChallengeWindowSupportError(86_400, 86_400)).toBeUndefined()
    expect(getChallengeWindowSupportError(172_800, 86_400)).toBeUndefined()
  })

  it('builds the canonical factory ABI args without legacy creator/bootstrap slots', () => {
    const params = dummyParams()
    const args = buildCreateMarketMethodArgs(
      {
        ...params,
        creator: undefined,
        marketAdmin: undefined,
        lpEntryMaxPriceFp: 800_000n,
      },
      'SENDERADDR',
    )

    expect(args).toHaveLength(13)
    expect(args[0]).toBe(123n)
    expect(args[1]).toBe(params.questionHash)
    expect(args[2]).toBe(2n)
    expect(args[9]).toBe('SENDERADDR')
    expect(args[12]).toBe(800_000n)
  })
})
