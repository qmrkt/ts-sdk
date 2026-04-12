import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EXECUTION_ASSURANCE_TIER,
  DEFAULT_RESOLUTION_CLASS,
  RESOLUTION_CLASS_AGENT_ASSISTED,
  RESOLUTION_CLASS_HUMAN_JUDGED,
  deriveResolutionClassFromBlueprint,
  normalizeIndexerLpStake,
  normalizeIndexerLpStakes,
  normalizeIndexerMarket,
} from '../market-schema'

describe('market schema LP helpers', () => {
  it('normalizes a single LP stake record', () => {
    expect(normalizeIndexerLpStake({
      appId: '42',
      address: 'ADDR',
      shares: 123,
      feeSnapshot: 4,
      claimableFees: 5,
    })).toEqual({
      appId: 42,
      address: 'ADDR',
      shares: '123',
      feeSnapshot: '4',
      claimableFees: '5',
    })
  })

  it('filters invalid LP stake rows from arrays', () => {
    expect(normalizeIndexerLpStakes([
      { appId: '11', address: 'A', shares: '100', feeSnapshot: '1', claimableFees: '2' },
      { appId: 0, address: 'B', shares: '200', feeSnapshot: '3', claimableFees: '4' },
      { appId: '12', address: '', shares: '300', feeSnapshot: '5', claimableFees: '6' },
    ])).toEqual([
      { appId: 11, address: 'A', shares: '100', feeSnapshot: '1', claimableFees: '2' },
    ])
  })

  it('normalizes LP skew-cap market fields', () => {
    expect(normalizeIndexerMarket({
      appId: '7',
      contractVersion: '4',
      question: 'Skew gated?',
      outcomes: ['Yes', 'No'],
      status: 1,
      numOutcomes: 2,
      b: '50000000',
      poolBalance: '60000000',
      lpSharesTotal: '50000000',
      lpFeeBps: 200,
      protocolFeeBps: 50,
      activationTimestamp: '123',
      deadline: '456',
      resolutionClass: '2',
      executionAssuranceTier: '1',
      lpEntryMaxPriceFp: '800000',
      prices: [510000, 490000],
    })).toMatchObject({
      appId: 7,
      activationTimestamp: 123,
      deadline: 456,
      resolutionClass: 2,
      executionAssuranceTier: 1,
      lpEntryMaxPriceFp: 800000,
      prices: [510000, 490000],
    })
  })

  it('defaults trust metadata when indexer rows omit it', () => {
    expect(normalizeIndexerMarket({
      appId: '8',
      contractVersion: '4',
      question: 'Fallback trust?',
      outcomes: ['Yes', 'No'],
      status: 1,
      numOutcomes: 2,
    })).toMatchObject({
      resolutionClass: DEFAULT_RESOLUTION_CLASS,
      executionAssuranceTier: DEFAULT_EXECUTION_ASSURANCE_TIER,
    })
  })

  it('clamps non-finite or oversized outcome counts from untrusted indexer rows', () => {
    expect(normalizeIndexerMarket({ numOutcomes: Number.POSITIVE_INFINITY }).numOutcomes).toBe(0)
    expect(normalizeIndexerMarket({ numOutcomes: 999 }).numOutcomes).toBe(16)
    expect(normalizeIndexerMarket({ numOutcomes: -5 }).numOutcomes).toBe(0)
  })

  it('derives resolution class from blueprint node types', () => {
    expect(deriveResolutionClassFromBlueprint(undefined)).toBe(DEFAULT_RESOLUTION_CLASS)
    expect(deriveResolutionClassFromBlueprint({ nodes: [{ type: 'api_fetch' }] })).toBe(DEFAULT_RESOLUTION_CLASS)
    expect(deriveResolutionClassFromBlueprint({ nodes: [{ type: 'llm_judge' }] })).toBe(
      RESOLUTION_CLASS_AGENT_ASSISTED,
    )
    expect(deriveResolutionClassFromBlueprint({ nodes: [{ type: 'human_judge' }, { type: 'llm_judge' }] })).toBe(
      RESOLUTION_CLASS_HUMAN_JUDGED,
    )
  })
})
