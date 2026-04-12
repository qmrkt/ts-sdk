import type {
  APIFetchConfig,
  CancelMarketConfig,
  DeferResolutionConfig,
  HumanJudgeConfig,
  LLMJudgeConfig,
  MarketEvidenceConfig,
  ResolutionBlueprint,
  ResolutionBlueprintNodeConfigByType,
  ResolutionBlueprintNodeDef,
  ResolutionBlueprintNodeType,
  ResolutionTrustClass,
  SubmitResultConfig,
  WaitConfig,
} from './types'

export interface ResolutionNodeCapability {
  type: ResolutionBlueprintNodeType
  label: string
  shortLabel: string
  description: string
  accent: string
  terminal: boolean
  runnable: boolean
  authorableInV1: boolean
  supportsConditions: boolean
  supportsIncoming: boolean
  supportsOutgoing: boolean
  trustImpact: ResolutionTrustClass
  defaultConfig: () => ResolutionBlueprintNodeConfigByType[ResolutionBlueprintNodeType]
}

const defaultApiFetchConfig = (): APIFetchConfig => ({
  url: '',
  method: 'GET',
  headers: {},
  json_path: '',
  outcome_mapping: {},
  timeout_seconds: 30,
})

const defaultLLMJudgeConfig = (): LLMJudgeConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  prompt:
    'Question: {{market.question}}\n' +
    'Outcomes: {{market.outcomes.indexed}}\n\n' +
    'Use any upstream evidence in context and return the correct outcome index.',
  require_citations: false,
  timeout_seconds: 60,
})

const defaultWaitConfig = (): WaitConfig => ({
  duration_seconds: 300,
  mode: 'sleep',
  start_from: 'deadline',
})

const defaultHumanJudgeConfig = (): HumanJudgeConfig => ({
  prompt:
    'Question: {{market.question}}\n' +
    'Outcomes: {{market.outcomes.indexed}}\n\n' +
    'Select the correct outcome index for this market.',
  allowed_responders: ['creator'],
  timeout_seconds: 172800,
  require_reason: false,
  allow_cancel: false,
})

const defaultSubmitConfig = (): SubmitResultConfig => ({
  outcome_key: '',
})

const defaultMarketEvidenceConfig = (): MarketEvidenceConfig => ({})

const defaultDeferConfig = (): DeferResolutionConfig => ({
  reason: 'Resolution deferred until the evidence window closes',
})

const defaultCancelConfig = (): CancelMarketConfig => ({
  reason: 'resolution failed',
})

export const RESOLUTION_NODE_CAPABILITIES: Record<
  ResolutionBlueprintNodeType,
  ResolutionNodeCapability
