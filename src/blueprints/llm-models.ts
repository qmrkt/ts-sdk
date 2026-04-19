import { LLM_PROVIDERS } from './types.js'
import type { LLMProvider } from './types.js'

export interface LLMModelOption {
  provider: LLMProvider
  value: string
  label: string
  default?: boolean
}

export const LLM_PROVIDER_LABELS: Record<LLMProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}

export const SUPPORTED_LLM_MODEL_IDS = {
  anthropic: {
    opus46: 'claude-opus-4-6',
    sonnet46: 'claude-sonnet-4-6',
    haiku45: 'claude-haiku-4-5-20251001',
  },
  openai: {
    gpt54: 'gpt-5.4',
    gpt54Mini: 'gpt-5.4-mini',
  },
  google: {
    gemini31: 'gemini-3.1-pro-preview',
    gemini31FlashPreview: 'gemini-3.1-flash-lite-preview',
  },
} as const

export const LLM_MODEL_OPTIONS: readonly LLMModelOption[] = [
  { provider: 'anthropic', value: SUPPORTED_LLM_MODEL_IDS.anthropic.opus46, label: 'Claude Opus 4.6' },
  {
    provider: 'anthropic',
    value: SUPPORTED_LLM_MODEL_IDS.anthropic.sonnet46,
    label: 'Claude Sonnet 4.6',
    default: true,
  },
  { provider: 'anthropic', value: SUPPORTED_LLM_MODEL_IDS.anthropic.haiku45, label: 'Claude Haiku 4.5' },
  { provider: 'openai', value: SUPPORTED_LLM_MODEL_IDS.openai.gpt54, label: 'GPT-5.4', default: true },
  { provider: 'openai', value: SUPPORTED_LLM_MODEL_IDS.openai.gpt54Mini, label: 'GPT-5.4 mini' },
  { provider: 'google', value: SUPPORTED_LLM_MODEL_IDS.google.gemini31, label: 'Gemini 3.1', default: true },
  {
    provider: 'google',
    value: SUPPORTED_LLM_MODEL_IDS.google.gemini31FlashPreview,
    label: 'Gemini 3.1 Flash-Lite Preview',
  },
]

export function isLLMProvider(value: string | null | undefined): value is LLMProvider {
  return !!value && LLM_PROVIDERS.includes(value as LLMProvider)
}

export function getLLMProviderLabel(provider: LLMProvider): string {
  return LLM_PROVIDER_LABELS[provider]
}

export function getLLMModelOptions(provider: LLMProvider): readonly LLMModelOption[] {
  return LLM_MODEL_OPTIONS.filter((option) => option.provider === provider)
}

export function getDefaultLLMModel(provider: LLMProvider = 'anthropic'): string {
  return getLLMModelOptions(provider).find((option) => option.default)?.value ?? LLM_MODEL_OPTIONS[0]!.value
}

export function inferLLMProviderFromModel(model: string | null | undefined): LLMProvider | null {
  const normalized = model?.trim().toLowerCase() ?? ''
  if (!normalized) return null
  if (normalized.startsWith('claude-')) return 'anthropic'
  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1-') ||
    normalized.startsWith('o3-') ||
    normalized.startsWith('o4-')
  ) {
    return 'openai'
  }
  if (normalized.startsWith('gemini-')) return 'google'
  return null
}

export function isLLMModelCompatible(provider: LLMProvider, model: string | null | undefined): boolean {
  const inferred = inferLLMProviderFromModel(model)
  return inferred === provider
}

export function normalizeLLMSelection(input: {
  provider?: string | null
  model?: string | null
}): { provider: LLMProvider; model: string } {
  const explicitProvider = isLLMProvider(input.provider) ? input.provider : null
  const normalizedModel = input.model?.trim() ?? ''
  const inferredProvider = inferLLMProviderFromModel(normalizedModel)
  const provider = explicitProvider ?? inferredProvider ?? 'anthropic'

  if (!normalizedModel) {
    return { provider, model: getDefaultLLMModel(provider) }
  }
  return { provider, model: normalizedModel }
}

export function getLLMModelLabel(model: string | null | undefined): string {
  const normalized = model?.trim() ?? ''
  if (!normalized) return 'Unconfigured model'
  return LLM_MODEL_OPTIONS.find((option) => option.value === normalized)?.label ?? normalized
}

export function describeLLMSelection(input: {
  provider?: string | null
  model?: string | null
}): string {
  const { provider, model } = normalizeLLMSelection(input)
  return `${getLLMProviderLabel(provider)} · ${getLLMModelLabel(model)}`
}
