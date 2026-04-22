import type {
  APIFetchConfig,
  AgentLoopConfig,
  AwaitSignalConfig,
  CelEvalConfig,
  GadgetConfig,
  LLMCallConfig,
  MapConfig,
  ResolutionBlueprint,
  ResolutionBlueprintNodeConfigByType,
  ResolutionBlueprintNodeDef,
  ResolutionBlueprintNodeType,
  ResolutionTrustClass,
  ReturnConfig,
  ValidateBlueprintConfig,
  WaitConfig,
} from './types.js'

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
  body: '',
  json_path: '',
  outcome_mapping: {},
  timeout_seconds: 30,
})

const defaultLLMCallConfig = (): LLMCallConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  prompt:
    'Question: {{market.question}}\n' +
    'Outcomes: {{market.outcomes.indexed}}\n\n' +
    'Use the available evidence and return the correct outcome index as JSON.',
  timeout_seconds: 60,
  allowed_outcomes_key: 'inputs.market.outcomes_json',
})

const defaultAgentLoopConfig = (): AgentLoopConfig => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  system_prompt:
    'You are resolving a prediction market. Choose the best investigation strategy given the market question, outcomes, deadline, and available tools. Gather the strongest public evidence you can find, prefer primary and recent sources when timing matters, and only return an outcome when the evidence supports it. If the evidence is insufficient, contradictory, or unverifiable, return inconclusive instead of guessing.',
  prompt:
    'Question: {{market.question}}\n' +
    'Outcomes: {{market.outcomes.indexed}}\n' +
    'Resolution deadline: {{market.deadline.iso}}\n\n' +
    'Investigate this market using the best strategy you can devise. Use tools to gather evidence from public sources, follow the strongest leads, compare competing claims, and decide which outcome is best supported.\n\n' +
    'Return a structured resolution with:\n' +
    '- outcome: the winning outcome index\n' +
    '- reasoning: a concise evidence-based explanation\n' +
    '- confidence: a 0-1 confidence estimate\n\n' +
    'If the market cannot be resolved confidently from available evidence, return inconclusive.',
  timeout_seconds: 300,
  tool_timeout_seconds: 20,
  max_steps: 8,
  max_tool_calls: 12,
  max_tool_result_bytes: 12000,
  tool_result_history: 2,
  max_history_messages: 24,
  output_mode: 'resolution',
  allowed_outcomes_key: 'inputs.market.outcomes_json',
  tools: [
    {
      name: 'fetch_source',
      kind: 'builtin',
      builtin: 'source_fetch',
      description: 'Fetch a public source URL for current evidence.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  ],
})

const defaultAwaitSignalConfig = (): AwaitSignalConfig => ({
  reason:
    'A human resolver should review this market and submit the best supported outcome with a short reason.',
  signal_type: 'human_judgment.responded',
  correlation_key: 'auto',
  timeout_seconds: 172800,
  required_payload: ['outcome', 'reason'],
  default_outputs: {
    status: 'waiting',
  },
  timeout_outputs: {
    status: 'timeout',
  },
})

const defaultWaitConfig = (): WaitConfig => ({
  duration_seconds: 300,
  mode: 'sleep',
  start_from: 'deadline',
})

const defaultCelEvalConfig = (): CelEvalConfig => ({
  expressions: {
    ok: "results.fetch.status == 'success'",
  },
})

const defaultMapConfig = (): MapConfig => ({
  items_key: 'inputs.market.participant_evidence_json',
  inline: {
    id: 'map-inline',
    version: 1,
    nodes: [
      {
        id: 'return',
        type: 'return',
        config: {
          value: {
            status: 'ok',
          },
        },
      },
    ],
    edges: [],
  },
  batch_size: 1,
  batch_input_key: 'batch',
  batch_index_input_key: 'batch_index',
  batch_start_index_input_key: 'batch_start_index',
  batch_end_index_input_key: 'batch_end_index',
  batch_item_count_input_key: 'batch_item_count',
  max_concurrency: 1,
  on_error: 'fail',
  max_items: 100,
  max_depth: 2,
})

const defaultGadgetConfig = (): GadgetConfig => ({
  blueprint_json_key: 'results.blueprint.blueprint_json',
  input_mappings: {},
  timeout_seconds: 120,
  max_depth: 1,
})

