import { describe, expect, it } from 'vitest'

import {
  describeLLMSelection,
  getDefaultLLMModel,
  inferLLMProviderFromModel,
  normalizeLLMSelection,
  SUPPORTED_LLM_MODEL_IDS,
} from './llm-models'

describe('llm model helpers', () => {
  it('infers providers from model ids', () => {
    expect(inferLLMProviderFromModel(SUPPORTED_LLM_MODEL_IDS.anthropic.sonnet46)).toBe('anthropic')
    expect(inferLLMProviderFromModel(SUPPORTED_LLM_MODEL_IDS.openai.gpt54)).toBe('openai')
    expect(inferLLMProviderFromModel(SUPPORTED_LLM_MODEL_IDS.google.gemini31)).toBe('google')
  })

  it('normalizes missing models to provider defaults', () => {
    expect(normalizeLLMSelection({ provider: 'openai', model: '' })).toEqual({
      provider: 'openai',
      model: getDefaultLLMModel('openai'),
    })
  })

  it('preserves the imported model even when it mismatches the selected provider', () => {
    expect(normalizeLLMSelection({ provider: 'anthropic', model: SUPPORTED_LLM_MODEL_IDS.openai.gpt54 })).toEqual({
      provider: 'anthropic',
      model: SUPPORTED_LLM_MODEL_IDS.openai.gpt54,
    })
  })

  it('describes a normalized selection for UI summaries', () => {
    expect(describeLLMSelection({ provider: 'google', model: SUPPORTED_LLM_MODEL_IDS.google.gemini31 })).toContain(
      'Google',
    )
    expect(describeLLMSelection({ provider: 'google', model: SUPPORTED_LLM_MODEL_IDS.google.gemini31 })).toContain(
      'Gemini 3.1',
    )
  })
})
