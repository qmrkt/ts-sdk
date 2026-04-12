import algosdk from 'algosdk'
import { type ClientConfig, loadMethods, callMethod, readGlobalState } from './base.js'
import { protocolConfigSpec as spec } from './contract-specs.js'

const methods = loadMethods(spec)

export interface ProtocolConfig {
  admin: string
  minBootstrapDeposit: bigint
  challengeBond: bigint
  proposalBond: bigint
  challengeBondBps: number
  proposalBondBps: number
  challengeBondCap: bigint
  proposalBondCap: bigint
  proposerFeeBps: number
  proposerFeeFloorBps: number
  defaultB: bigint
  protocolFeeBps: number
  protocolFeeCeilingBps: number
  protocolTreasury: string
  marketFactoryId: number
  maxOutcomes: number
  minChallengeWindowSecs: number
  minGracePeriodSecs: number
  maxLpFeeBps: number
}

/**
 * Read the full ProtocolConfig global state.
 */
export async function readConfig(
  algod: algosdk.Algodv2,
  appId: number | bigint,
): Promise<ProtocolConfig> {
  const gs = await readGlobalState(algod, appId)
  const stateValue = <T>(...keys: string[]): T | undefined => {
    for (const key of keys) {
      const value = gs[key]
      if (value !== undefined) return value as T
    }
    return undefined
  }

  return {
    admin: algosdk.encodeAddress(stateValue<Uint8Array>('admin') ?? new Uint8Array(32)),
    minBootstrapDeposit: stateValue<bigint>('min_bootstrap_deposit') ?? 0n,
    challengeBond: stateValue<bigint>('cb', 'challenge_bond') ?? 0n,
    proposalBond: stateValue<bigint>('pb', 'proposal_bond') ?? 0n,
    challengeBondBps: Number(stateValue<bigint>('cbb', 'challenge_bond_bps') ?? 0n),
    proposalBondBps: Number(stateValue<bigint>('pbb', 'proposal_bond_bps') ?? 0n),
    challengeBondCap: stateValue<bigint>('cbc', 'challenge_bond_cap') ?? 0n,
    proposalBondCap: stateValue<bigint>('pbc', 'proposal_bond_cap') ?? 0n,
    proposerFeeBps: Number(stateValue<bigint>('pfd', 'proposer_fee_bps') ?? 0n),
    proposerFeeFloorBps: Number(stateValue<bigint>('pff', 'proposer_fee_floor_bps') ?? 0n),
    defaultB: stateValue<bigint>('default_b') ?? 0n,
    protocolFeeBps: Number(stateValue<bigint>('pfb', 'protocol_fee_bps') ?? 0n),
    protocolFeeCeilingBps: Number(stateValue<bigint>('protocol_fee_ceiling_bps') ?? 0n),
    protocolTreasury: algosdk.encodeAddress(stateValue<Uint8Array>('pt', 'protocol_treasury') ?? new Uint8Array(32)),
    marketFactoryId: Number(stateValue<bigint>('mfi', 'market_factory_id') ?? 0n),
    maxOutcomes: Number(stateValue<bigint>('max_outcomes') ?? 0n),
    minChallengeWindowSecs: Number(stateValue<bigint>('mcw', 'min_challenge_window_secs') ?? 0n),
    minGracePeriodSecs: Number(stateValue<bigint>('min_grace_period_secs') ?? 0n),
    maxLpFeeBps: Number(stateValue<bigint>('max_lp_fee_bps') ?? 0n),
  }
}

/**
 * Update the market_factory_id in ProtocolConfig.
 * Must be called by admin.
 */
export async function updateMarketFactoryId(
  config: ClientConfig,
  factoryAppId: number | bigint,
) {
  return callMethod(config, methods, 'update_market_factory_id', [BigInt(factoryAppId)])
}

export async function updateMaxOutcomes(
  config: ClientConfig,
  maxOutcomes: number | bigint,
) {
  return callMethod(config, methods, 'update_max_outcomes', [BigInt(maxOutcomes)])
}
