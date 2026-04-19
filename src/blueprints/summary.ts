import { getNodeCapability } from './capabilities.js'
import { compileResolutionBlueprint } from './compiler.js'
import { describeLLMSelection } from './llm-models.js'
import type {
  CompiledResolutionBlueprint,
  MarketTemplateContext,
  ResolutionBlueprint,
  ResolutionBlueprintNodeDef,
  ResolutionTrustClass,
} from './types.js'

export function getNodeDisplayLabel(
  node: ResolutionBlueprintNodeDef | null | undefined,
): string {
  if (!node) return 'Unnamed step'
  return node.label?.trim() || getNodeCapability(node.type).label || 'Unnamed step'
}

export function formatWaitDuration(config: {
  duration_seconds: number
  mode?: string
  start_from?: string
}): string {
  const secs = Math.max(0, Number(config.duration_seconds) || 0)
  if (config.mode === 'defer') {
    const anchor =
      config.start_from === 'resolution_pending_since'
        ? 'resolution pending'
        : config.start_from === 'deadline'
          ? 'deadline'
          : 'anchor'
    return `${secs}s from ${anchor}`
  }
  return `${secs}s delay`
}

function summarizeReturnStatus(node: ResolutionBlueprintNodeDef): string {
  if (node.type !== 'return') return ''
  if (node.config.value && typeof node.config.value.status === 'string') {
    return String(node.config.value.status)
  }
  if (node.config.from_key?.trim()) {
    return `from ${node.config.from_key.trim()}`
  }
  return 'return payload'
}

export function summarizeNode(node: ResolutionBlueprintNodeDef): string {
  switch (node.type) {
    case 'api_fetch':
      return node.config.url?.trim()
        ? new URL(node.config.url, 'https://placeholder.invalid').hostname.replace(
            'placeholder.invalid',
            'custom API',
          )
        : 'Fetch endpoint'
    case 'llm_call':
      return describeLLMSelection(node.config)
    case 'agent_loop':
      return node.config.output_mode === 'resolution'
        ? 'Agent resolution loop'
        : node.config.output_mode === 'structured'
          ? 'Structured agent output'
          : 'General-purpose agent loop'
    case 'await_signal':
      return node.config.signal_type?.trim() || 'Await external signal'
    case 'wait':
      return formatWaitDuration(node.config)
    case 'cel_eval':
      return `${Object.keys(node.config.expressions ?? {}).length} CEL expression(s)`
    case 'map':
      return node.config.items_key?.trim() || 'Map over JSON array'
    case 'gadget':
      return node.config.blueprint_json_key?.trim()
        ? `Run ${node.config.blueprint_json_key.trim()}`
        : node.config.inline
          ? 'Run inline child blueprint'
          : 'Run child blueprint'
    case 'validate_blueprint':
      return node.config.blueprint_json_key?.trim() || 'Validate blueprint JSON'
    case 'return':
      return summarizeReturnStatus(node)
  }
}

export function deriveTrustClass(
  blueprint: ResolutionBlueprint,
): ResolutionTrustClass {
  if (blueprint.nodes.some((node) => node.type === 'await_signal')) {
    return 'human_judged'
  }
  if (blueprint.nodes.some((node) => node.type === 'agent_loop' || node.type === 'llm_call')) {
    return 'agent_assisted'
  }
  return 'objective'
}

export function summarizeTerminalActions(
  blueprint: ResolutionBlueprint,
): string {
  const terminals = blueprint.nodes.filter((node) => node.type === 'return')
  if (terminals.length === 0) {
    return 'No return node'
  }

  const labels = terminals.map((node) => summarizeReturnStatus(node))
  return Array.from(new Set(labels)).join(' + ')
}

export function estimateCompiledBlueprint(
  blueprint: ResolutionBlueprint,
  market: MarketTemplateContext,
): CompiledResolutionBlueprint | null {
  try {
    return compileResolutionBlueprint(blueprint, market)
  } catch {
    return null
  }
}
