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
        type: 'llm_judge',
        config: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          prompt,
          timeout_seconds: 60,
        },
      },
      {
        id: 'submit',
        type: 'submit_result',
        config: {
          outcome_key: 'judge.outcome',
        },
      },
    ],
    edges: [{ from: 'judge', to: 'submit' }],
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
