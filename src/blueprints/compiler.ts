import { cloneSerializable } from './clone.js'
import { validateResolutionBlueprint } from './validate.js'
import type {
  CompiledResolutionBlueprint,
  MarketTemplateContext,
  ResolutionBlueprint,
  ResolutionBlueprintNodeDef,
} from './types.js'

const TOKEN_REPLACERS: Record<string, (market: MarketTemplateContext) => string> = {
  '{{market.question}}': (market) => market.question,
  '{{market.outcomes.csv}}': (market) => market.outcomes.join(', '),
  '{{market.outcomes.indexed}}': (market) =>
    market.outcomes.map((outcome, index) => `${index}: ${outcome}`).join(', '),
  '{{market.outcomes.json}}': (market) => JSON.stringify(market.outcomes),
  '{{market.deadline.unix}}': (market) => String(market.deadline),
  '{{market.deadline.iso}}': (market) =>
    market.deadline > 0 ? new Date(market.deadline * 1000).toISOString() : '',
}

export function compileResolutionBlueprint(
  blueprint: ResolutionBlueprint,
  market: MarketTemplateContext,
): CompiledResolutionBlueprint {
  const validation = validateResolutionBlueprint(blueprint, { marketOutcomes: market.outcomes })
  if (!validation.valid) {
    const firstError = validation.issues.find((issue) => issue.severity === 'error')
    throw new Error(firstError?.message ?? 'Blueprint validation failed')
  }

  const compiledBlueprint = normalizeBlueprint({
    ...blueprint,
    nodes: blueprint.nodes.map((node) => compileNode(node, market)),
  })

  const json = JSON.stringify(compiledBlueprint)
  const bytes = new TextEncoder().encode(json)
  if (!json.length) {
    throw new Error('Resolution blueprint is empty')
  }
  if (bytes.length > 8192) {
    throw new Error(`Resolution blueprint exceeds 8KB limit: ${bytes.length} bytes`)
  }

  return {
    blueprint: compiledBlueprint,
    json,
    bytes,
  }
}

function normalizeBlueprint(blueprint: ResolutionBlueprint): ResolutionBlueprint {
  return {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description,
    version: blueprint.version,
    nodes: blueprint.nodes.map((node) => stripEditorState(node)),
    edges: blueprint.edges.map((edge) => ({ ...edge })),
    inputs: blueprint.inputs ? [...blueprint.inputs] : undefined,
    budget: cloneSerializable(blueprint.budget),
  }
}

function compileNode(
  node: ResolutionBlueprintNodeDef,
  market: MarketTemplateContext,
): ResolutionBlueprintNodeDef {
  return { ...node, config: resolveValue(node.config, market), position: undefined } as ResolutionBlueprintNodeDef
}

function stripEditorState(node: ResolutionBlueprintNodeDef): ResolutionBlueprintNodeDef {
  const { position: _position, ...rest } = node
  return rest as ResolutionBlueprintNodeDef
}

function resolveValue<T>(value: T, market: MarketTemplateContext): T {
  if (typeof value === 'string') {
    return resolveTemplateString(value, market) as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveValue(entry, market)) as T
  }

  if (value && typeof value === 'object') {
    const nextEntries = Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, market)])
    return Object.fromEntries(nextEntries) as T
  }

  return value
}

const TEMPLATE_TOKEN_PATTERN = new RegExp(
  Object.keys(TOKEN_REPLACERS)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
)

function resolveTemplateString(value: string, market: MarketTemplateContext): string {
  return value.replace(TEMPLATE_TOKEN_PATTERN, (token) => {
    const replacer = TOKEN_REPLACERS[token]
    return replacer ? replacer(market) : token
  })
}
