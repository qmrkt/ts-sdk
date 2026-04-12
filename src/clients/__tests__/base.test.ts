import algosdk from 'algosdk'
import { describe, expect, it } from 'vitest'

import {
  bootstrapBoxRefs,
  boxName,
  boxNameAddr,
  boxNameAddrIdx,
  ceilDiv,
  marketBoxRefs,
  pricingBoxRefs,
  withExplicitFlatFee,
  withMinFlatFee,
} from '../base'

describe('base client helpers', () => {
  it('rounds up bigint division for protocol math helpers', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n)
    expect(ceilDiv(1n, 7n)).toBe(1n)
    expect(ceilDiv(8n, 7n)).toBe(2n)
    expect(ceilDiv(17n, 8n)).toBe(3n)
  })

  it('normalizes suggested params into explicit flat fees', () => {
    const suggestedParams = {
      fee: 3_000n,
      firstValid: 1n,
      lastValid: 2n,
      genesisHash: 'abc',
      genesisID: 'localnet-v1',
    } as algosdk.SuggestedParams

    expect(withMinFlatFee(suggestedParams)).toMatchObject({
      flatFee: true,
      fee: 1_000n,
    })
    expect(withMinFlatFee(suggestedParams, 3n)).toMatchObject({
      flatFee: true,
      fee: 3_000n,
    })
    expect(withMinFlatFee({ ...suggestedParams, fee: 0n })).toMatchObject({
      flatFee: true,
      fee: 1_000n,
    })
    expect(withExplicitFlatFee(suggestedParams, 7_000n)).toMatchObject({
      flatFee: true,
      fee: 7_000n,
    })
  })

  it('builds deterministic pricing, trade, and bootstrap box refs', () => {
    const appId = 42
    const sender = algosdk.getApplicationAddress(7).toString()

    const pricingRefs = pricingBoxRefs(appId, 3)
    expect(pricingRefs).toHaveLength(3)
    expect(pricingRefs).toEqual([
      { appIndex: appId, name: boxName('q', 0) },
      { appIndex: appId, name: boxName('q', 1) },
      { appIndex: appId, name: boxName('q', 2) },
    ])

    const tradeRefs = marketBoxRefs(appId, 3, sender, 1)
    expect(tradeRefs).toHaveLength(7)
    expect(tradeRefs[3]).toEqual({ appIndex: appId, name: new TextEncoder().encode('tus') })
    expect(tradeRefs[4]).toEqual({ appIndex: appId, name: boxNameAddrIdx('us:', sender, 1) })
    expect(tradeRefs[5]).toEqual({ appIndex: appId, name: boxNameAddrIdx('uc:', sender, 1) })
    expect(tradeRefs[6]).toEqual({ appIndex: appId, name: boxNameAddr('uf:', sender) })

    const bootstrapRefs = bootstrapBoxRefs(appId, 3)
    expect(bootstrapRefs).toEqual([
      { appIndex: appId, name: boxName('q', 0) },
      { appIndex: appId, name: boxName('q', 1) },
      { appIndex: appId, name: boxName('q', 2) },
      { appIndex: appId, name: new TextEncoder().encode('tus') },
      { appIndex: appId, name: new TextEncoder().encode('mb') },
      { appIndex: appId, name: new TextEncoder().encode('db') },
    ])
  })
})
