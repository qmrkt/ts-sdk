export type ResolutionBlueprintNodeType =
  | 'api_fetch'
  | 'market_evidence'
  | 'llm_judge'
  | 'human_judge'
  | 'wait'
  | 'defer_resolution'
  | 'submit_result'
  | 'cancel_market'

export type ResolutionBlueprintPresetId =
  | 'human_judge'
  | 'api_fetch'
  | 'llm_judge'
  | 'api_fetch_llm'
  | 'api_fetch_wait'
  | 'participant_evidence_llm'

export type ResolutionTrustClass = 'objective' | 'agent_assisted' | 'human_judged'
export type ResolutionNodeErrorMode = 'fail' | 'continue'
export type LLMProvider = 'anthropic' | 'openai' | 'google'

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

export interface APIFetchConfig {
  url: string
  method?: string
  headers?: Record<string, string>
  json_path: string
  outcome_mapping?: Record<string, string>
  timeout_seconds?: number
}

export interface LLMJudgeConfig {
  provider?: LLMProvider
  model?: string
  prompt: string
  require_citations?: boolean
  timeout_seconds?: number
  web_search?: boolean
}

export interface WaitConfig {
  duration_seconds: number
  mode?: 'sleep' | 'defer'
  start_from?: 'now' | 'deadline' | 'resolution_pending_since'
}

export interface MarketEvidenceConfig {}

export type HumanJudgeResponderRole = 'creator' | 'protocol_admin' | 'designated'

export interface HumanJudgeConfig {
  prompt: string
  allowed_responders: HumanJudgeResponderRole[]
  designated_address?: string
  timeout_seconds: number
  require_reason?: boolean
  allow_cancel?: boolean
}

export interface SubmitResultConfig {
  outcome_key?: string
}

export interface DeferResolutionConfig {
  reason?: string
}

export interface CancelMarketConfig {
  reason?: string
}

export interface ResolutionBlueprintNodeConfigByType {
  api_fetch: APIFetchConfig
  market_evidence: MarketEvidenceConfig
  llm_judge: LLMJudgeConfig
  human_judge: HumanJudgeConfig
  wait: WaitConfig
  defer_resolution: DeferResolutionConfig
  submit_result: SubmitResultConfig
  cancel_market: CancelMarketConfig
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
