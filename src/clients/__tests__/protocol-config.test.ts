import algosdk from 'algosdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const baseMocks = vi.hoisted(() => ({
  callMethod: vi.fn(),
  loadMethods: vi.fn(() => new Map()),
  readGlobalState: vi.fn(),
}))

vi.mock('../base.js', () => ({
  callMethod: baseMocks.callMethod,
  loadMethods: baseMocks.loadMethods,
  readGlobalState: baseMocks.readGlobalState,
}))

import { readConfig, updateMarketFactoryId, updateMaxOutcomes } from '../protocol-config'

describe('protocol-config client helpers', () => {
  const admin = algosdk.getApplicationAddress(1).toString()
  const treasury = algosdk.getApplicationAddress(2).toString()
  const config = {
    algodClient: {} as any,
    appId: 77,
    sender: admin,
    signer: vi.fn() as any,
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('maps aliased global-state keys into the public config shape', async () => {
    baseMocks.readGlobalState.mockResolvedValue({
      admin: algosdk.decodeAddress(admin).publicKey,
      min_bootstrap_deposit: 50_000_000n,
      cb: 1_000_000n,
      pb: 2_000_000n,
      cbb: 300n,
      pbb: 400n,
      cbc: 3_000_000n,
      pbc: 4_000_000n,
      pfd: 50n,
      pff: 25n,
      default_b: 10_000_000n,
      pfb: 125n,
      protocol_fee_ceiling_bps: 500n,
      pt: algosdk.decodeAddress(treasury).publicKey,
      mfi: 91n,
      max_outcomes: 8n,
      mcw: 86_400n,
      min_grace_period_secs: 3_600n,
      max_lp_fee_bps: 750n,
    })

    await expect(readConfig({} as algosdk.Algodv2, 99)).resolves.toEqual({
      admin,
      minBootstrapDeposit: 50_000_000n,
      challengeBond: 1_000_000n,
      proposalBond: 2_000_000n,
      challengeBondBps: 300,
      proposalBondBps: 400,
      challengeBondCap: 3_000_000n,
      proposalBondCap: 4_000_000n,
      proposerFeeBps: 50,
      proposerFeeFloorBps: 25,
      defaultB: 10_000_000n,
      protocolFeeBps: 125,
      protocolFeeCeilingBps: 500,
      protocolTreasury: treasury,
      marketFactoryId: 91,
      maxOutcomes: 8,
      minChallengeWindowSecs: 86_400,
      minGracePeriodSecs: 3_600,
      maxLpFeeBps: 750,
    })
  })

  it('delegates admin update helpers through callMethod with bigint args', async () => {
    baseMocks.callMethod.mockResolvedValue({ txID: 'tx-id' })

    await updateMarketFactoryId(config, 123)
    await updateMaxOutcomes(config, 16)

    expect(baseMocks.callMethod).toHaveBeenNthCalledWith(
      1,
      config,
      expect.any(Map),
      'update_market_factory_id',
      [123n],
    )
    expect(baseMocks.callMethod).toHaveBeenNthCalledWith(
      2,
      config,
      expect.any(Map),
      'update_max_outcomes',
      [16n],
    )
  })
})