> = {
  api_fetch: {
    type: 'api_fetch',
    label: 'API Fetch',
    shortLabel: 'API',
    description: 'Fetch JSON from an endpoint and map extracted values to an outcome.',
    accent: 'var(--q-brand)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultApiFetchConfig,
  },
  market_evidence: {
    type: 'market_evidence',
    label: 'Market Evidence',
    shortLabel: 'Evidence',
    description: 'Load signed evidence submissions from current market participants.',
    accent: 'color-mix(in oklab, var(--q-brand) 54%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultMarketEvidenceConfig,
  },
  llm_judge: {
    type: 'llm_judge',
    label: 'LLM Judge',
    shortLabel: 'LLM',
    description: 'Ask a model to evaluate evidence and choose an outcome index.',
    accent: 'color-mix(in oklab, var(--q-brand) 68%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'agent_assisted',
    defaultConfig: defaultLLMJudgeConfig,
  },
  human_judge: {
    type: 'human_judge',
    label: 'Human Judge',
    shortLabel: 'Human',
    description: 'Pause for the creator or protocol admin to choose the winning outcome.',
    accent: 'color-mix(in oklab, var(--q-brand) 40%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'human_judged',
    defaultConfig: defaultHumanJudgeConfig,
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    shortLabel: 'Wait',
    description: 'Sleep for a short delay or defer until a stable market-time anchor has elapsed.',
    accent: 'var(--q-warning)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultWaitConfig,
  },
  defer_resolution: {
    type: 'defer_resolution',
    label: 'Defer Resolution',
    shortLabel: 'Defer',
    description: 'End the current run without proposing a result so the watcher can retry later.',
    accent: 'color-mix(in oklab, var(--q-warning) 80%, white)',
    terminal: true,
    runnable: true,
    authorableInV1: true,
    supportsConditions: true,
    supportsIncoming: true,
    supportsOutgoing: false,
    trustImpact: 'objective',
    defaultConfig: defaultDeferConfig,
  },
  submit_result: {
    type: 'submit_result',
    label: 'Submit Result',
    shortLabel: 'Submit',
    description: 'Publish the selected outcome to the chain.',
    accent: 'var(--q-yes)',
    terminal: true,
    runnable: true,
    authorableInV1: true,
    supportsConditions: true,
    supportsIncoming: true,
    supportsOutgoing: false,
    trustImpact: 'objective',
    defaultConfig: defaultSubmitConfig,
  },
  cancel_market: {
    type: 'cancel_market',
    label: 'Cancel Market',
    shortLabel: 'Cancel',
    description: 'Cancel resolution and close the market with a cancellation reason.',
    accent: 'var(--q-no)',
    terminal: true,
    runnable: true,
    authorableInV1: true,
    supportsConditions: true,
    supportsIncoming: true,
    supportsOutgoing: false,
    trustImpact: 'objective',
    defaultConfig: defaultCancelConfig,
  },
}

export const AUTHORABLE_NODE_TYPES = Object.values(RESOLUTION_NODE_CAPABILITIES)
  .filter((capability) => capability.authorableInV1)
  .map((capability) => capability.type)

export function getNodeCapability(type: ResolutionBlueprintNodeType): ResolutionNodeCapability {
  return RESOLUTION_NODE_CAPABILITIES[type]
}

export function createDefaultNode(
  type: ResolutionBlueprintNodeType,
  id: string,
  position: { x: number; y: number },
): ResolutionBlueprintNodeDef {
  const capability = getNodeCapability(type)

  switch (type) {
    case 'api_fetch':
      return {
        id,
        type,
        label: capability.label,
        config: defaultApiFetchConfig(),
        position,
      }
    case 'market_evidence':
      return {
        id,
        type,
        label: capability.label,
        config: defaultMarketEvidenceConfig(),
        position,
      }
    case 'llm_judge':
      return {
        id,
        type,
        label: capability.label,
        config: defaultLLMJudgeConfig(),
        position,
      }
    case 'wait':
      return {
        id,
        type,
        label: capability.label,
        config: defaultWaitConfig(),
        position,
      }
    case 'defer_resolution':
      return {
        id,
        type,
        label: capability.label,
        config: defaultDeferConfig(),
        position,
      }
    case 'human_judge':
      return {
        id,
        type,
        label: capability.label,
        config: defaultHumanJudgeConfig(),
        position,
      }
    case 'submit_result':
      return {
        id,
        type,
        label: capability.label,
        config: defaultSubmitConfig(),
        position,
      }
    case 'cancel_market':
      return {
        id,
        type,
        label: capability.label,
        config: defaultCancelConfig(),
        position,
      }
  }
}

const NODE_ID_PREFIX: Record<ResolutionBlueprintNodeType, string> = {
  api_fetch: 'fetch',
  market_evidence: 'evidence',
  llm_judge: 'judge',
  human_judge: 'human',
  wait: 'wait',
  defer_resolution: 'defer',
  submit_result: 'submit',
  cancel_market: 'cancel',
}

export function createNodeId(type: ResolutionBlueprintNodeType, blueprint: ResolutionBlueprint): string {
  const prefix = NODE_ID_PREFIX[type]
  const existingIds = new Set(blueprint.nodes.map((node) => node.id))
  let index = 1
  let candidate = prefix
  while (existingIds.has(candidate)) {
    index += 1
    candidate = `${prefix}_${index}`
  }
  return candidate
}
