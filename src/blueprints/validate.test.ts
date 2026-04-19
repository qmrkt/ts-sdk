import { describe, expect, it } from 'vitest'

import { SUPPORTED_LLM_MODEL_IDS } from './llm-models'
import { validateResolutionBlueprint } from './validate'
import type { ResolutionBlueprint, ResolutionBlueprintNodeDef } from './types'

function minimalBlueprint(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprint['edges'] = [],
): ResolutionBlueprint {
  return { id: 'test', version: 1, nodes, edges }
}

function awaitSignalNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: Record<string, unknown> }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'review',
    type: 'await_signal',
    config: {
      reason: 'Review this market.',
      signal_type: 'human_judgment.responded',
      timeout_seconds: 3600,
      required_payload: ['outcome'],
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

function returnNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: Record<string, unknown> }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'success',
    type: 'return',
    config: {
      value: {
        status: 'success',
        outcome: '{{results.review.outcome}}',
      },
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

function llmCallNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: Record<string, unknown> }> = {},
): ResolutionBlueprintNodeDef {
  const { config: configOverrides = {}, ...nodeOverrides } = overrides
  return {
    id: 'judge',
    type: 'llm_call',
    config: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      prompt: 'Judge this market.',
      allowed_outcomes_key: 'inputs.market.outcomes_json',
      timeout_seconds: 60,
      ...configOverrides,
    },
    ...nodeOverrides,
  } as ResolutionBlueprintNodeDef
}

function apiFetchNode(
  overrides: Partial<ResolutionBlueprintNodeDef & { config: Record<string, unknown> }> = {},
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

describe('await_signal validation', () => {
  it('passes for a valid await_signal -> return blueprint', () => {
    const result = validateResolutionBlueprint(
      minimalBlueprint(
        [awaitSignalNode(), returnNode()],
        [{ from: 'review', to: 'success', condition: "results.review.status == 'responded'" }],
      ),
    )

    expect(result.valid).toBe(true)
  })

  it('fails when signal_type is blank', () => {
    const result = validateResolutionBlueprint(
      minimalBlueprint(
        [awaitSignalNode({ config: { signal_type: '   ' } }), returnNode()],
        [{ from: 'review', to: 'success' }],
      ),
    )

    expect(result.issues.find((issue) => issue.code === 'AWAIT_SIGNAL_TYPE_REQUIRED')).toBeDefined()
  })
})

describe('llm_call provider validation', () => {
  it('passes for a supported explicit provider/model pair', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { provider: 'openai', model: SUPPORTED_LLM_MODEL_IDS.openai.gpt54 } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code.startsWith('LLM_'))).toBeUndefined()
  })

  it('passes when provider is omitted but model implies a supported provider', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { provider: undefined, model: SUPPORTED_LLM_MODEL_IDS.google.gemini31 } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code.startsWith('LLM_'))).toBeUndefined()
  })

  it('fails when provider and model families do not match', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { provider: 'anthropic', model: SUPPORTED_LLM_MODEL_IDS.openai.gpt54 } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'LLM_PROVIDER_MODEL_MISMATCH')).toBeDefined()
  })

  it('fails when model is unsupported', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { provider: 'openai', model: 'mystery-model-1' } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'LLM_MODEL_UNSUPPORTED')).toBeDefined()
  })

  it('fails when allowed_outcomes_key is blank or non-namespaced', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { allowed_outcomes_key: 'market.outcomes.json' } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'LLM_ALLOWED_OUTCOMES_KEY_INVALID')).toBeDefined()
  })

  it('fails when require_citations is still present', () => {
    const bp = minimalBlueprint(
      [llmCallNode({ config: { require_citations: true } }), returnNode()],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'LLM_REQUIRE_CITATIONS_REMOVED')).toBeDefined()
  })
})

describe('api_fetch outcome mapping validation', () => {
  it('fails when a mapped outcome is not numeric', () => {
    const bp = minimalBlueprint(
      [apiFetchNode({ config: { outcome_mapping: { yes: 'YES' } } }), returnNode()],
      [{ from: 'fetch', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp, { marketOutcomes: ['Yes', 'No'] })
    expect(result.issues.find((issue) => issue.code === 'API_OUTCOME_MAPPING_INVALID_INDEX')).toBeDefined()
  })

  it('fails when a mapped outcome is outside the market range', () => {
    const bp = minimalBlueprint(
      [apiFetchNode({ config: { outcome_mapping: { yes: '3' } } }), returnNode()],
      [{ from: 'fetch', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp, { marketOutcomes: ['Yes', 'No'] })
    expect(result.issues.find((issue) => issue.code === 'API_OUTCOME_MAPPING_UNKNOWN_OUTCOME')).toBeDefined()
  })
})

describe('return validation', () => {
  it('fails when from_key does not use a namespaced lookup key', () => {
    const bp = minimalBlueprint(
      [llmCallNode(), returnNode({ config: { from_key: 'judge.outcome', value: undefined } })],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'RETURN_FROM_KEY_INVALID')).toBeDefined()
  })

  it('fails when from_key references an unknown node', () => {
    const bp = minimalBlueprint(
      [llmCallNode(), returnNode({ config: { from_key: 'results.search.output_json', value: undefined } })],
      [{ from: 'judge', to: 'success' }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'RETURN_FROM_KEY_UNKNOWN_SOURCE')).toBeDefined()
  })

  it('fails when value.status is missing', () => {
    const bp = minimalBlueprint([
      awaitSignalNode(),
      returnNode({ config: { value: { outcome: '1' } } }),
    ], [{ from: 'review', to: 'success' }])

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'RETURN_STATUS_REQUIRED')).toBeDefined()
  })
})

describe('edge condition validation', () => {
  it('fails when a condition has malformed syntax', () => {
    const bp = minimalBlueprint(
      [awaitSignalNode(), returnNode()],
      [{ from: 'review', to: 'success', condition: "(results.review.status == 'responded'" }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'EDGE_CONDITION_INVALID')).toBeDefined()
  })

  it('fails when a condition references an unsupported root', () => {
    const bp = minimalBlueprint(
      [awaitSignalNode(), returnNode()],
      [{ from: 'review', to: 'success', condition: "market.status == 'open'" }],
    )

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'EDGE_CONDITION_UNKNOWN_ROOT')).toBeDefined()
  })
})

describe('inline child blueprint validation', () => {
  it('fails when map.inline contains a suspension-capable node', () => {
    const bp = minimalBlueprint([
      {
        id: 'fanout',
        type: 'map',
        config: {
          items_key: 'inputs.market.participant_evidence_json',
          inline: minimalBlueprint([
            awaitSignalNode(),
            returnNode(),
          ], [{ from: 'review', to: 'success' }]),
        },
      } as ResolutionBlueprintNodeDef,
      returnNode(),
    ], [{ from: 'fanout', to: 'success' }])

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'MAP_INLINE_SUSPENSION_NODE')).toBeDefined()
  })

  it('fails when gadget defines multiple blueprint sources', () => {
    const bp = minimalBlueprint([
      {
        id: 'tool',
        type: 'gadget',
        config: {
          blueprint_json: JSON.stringify(minimalBlueprint([returnNode()], [])),
          blueprint_json_key: 'inputs.dynamic_blueprint_json',
        },
      } as ResolutionBlueprintNodeDef,
      returnNode(),
    ], [{ from: 'tool', to: 'success' }])

    const result = validateResolutionBlueprint(bp)
    expect(result.issues.find((issue) => issue.code === 'GADGET_SOURCE_CONFLICT')).toBeDefined()
  })
})
