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

  it('infers api fetch + wait when the summary mentions a grace window', () => {
    const fallback = inferResolutionBlueprintFallback({
      summary:
        'Fetch the authoritative API result, wait through the grace period, then resolve automatically.',
    })

    expect(fallback?.presetId).toBe('api_fetch_wait')
    expect(fallback?.blueprint.nodes.some((node) => node.type === 'wait')).toBe(true)
  })

  it('infers validate + gadget flows for dynamic blueprint summaries', () => {
    const fallback = inferResolutionBlueprintFallback({
      summary:
        'Validate blueprint JSON supplied at runtime, then execute the child blueprint through a gadget node.',
    })

    expect(fallback?.presetId).toBe('validate_blueprint_gadget')
    expect(fallback?.blueprint.nodes.some((node) => node.type === 'gadget')).toBe(true)
  })

  it('falls back to await_signal when metadata points at a manual resolver', () => {
    const fallback = inferResolutionBlueprintFallback({
      resolutionAuthority: 'ADDR1',
      creator: 'ADDR1',
      marketAdmin: 'ADDR2',
    })

    expect(fallback?.presetId).toBe('await_signal')
    expect(fallback?.blueprint.nodes[0]?.type).toBe('await_signal')
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
