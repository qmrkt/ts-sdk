import { describe, expect, it } from 'vitest'

import {
  hasRenderableBlueprint,
  inferResolutionBlueprintFallback,
} from './fallback'

describe('resolution blueprint fallback inference', () => {
  it('infers api fetch for automatic technical-check summaries', () => {
    const fallback = inferResolutionBlueprintFallback({
      summary:
        'This market resolves automatically based on a technical check of your app configuration. The system detects the app ID continuously without needing manual intervention.',
    })

    expect(fallback?.presetId).toBe('api_fetch')
    expect(fallback?.blueprint.nodes[0]?.type).toBe('api_fetch')
  })

  it('infers participant evidence flows when the summary mentions evidence windows', () => {
    const fallback = inferResolutionBlueprintFallback({
      summary:
        'Collect signed participant evidence during the evidence window, then ask a model to judge the claimed outcome summary.',
    })

    expect(fallback?.presetId).toBe('participant_evidence_llm')
    expect(fallback?.blueprint.nodes.some((node) => node.type === 'market_evidence')).toBe(true)
  })

  it('falls back to human judge when metadata points at a manual resolver', () => {
    const fallback = inferResolutionBlueprintFallback({
      resolutionAuthority: 'ADDR1',
      creator: 'ADDR1',
      marketAdmin: 'ADDR2',
    })

    expect(fallback?.presetId).toBe('human_judge')
    expect(fallback?.blueprint.nodes[0]?.type).toBe('human_judge')
  })

  it('treats empty blueprints as non-renderable', () => {
    expect(hasRenderableBlueprint(null)).toBe(false)
    expect(
      hasRenderableBlueprint({
        id: 'empty',
        version: 1,
        nodes: [],
        edges: [],
      }),
    ).toBe(false)
  })
})
