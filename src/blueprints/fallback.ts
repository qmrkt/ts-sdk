import type { ResolutionBlueprint, ResolutionBlueprintPresetId } from './types'
import { buildResolutionBlueprintPreset } from './presets'

export interface InferredResolutionBlueprintFallback {
  blueprint: ResolutionBlueprint
  presetId: ResolutionBlueprintPresetId
  reason: string
}

export interface InferResolutionBlueprintFallbackOptions {
  summary?: string
  resolutionAuthority?: string
  creator?: string
  marketAdmin?: string
}

export function hasRenderableBlueprint(
  blueprint: ResolutionBlueprint | null | undefined,
): blueprint is ResolutionBlueprint {
  return Boolean(
    blueprint &&
      Array.isArray(blueprint.nodes) &&
      blueprint.nodes.length > 0 &&
      Array.isArray(blueprint.edges),
  )
}

export function inferResolutionBlueprintFallback(
  options: InferResolutionBlueprintFallbackOptions,
): InferredResolutionBlueprintFallback | null {
  const summary = String(options.summary ?? '').trim()
  const resolutionAuthority = String(options.resolutionAuthority ?? '').trim()
  const creator = String(options.creator ?? '').trim()
  const marketAdmin = String(options.marketAdmin ?? '').trim()

  if (!summary && !resolutionAuthority && !creator && !marketAdmin) {
    return null
  }

  const presetId = inferPresetId(summary, resolutionAuthority, creator, marketAdmin)
  const blueprint = buildResolutionBlueprintPreset(presetId)
  const presetLabel = presetId.replace(/_/g, ' ')

  return {
    presetId,
    blueprint: {
      ...blueprint,
      id: `inferred-${presetId}`,
      name: `Inferred ${blueprint.name ?? presetLabel}`,
      description:
        'Inferred from stored market metadata because the exact blueprint definition was unavailable.',
    },
    reason: `Showing an inferred ${presetLabel} graph because this market does not have a stored blueprint definition.`,
  }
}

function inferPresetId(
  summary: string,
  resolutionAuthority: string,
  creator: string,
  marketAdmin: string,
): ResolutionBlueprintPresetId {
  const normalized = ` ${summary.toLowerCase()} `

  const mentionsParticipantEvidence =
    normalized.includes('participant evidence') ||
    normalized.includes('evidence window') ||
    normalized.includes('signed participant') ||
    normalized.includes('submission count') ||
    normalized.includes('claimed outcome')

  const mentionsWait =
    normalized.includes(' wait ') ||
    normalized.includes(' delay ') ||
    normalized.includes('window') ||
    normalized.includes('grace period')

  const mentionsLlm =
    normalized.includes(' llm ') ||
    normalized.includes(' model ') ||
    normalized.includes(' ai ') ||
    normalized.includes('claude') ||
    normalized.includes('gpt')

  const mentionsFallback =
    normalized.includes('fallback') ||
    normalized.includes('escalat') ||
    normalized.includes('if the fetch fails')

  const mentionsApi =
    normalized.includes('api') ||
    normalized.includes('endpoint') ||
    normalized.includes('external data') ||
    normalized.includes('technical check') ||
    normalized.includes('automatically') ||
    normalized.includes('without needing manual') ||
    normalized.includes('continuously') ||
    normalized.includes('detect')

  const mentionsHuman =
    normalized.includes('human') ||
    normalized.includes('manual') ||
    normalized.includes('creator') ||
    normalized.includes('protocol admin') ||
    normalized.includes('trusted resolver')

  if (mentionsParticipantEvidence) return 'participant_evidence_llm'
  if (mentionsApi && mentionsWait) return 'api_fetch_wait'
  if (mentionsApi && (mentionsLlm || mentionsFallback)) return 'api_fetch_llm'
  if (mentionsLlm) return 'llm_judge'
  if (mentionsApi) return 'api_fetch'
  if (mentionsHuman) return 'human_judge'
  if (
    resolutionAuthority &&
    (resolutionAuthority === creator || resolutionAuthority === marketAdmin)
  ) {
    return 'human_judge'
  }

  return 'human_judge'
}
