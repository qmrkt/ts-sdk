export type ResolutionBlueprintNodeType =
  | 'api_fetch'
  | 'llm_call'
  | 'agent_loop'
  | 'await_signal'
  | 'wait'
  | 'cel_eval'
  | 'map'
  | 'gadget'
  | 'validate_blueprint'
  | 'return'

export type ResolutionBlueprintPresetId =
  | 'await_signal'
  | 'api_fetch'
  | 'llm_call'
  | 'agent_loop'
  | 'api_fetch_wait'
  | 'api_fetch_agent_loop'
  | 'validate_blueprint_gadget'

export type ResolutionTrustClass = 'objective' | 'agent_assisted' | 'human_judged'

export const RESOLUTION_NODE_ERROR_MODES = ['fail', 'continue'] as const
export type ResolutionNodeErrorMode = (typeof RESOLUTION_NODE_ERROR_MODES)[number]

export const LLM_PROVIDERS = ['anthropic', 'openai', 'google'] as const
export type LLMProvider = (typeof LLM_PROVIDERS)[number]

export const API_FETCH_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type APIFetchMethod = (typeof API_FETCH_METHODS)[number]

export const RESOLUTION_WAIT_MODES = ['sleep', 'defer'] as const
export type ResolutionWaitMode = (typeof RESOLUTION_WAIT_MODES)[number]

export const RESOLUTION_WAIT_START_FROMS = ['deadline', 'resolution_pending_since'] as const
export type ResolutionWaitStartFrom = (typeof RESOLUTION_WAIT_START_FROMS)[number]

export const AGENT_OUTPUT_MODES = ['text', 'structured', 'resolution'] as const
export type AgentOutputMode = (typeof AGENT_OUTPUT_MODES)[number]

export const AGENT_TOOL_KINDS = ['builtin', 'blueprint'] as const
export type AgentToolKind = (typeof AGENT_TOOL_KINDS)[number]

export const AGENT_BUILTIN_TOOLS = [
  'context_get',
  'context_list',
  'source_fetch',
  'json_extract',
  'run_blueprint',
] as const
export type AgentBuiltinTool = (typeof AGENT_BUILTIN_TOOLS)[number]

export interface Position {
  x: number
  y: number
}

export interface ResolutionBlueprintInputDef {
  name: string
  label?: string
  required?: boolean
  default?: string
}

export interface ResolutionBlueprintBudget {
  max_total_time_seconds?: number
  max_total_tokens?: number
  per_node?: Record<string, ResolutionBlueprintNodeBudget>
}

export interface ResolutionBlueprintNodeBudget {
  max_tokens?: number
  max_time_seconds?: number
}

export interface APIFetchBasicAuth {
  username?: string
  password?: string
}

export interface APIFetchConfig {
  url: string
  method?: APIFetchMethod
  headers?: Record<string, string>
  body?: string
  basic_auth?: APIFetchBasicAuth
  json_path?: string
  outcome_mapping?: Record<string, string>
  timeout_seconds?: number
}

export interface LLMCallConfig {
  provider?: LLMProvider
  model?: string
  prompt: string
  timeout_seconds?: number
  web_search?: boolean
  allowed_outcomes_key?: string
}

