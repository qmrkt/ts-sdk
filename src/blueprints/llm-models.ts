import type { LLMProvider } from './types'

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

export const LLM_MODEL_OPTIONS: readonly LLMModelOption[] = [
  { provider: 'anthropic', value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { provider: 'anthropic', value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', default: true },
  { provider: 'anthropic', value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai', value: 'gpt-4o', label: 'GPT-4o', default: true },
  { provider: 'openai', value: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { provider: 'openai', value: 'o3-mini', label: 'o3-mini' },
  { provider: 'google', value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', default: true },
  { provider: 'google', value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { provider: 'google', value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
]

const LLM_PROVIDERS: readonly LLMProvider[] = ['anthropic', 'openai', 'google']

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
