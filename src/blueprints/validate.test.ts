import { describe, expect, it } from 'vitest'
import { validateResolutionBlueprint } from './validate'
import type { ResolutionBlueprint, ResolutionBlueprintNodeDef } from './types'

function minimalBlueprint(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprint['edges'] = [],
): ResolutionBlueprint {
  return { id: 'test', version: 1, nodes, edges }
}

function humanJudgeNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: any }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'judge',
    type: 'human_judge',
    config: {
      prompt: 'Resolve this.',
      allowed_responders: ['creator'],
      timeout_seconds: 3600,
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

function submitNode(): ResolutionBlueprintNodeDef {
  return {
    id: 'submit',
    type: 'submit_result',
    config: { outcome_key: 'judge.outcome' },
  } as ResolutionBlueprintNodeDef
}

function llmJudgeNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: any }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'judge',
    type: 'llm_judge',
    config: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      prompt: 'Judge this market.',
      timeout_seconds: 60,
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

function apiFetchNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: any }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'fetch',
    type: 'api_fetch',
    config: {
      url: 'https://example.com/result',
      json_path: 'data.outcome',
      outcome_mapping: { yes: '0' },
      timeout_seconds: 30,
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

describe('human_judge designated_address validation', () => {
  it('passes when designated role has an address', () => {
    const bp = minimalBlueprint(
      [
        humanJudgeNode({
          config: {
            prompt: 'Resolve this.',
            allowed_responders: ['designated'],
            designated_address: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
            timeout_seconds: 3600,
          },
        }),
        submitNode(),
      ],
      [{ from: 'judge', to: 'submit' }],
    )
    const result = validateResolutionBlueprint(bp)
    const designatedIssue = result.issues.find((i) => i.code === 'HUMAN_DESIGNATED_ADDRESS_REQUIRED')
    expect(designatedIssue).toBeUndefined()
  })

  it('fails when designated role has no address', () => {
    const bp = minimalBlueprint(
      [
        humanJudgeNode({
          config: {
            prompt: 'Resolve this.',
            allowed_responders: ['designated'],
            timeout_seconds: 3600,
          },
        }),
        submitNode(),
      ],
      [{ from: 'judge', to: 'submit' }],
    )
    const result = validateResolutionBlueprint(bp)
    const designatedIssue = result.issues.find((i) => i.code === 'HUMAN_DESIGNATED_ADDRESS_REQUIRED')
    expect(designatedIssue).toBeDefined()
    expect(designatedIssue!.severity).toBe('error')
  })

  it('fails when designated role has empty address', () => {
    const bp = minimalBlueprint(
      [
        humanJudgeNode({
          config: {
            prompt: 'Resolve this.',
            allowed_responders: ['designated'],
            designated_address: '   ',
            timeout_seconds: 3600,
          },
        }),
        submitNode(),
      ],
      [{ from: 'judge', to: 'submit' }],
    )
    const result = validateResolutionBlueprint(bp)
    const designatedIssue = result.issues.find((i) => i.code === 'HUMAN_DESIGNATED_ADDRESS_REQUIRED')
    expect(designatedIssue).toBeDefined()
  })

  it('does not require address when only creator/protocol_admin roles are used', () => {
    const bp = minimalBlueprint(
      [
        humanJudgeNode({
          config: {
            prompt: 'Resolve this.',
            allowed_responders: ['creator', 'protocol_admin'],
            timeout_seconds: 3600,
          },
        }),
        submitNode(),
      ],
      [{ from: 'judge', to: 'submit' }],
    )
    const result = validateResolutionBlueprint(bp)
    const designatedIssue = result.issues.find((i) => i.code === 'HUMAN_DESIGNATED_ADDRESS_REQUIRED')
    expect(designatedIssue).toBeUndefined()
  })

  it('fails when designated address is not a valid Algorand address', () => {
    const bp = minimalBlueprint(
      [
        humanJudgeNode({
          config: {
            prompt: 'Resolve this.',
            allowed_responders: ['designated'],
            designated_address: 'not-an-address',
            timeout_seconds: 3600,
          },
        }),
        submitNode(),
      ],
      [{ from: 'judge', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp)
    const invalidAddressIssue = result.issues.find((i) => i.code === 'HUMAN_DESIGNATED_ADDRESS_INVALID')
    expect(invalidAddressIssue).toBeDefined()
    expect(invalidAddressIssue!.severity).toBe('error')
  })
})

describe('llm_judge provider validation', () => {
  it('passes for a supported explicit provider/model pair', () => {
    const bp = minimalBlueprint(
      [llmJudgeNode({ config: { provider: 'openai', model: 'gpt-4o' } }), submitNode()],
      [{ from: 'judge', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code.startsWith('LLM_'))).toBeUndefined()
  })

  it('passes when provider is omitted but model implies a supported provider', () => {
    const bp = minimalBlueprint(
      [llmJudgeNode({ config: { provider: undefined, model: 'gemini-2.5-pro' } }), submitNode()],
      [{ from: 'judge', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code.startsWith('LLM_'))).toBeUndefined()
  })

  it('fails when provider and model families do not match', () => {
    const bp = minimalBlueprint(
      [llmJudgeNode({ config: { provider: 'anthropic', model: 'gpt-4o' } }), submitNode()],
      [{ from: 'judge', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'LLM_PROVIDER_MODEL_MISMATCH')).toBeDefined()
  })

  it('fails when model is unsupported', () => {
    const bp = minimalBlueprint(
      [llmJudgeNode({ config: { provider: 'openai', model: 'mystery-model-1' } }), submitNode()],
      [{ from: 'judge', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'LLM_MODEL_UNSUPPORTED')).toBeDefined()
  })
})

describe('api_fetch outcome mapping validation', () => {
  it('fails when a mapped outcome is not numeric', () => {
    const bp = minimalBlueprint(
      [apiFetchNode({ config: { outcome_mapping: { yes: 'YES' } } }), submitNode()],
      [{ from: 'fetch', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp, { marketOutcomes: ['Yes', 'No'] })
    expect(result.issues.find((i) => i.code === 'API_OUTCOME_MAPPING_INVALID_INDEX')).toBeDefined()
  })

  it('fails when a mapped outcome is outside the market range', () => {
    const bp = minimalBlueprint(
      [apiFetchNode({ config: { outcome_mapping: { yes: '3' } } }), submitNode()],
      [{ from: 'fetch', to: 'submit' }],
    )

    const result = validateResolutionBlueprint(bp, { marketOutcomes: ['Yes', 'No'] })
    expect(result.issues.find((i) => i.code === 'API_OUTCOME_MAPPING_UNKNOWN_OUTCOME')).toBeDefined()
  })
})

describe('submit_result outcome source validation', () => {
  it('fails when outcome_key does not reference a context field', () => {
    const bp = minimalBlueprint([
      humanJudgeNode(),
      {
        id: 'submit',
        type: 'submit_result',
        config: { outcome_key: 'judge' },
      } as ResolutionBlueprintNodeDef,
    ], [{ from: 'judge', to: 'submit' }])

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'SUBMIT_OUTCOME_KEY_INVALID')).toBeDefined()
  })

  it('fails when outcome_key references an unknown node', () => {
    const bp = minimalBlueprint([
      humanJudgeNode(),
      {
        id: 'submit',
        type: 'submit_result',
        config: { outcome_key: 'search.outcome' },
      } as ResolutionBlueprintNodeDef,
    ], [{ from: 'judge', to: 'submit' }])

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'SUBMIT_OUTCOME_KEY_UNKNOWN_SOURCE')).toBeDefined()
  })
})

describe('edge condition validation', () => {
  it('fails when a condition has malformed syntax', () => {
    const bp = minimalBlueprint(
      [humanJudgeNode(), submitNode()],
      [{ from: 'judge', to: 'submit', condition: "(judge.status == 'responded'" }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'EDGE_CONDITION_INVALID')).toBeDefined()
  })

  it('fails when a condition references an unknown context root', () => {
    const bp = minimalBlueprint(
      [humanJudgeNode(), submitNode()],
      [{ from: 'judge', to: 'submit', condition: "search.status == 'success'" }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((i) => i.code === 'EDGE_CONDITION_UNKNOWN_SOURCE')).toBeDefined()
  })
})