const defaultValidateBlueprintConfig = (): ValidateBlueprintConfig => ({
  blueprint_json_key: 'results.blueprint.blueprint_json',
})

const defaultReturnConfig = (): ReturnConfig => ({
  value: {
    status: 'success',
  },
})

export const RESOLUTION_NODE_CAPABILITIES: Record<
  ResolutionBlueprintNodeType,
  ResolutionNodeCapability
> = {
  api_fetch: {
    type: 'api_fetch',
    label: 'API Fetch',
    shortLabel: 'API',
    description: 'Fetch JSON from an endpoint, extract a value, and optionally map it to an outcome.',
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
  llm_call: {
    type: 'llm_call',
    label: 'LLM Call',
    shortLabel: 'LLM',
    description: 'Call a model directly and capture a structured resolution judgment.',
    accent: 'color-mix(in oklab, var(--q-brand) 68%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'agent_assisted',
    defaultConfig: defaultLLMCallConfig,
  },
  agent_loop: {
    type: 'agent_loop',
    label: 'Agent Loop',
    shortLabel: 'Agent',
    description: 'Run a tool-using agent loop that can investigate before returning a result.',
    accent: 'color-mix(in oklab, var(--q-brand) 54%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'agent_assisted',
    defaultConfig: defaultAgentLoopConfig,
  },
  await_signal: {
    type: 'await_signal',
    label: 'Await Signal',
    shortLabel: 'Signal',
    description: 'Suspend the run until a correlated external signal arrives or a timeout fires.',
    accent: 'color-mix(in oklab, var(--q-brand) 36%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'human_judged',
    defaultConfig: defaultAwaitSignalConfig,
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    shortLabel: 'Wait',
    description: 'Pause inline for a short delay or defer until a market-time anchor has elapsed.',
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
  cel_eval: {
    type: 'cel_eval',
    label: 'CEL Eval',
    shortLabel: 'CEL',
    description: 'Evaluate one or more CEL expressions and write the outputs into results.',
    accent: 'color-mix(in oklab, var(--q-brand) 24%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultCelEvalConfig,
  },
  map: {
    type: 'map',
    label: 'Map',
    shortLabel: 'Map',
    description: 'Run an inline child blueprint over a JSON array with batching controls.',
    accent: 'color-mix(in oklab, var(--q-brand) 44%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultMapConfig,
  },
  gadget: {
    type: 'gadget',
    label: 'Gadget',
    shortLabel: 'Gadget',
    description: 'Run a child blueprint supplied inline or from runtime context.',
    accent: 'color-mix(in oklab, var(--q-brand) 58%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultGadgetConfig,
  },
  validate_blueprint: {
    type: 'validate_blueprint',
    label: 'Validate Blueprint',
    shortLabel: 'Validate',
    description: 'Validate blueprint JSON from context and emit issues without executing it.',
    accent: 'color-mix(in oklab, var(--q-brand) 28%, white)',
    terminal: false,
    runnable: true,
    authorableInV1: true,
    supportsConditions: false,
    supportsIncoming: true,
    supportsOutgoing: true,
    trustImpact: 'objective',
    defaultConfig: defaultValidateBlueprintConfig,
  },
  return: {
    type: 'return',
    label: 'Return',
    shortLabel: 'Return',
    description: 'Emit the terminal JSON payload for the run and end execution.',
    accent: 'var(--q-yes)',
    terminal: true,
    runnable: true,
    authorableInV1: true,
    supportsConditions: true,
    supportsIncoming: true,
    supportsOutgoing: false,
    trustImpact: 'objective',
    defaultConfig: defaultReturnConfig,
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
  return {
    id,
    type,
    label: capability.label,
    config: capability.defaultConfig(),
    position,
  } as ResolutionBlueprintNodeDef
}

const NODE_ID_PREFIX: Record<ResolutionBlueprintNodeType, string> = {
  api_fetch: 'fetch',
  llm_call: 'llm',
  agent_loop: 'agent',
  await_signal: 'signal',
  wait: 'wait',
  cel_eval: 'eval',
  map: 'map',
  gadget: 'gadget',
  validate_blueprint: 'validate',
  return: 'return',
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