export interface AgentOutputToolConfig {
  name?: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface DynamicBlueprintPolicy {
  allowed_node_types?: ResolutionBlueprintNodeType[]
  max_nodes?: number
  max_edges?: number
  max_depth?: number
  max_total_time_seconds?: number
  max_total_tokens?: number
  allow_agent_loop?: boolean
}

export interface AgentToolConfig {
  name: string
  kind?: AgentToolKind
  builtin?: AgentBuiltinTool
  description?: string
  parameters?: Record<string, unknown>
  inline?: ResolutionBlueprint
  input_mappings?: Record<string, string>
  timeout_seconds?: number
  max_depth?: number
}

export interface AgentLoopConfig {
  provider?: LLMProvider
  model?: string
  system_prompt?: string
  prompt: string
  timeout_seconds?: number
  tool_timeout_seconds?: number
  max_steps?: number
  max_tool_calls?: number
  max_tool_result_bytes?: number
  tool_result_history?: number
  max_history_messages?: number
  max_tokens?: number
  reasoning?: string
  output_mode?: AgentOutputMode
  output_tool?: AgentOutputToolConfig
  tools?: AgentToolConfig[]
  context_allowlist?: string[]
  allowed_outcomes_key?: string
  enable_dynamic_blueprints?: boolean
  dynamic_blueprint_policy?: DynamicBlueprintPolicy
  async?: boolean
}

export interface AwaitSignalConfig {
  reason?: string
  signal_type: string
  correlation_key?: string
  timeout_seconds?: number
  required_payload?: string[]
  default_outputs?: Record<string, string>
  timeout_outputs?: Record<string, string>
}

export interface WaitConfig {
  duration_seconds: number
  mode?: ResolutionWaitMode
  start_from?: ResolutionWaitStartFrom
  max_inline_seconds?: number
}

export interface CelEvalConfig {
  expressions: Record<string, string>
}

export interface MapConfig {
  items_key: string
  inline: ResolutionBlueprint
  batch_size?: number
  batch_input_key?: string
  batch_index_input_key?: string
  batch_start_index_input_key?: string
  batch_end_index_input_key?: string
  batch_item_count_input_key?: string
  max_concurrency?: number
  on_error?: ResolutionNodeErrorMode
  max_items?: number
  max_depth?: number
  per_batch_timeout_seconds?: number
  input_mappings?: Record<string, string>
}

export interface GadgetConfig {
  blueprint_json?: string
  blueprint_json_key?: string
  inline?: ResolutionBlueprint
  input_mappings?: Record<string, string>
  timeout_seconds?: number
  max_depth?: number
  dynamic_blueprint_policy?: DynamicBlueprintPolicy
}

export interface ValidateBlueprintConfig {
  blueprint_json_key: string
}

export interface ReturnConfig {
  value?: Record<string, unknown>
  from_key?: string
}

export interface ResolutionBlueprintNodeConfigByType {
  api_fetch: APIFetchConfig
  llm_call: LLMCallConfig
  agent_loop: AgentLoopConfig
  await_signal: AwaitSignalConfig
  wait: WaitConfig
  cel_eval: CelEvalConfig
  map: MapConfig
  gadget: GadgetConfig
  validate_blueprint: ValidateBlueprintConfig
  return: ReturnConfig
}

interface BaseNodeDef<TType extends ResolutionBlueprintNodeType> {
  id: string
  type: TType
  label?: string
  config: ResolutionBlueprintNodeConfigByType[TType]
  on_error?: ResolutionNodeErrorMode
  position?: Position
}

export type ResolutionBlueprintNodeDef = {
  [K in ResolutionBlueprintNodeType]: BaseNodeDef<K>
}[ResolutionBlueprintNodeType]

export interface ResolutionBlueprintEdgeDef {
  from: string
  to: string
  condition?: string
  max_traversals?: number
}

export interface ResolutionBlueprint {
  id: string
  name?: string
  description?: string
  version: number
  nodes: ResolutionBlueprintNodeDef[]
  edges: ResolutionBlueprintEdgeDef[]
  inputs?: ResolutionBlueprintInputDef[]
  budget?: ResolutionBlueprintBudget
}

export interface MarketTemplateContext {
  question: string
  outcomes: string[]
  deadline: number
}

export interface ResolutionBlueprintPreset {
  id: ResolutionBlueprintPresetId
  name: string
  description: string
  build(): ResolutionBlueprint
}

export interface ResolutionBlueprintValidationIssue {
  code: string
  message: string
  target?: string
  severity: 'error' | 'warning'
}

export interface ResolutionBlueprintValidationResult {
  valid: boolean
  issues: ResolutionBlueprintValidationIssue[]
}

export interface CompiledResolutionBlueprint {
  blueprint: ResolutionBlueprint
  json: string
  bytes: Uint8Array
}
