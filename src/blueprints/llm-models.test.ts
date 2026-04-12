import { describe, expect, it } from 'vitest'

import {
  describeLLMSelection,
  getDefaultLLMModel,
  inferLLMProviderFromModel,
  normalizeLLMSelection,
} from './llm-models'

describe('llm model helpers', () => {
  it('infers providers from model ids', () => {
    expect(inferLLMProviderFromModel('claude-sonnet-4-6')).toBe('anthropic')
    expect(inferLLMProviderFromModel('gpt-4o')).toBe('openai')
    expect(inferLLMProviderFromModel('gemini-2.5-pro')).toBe('google')
  })

  it('normalizes missing models to provider defaults', () => {
    expect(normalizeLLMSelection({ provider: 'openai', model: '' })).toEqual({
      provider: 'openai',
      model: getDefaultLLMModel('openai'),
    })
  })

  it('preserves the imported model even when it mismatches the selected provider', () => {
    expect(normalizeLLMSelection({ provider: 'anthropic', model: 'gpt-4o' })).toEqual({
      provider: 'anthropic',
      model: 'gpt-4o',
    })
  })

  it('describes a normalized selection for UI summaries', () => {
    expect(describeLLMSelection({ provider: 'google', model: 'gemini-2.5-pro' })).toContain('Google')
    expect(describeLLMSelection({ provider: 'google', model: 'gemini-2.5-pro' })).toContain('Gemini 2.5 Pro')
  })
})
