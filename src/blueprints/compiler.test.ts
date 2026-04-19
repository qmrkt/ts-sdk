import { describe, expect, it } from 'vitest'

import { compileResolutionBlueprint } from './compiler'
import type { ResolutionBlueprint } from './types'

function baseBlueprint(prompt: string): ResolutionBlueprint {
  return {
    id: 'llm-byte-test',
    version: 1,
    nodes: [
      {
        id: 'judge',
        type: 'llm_call',
        config: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          prompt,
          allowed_outcomes_key: 'inputs.market.outcomes_json',
          timeout_seconds: 60,
        },
      },
      {
        id: 'success',
        type: 'return',
        config: {
          value: {
            status: 'success',
            outcome: '{{results.judge.outcome}}',
          },
        },
      },
    ],
    edges: [{ from: 'judge', to: 'success' }],
  }
}

describe('compileResolutionBlueprint', () => {
  it('returns encoded bytes for a valid blueprint', () => {
    const compiled = compileResolutionBlueprint(baseBlueprint('Question: {{market.question}}'), {
      question: 'Did it happen?',
      outcomes: ['Yes', 'No'],
      deadline: 1_700_000_000,
    })

    expect(compiled.bytes.length).toBeGreaterThan(0)
    expect(compiled.blueprint.nodes[0]?.position).toBeUndefined()
    expect((compiled.blueprint.nodes[0]?.config as { prompt?: string }).prompt).toContain('Did it happen?')
  })

  it('enforces the 8KB limit by UTF-8 byte length', () => {
    const oversizedPrompt = `Question: ${'é'.repeat(5000)}`

    expect(() =>
      compileResolutionBlueprint(baseBlueprint(oversizedPrompt), {
        question: 'Did it happen?',
        outcomes: ['Yes', 'No'],
        deadline: 1_700_000_000,
      }),
    ).toThrow(/8KB limit/)
  })
})
