import {
  AUTHORABLE_NODE_TYPES,
  RESOLUTION_NODE_CAPABILITIES,
  getNodeCapability,
} from './capabilities.js'
import { detectCycles } from './cycle-detection.js'
import { inferLLMProviderFromModel, isLLMModelCompatible, isLLMProvider } from './llm-models.js'
import {
  AGENT_BUILTIN_TOOLS,
  AGENT_OUTPUT_MODES,
  AGENT_TOOL_KINDS,
  API_FETCH_METHODS,
  RESOLUTION_NODE_ERROR_MODES,
  RESOLUTION_WAIT_MODES,
  RESOLUTION_WAIT_START_FROMS,
} from './types.js'
import type {
  AgentToolConfig,
  DynamicBlueprintPolicy,
  ResolutionBlueprint,
  ResolutionBlueprintEdgeDef,
  ResolutionBlueprintNodeDef,
  ResolutionBlueprintNodeType,
  ResolutionBlueprintValidationIssue,
  ResolutionBlueprintValidationResult,
  ReturnConfig,
  WaitConfig,
} from './types.js'

const MAX_BLUEPRINT_NODES = 16
const MAX_BLUEPRINT_BYTES = 8 * 1024
const TERMINAL_NODE_TYPES = new Set<ResolutionBlueprintNodeType>(
  Object.values(RESOLUTION_NODE_CAPABILITIES)
    .filter((capability) => capability.terminal)
    .map((capability) => capability.type),
)
const SUPPORTED_API_FETCH_METHODS = new Set<string>(API_FETCH_METHODS)
const SUPPORTED_AGENT_OUTPUT_MODES = new Set<string>(AGENT_OUTPUT_MODES)
const SUPPORTED_AGENT_TOOL_KINDS = new Set<string>(AGENT_TOOL_KINDS)
const SUPPORTED_AGENT_BUILTINS = new Set<string>(AGENT_BUILTIN_TOOLS)
const SUPPORTED_WAIT_MODES = new Set<string>(RESOLUTION_WAIT_MODES)
const SUPPORTED_WAIT_START_FROMS = new Set<string>(RESOLUTION_WAIT_START_FROMS)
const SUPPORTED_NODE_ERROR_MODES = new Set<string>(RESOLUTION_NODE_ERROR_MODES)

export interface ResolutionBlueprintValidationOptions {
  marketOutcomes?: string[]
}

export function validateResolutionBlueprint(
  blueprint: ResolutionBlueprint,
  options: ResolutionBlueprintValidationOptions = {},
): ResolutionBlueprintValidationResult {
  const issues: ResolutionBlueprintValidationIssue[] = []

  if (blueprint.nodes.length === 0) {
    issues.push({
      code: 'EMPTY_BLUEPRINT',
      message: 'Add at least one node to the blueprint.',
      severity: 'error',
    })
  }

  if (blueprint.nodes.length > MAX_BLUEPRINT_NODES) {
    issues.push({
      code: 'TOO_MANY_NODES',
      message: `Blueprints are capped at ${MAX_BLUEPRINT_NODES} nodes in the current editor.`,
      severity: 'error',
    })
  }

  const serialized = safeJSONStringify(blueprint)
  if (serialized !== null) {
    const bytes = new TextEncoder().encode(serialized)
    if (bytes.length > MAX_BLUEPRINT_BYTES) {
      issues.push({
        code: 'BLUEPRINT_TOO_LARGE',
        message: `Resolution blueprint exceeds 8KB limit: ${bytes.length} bytes.`,
        severity: 'error',
      })
    }
  }

  const nodeIds = new Set<string>()
  for (const node of blueprint.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node id "${node.id}".`,
        target: node.id,
        severity: 'error',
      })
    }
    nodeIds.add(node.id)

    if (!(node.type in RESOLUTION_NODE_CAPABILITIES)) {
      issues.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `Unknown node type "${node.type}".`,
        target: node.id,
        severity: 'error',
      })
      continue
    }

    if (!AUTHORABLE_NODE_TYPES.includes(node.type)) {
      issues.push({
        code: 'UNSUPPORTED_NODE_TYPE',
        message: `"${node.type}" is not authorable in the current editor.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  for (const node of blueprint.nodes) {
    if (!(node.type in RESOLUTION_NODE_CAPABILITIES)) continue
    validateNodeConfig(node, issues, options, nodeIds)
  }

  const edgeIds = new Set<string>()
  for (const edge of blueprint.edges) {
    const edgeId = `${edge.from}->${edge.to}`

    if (edge.from === edge.to) {
      issues.push({
        code: 'SELF_LOOP',
        message: 'Self-loops are not allowed.',
        target: edgeId,
        severity: 'error',
      })
    }

    if (edgeIds.has(edgeId)) {
      issues.push({
        code: 'DUPLICATE_EDGE',
        message: `Duplicate edge "${edgeId}".`,
        target: edgeId,
        severity: 'error',
      })
    }
    edgeIds.add(edgeId)

    if (!nodeIds.has(edge.from)) {
      issues.push({
        code: 'DANGLING_EDGE_SOURCE',
        message: `Edge source "${edge.from}" does not exist.`,
        target: edgeId,
        severity: 'error',
      })
    }

    if (!nodeIds.has(edge.to)) {
      issues.push({
        code: 'DANGLING_EDGE_TARGET',
        message: `Edge target "${edge.to}" does not exist.`,
        target: edgeId,
        severity: 'error',
      })
    }

    issues.push(...validateEdgeCondition(edge, nodeIds))
  }

  const cycleResult = detectCycles(blueprint.nodes, blueprint.edges)
  if (cycleResult.hasCycles) {
    for (const backEdgeId of cycleResult.backEdgeIds) {
      const edge = blueprint.edges.find((candidate) => `${candidate.from}->${candidate.to}` === backEdgeId)
      if ((edge?.max_traversals ?? 0) <= 0) {
        issues.push({
          code: 'BACK_EDGE_MISSING_MAX_TRAVERSALS',
          message: `Loop edge "${backEdgeId}" must set max traversals.`,
          target: backEdgeId,
          severity: 'error',
        })
      }
    }
  }

  const forwardEdges = collectForwardEdges(blueprint.edges, cycleResult.backEdges)
  const roots = getRootNodes(blueprint.nodes, forwardEdges)
  if (roots.length === 0 && blueprint.nodes.length > 0) {
    issues.push({
      code: 'NO_ROOT',
      message: 'Blueprint needs at least one root node.',
      severity: 'error',
    })
  }

  const terminals = blueprint.nodes.filter((node) => TERMINAL_NODE_TYPES.has(node.type))
  if (terminals.length === 0) {
    issues.push({
      code: 'NO_RETURN_NODE',
      message: 'Blueprint needs at least one return node.',
      severity: 'error',
    })
  }

  const reachable = reachableViaEdges(blueprint.nodes, forwardEdges, roots)
  const outgoingByNode = buildOutgoingMap(blueprint.nodes, blueprint.edges)

  for (const node of blueprint.nodes) {
    if (roots.length > 0 && !reachable.has(node.id)) {
      issues.push({
        code: 'UNREACHABLE_NODE',
        message: `Node "${node.label ?? node.id}" is unreachable from the graph roots.`,
        target: node.id,
        severity: 'error',
      })
    }

    const outgoing = outgoingByNode.get(node.id) ?? []
    if (node.type === 'return') {
      if (outgoing.length > 0) {
        issues.push({
          code: 'RETURN_HAS_OUTGOING',
          message: `Return node "${node.label ?? node.id}" cannot have outgoing edges.`,
          target: node.id,
          severity: 'error',
        })
      }
      continue
    }

    if (reachable.has(node.id) && outgoing.length === 0) {
      issues.push({
        code: 'NON_RETURN_LEAF',
        message: `Node "${node.label ?? node.id}" needs an outgoing path to a return node.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  const canReachReturn = computeReachabilityToReturn(blueprint.nodes, blueprint.edges)
  for (const node of blueprint.nodes) {
    if (!reachable.has(node.id)) continue
    if (!canReachReturn.has(node.id)) {
      issues.push({
        code: 'NO_RETURN_PATH',
        message: `Node "${node.label ?? node.id}" does not lead to any return node.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  validateEdgeReferences(blueprint, issues)

  return {
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
  }
}

export function validateResolutionBlueprintConnection(
  from: string,
  to: string,
  blueprint: ResolutionBlueprint,
): string | null {
  if (from === to) {
    return 'Self-loops are not allowed.'
  }

  const source = blueprint.nodes.find((node) => node.id === from)
  const target = blueprint.nodes.find((node) => node.id === to)
  if (!source || !target) {
    return 'Both nodes must exist before connecting them.'
  }

  if (blueprint.edges.some((edge) => edge.from === from && edge.to === to)) {
    return 'That edge already exists.'
  }

  if (!getNodeCapability(source.type).supportsOutgoing) {
    return `"${source.label ?? source.id}" cannot have outgoing edges.`
  }

  if (!getNodeCapability(target.type).supportsIncoming) {
    return `"${target.label ?? target.id}" cannot accept incoming edges.`
  }

  return null
}

function validateNodeConfig(
  node: ResolutionBlueprintNodeDef,
  issues: ResolutionBlueprintValidationIssue[],
  options: ResolutionBlueprintValidationOptions,
  nodeIds: Set<string>,
) {
  switch (node.type) {
    case 'api_fetch':
      validateAPIFetchNode(node, issues, options)
      break
    case 'llm_call':
      validateLLMNode(node, issues)
      break
    case 'agent_loop':
      validateAgentLoopNode(node, issues)
      break
    case 'await_signal':
      validateAwaitSignalNode(node, issues)
      break
    case 'wait':
      validateWaitNode(node, issues)
      break
    case 'cel_eval':
      validateCelEvalNode(node, issues)
      break
    case 'map':
      validateMapNode(node, issues, options, nodeIds)
      break
    case 'gadget':
      validateGadgetNode(node, issues, options, nodeIds)
      break
    case 'validate_blueprint':
      validateValidateBlueprintNode(node, issues)
      break
    case 'return':
      validateReturnNode(node, issues, nodeIds)
      break
  }
}

function validateAPIFetchNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'api_fetch' }>,
  issues: ResolutionBlueprintValidationIssue[],
  options: ResolutionBlueprintValidationOptions,
) {
  if (!node.config.url.trim()) {
    issues.push({
      code: 'API_URL_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs a URL.`,
      target: node.id,
      severity: 'error',
    })
  } else {
    try {
      const parsed = new URL(node.config.url)
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error('unsupported protocol')
      }
    } catch {
      issues.push({
        code: 'API_URL_INVALID',
        message: `Node "${node.label ?? node.id}" needs a valid absolute HTTP(S) URL.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  if (node.config.method && !SUPPORTED_API_FETCH_METHODS.has(node.config.method)) {
    issues.push({
      code: 'API_METHOD_INVALID',
      message: `Node "${node.label ?? node.id}" uses unsupported method "${node.config.method}".`,
      target: node.id,
      severity: 'error',
    })
  }

  if ((node.config.timeout_seconds ?? 0) < 0) {
    issues.push({
      code: 'API_TIMEOUT_INVALID',
      message: `Node "${node.label ?? node.id}" must use a non-negative timeout.`,
      target: node.id,
      severity: 'error',
    })
  }

  for (const [rawValue, mappedOutcome] of Object.entries(node.config.outcome_mapping ?? {})) {
    const target = String(mappedOutcome ?? '').trim()
    if (!target) {
      issues.push({
        code: 'API_OUTCOME_MAPPING_EMPTY',
        message: `Node "${node.label ?? node.id}" has an empty outcome mapping for "${rawValue}".`,
        target: node.id,
        severity: 'error',
      })
      continue
    }

    if (!/^\d+$/.test(target)) {
      issues.push({
        code: 'API_OUTCOME_MAPPING_INVALID_INDEX',
        message: `Node "${node.label ?? node.id}" must map "${rawValue}" to a numeric outcome index.`,
        target: node.id,
        severity: 'error',
      })
      continue
    }

    if (options.marketOutcomes && Number(target) >= options.marketOutcomes.length) {
      issues.push({
        code: 'API_OUTCOME_MAPPING_UNKNOWN_OUTCOME',
        message: `Node "${node.label ?? node.id}" maps "${rawValue}" outside the market outcomes range.`,
        target: node.id,
        severity: 'error',
      })
    }
  }
}

function validateLLMNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'llm_call' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!node.config.prompt.trim()) {
    issues.push({
      code: 'LLM_PROMPT_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs a prompt.`,
      target: node.id,
      severity: 'error',
    })
  }

  validateLLMSelection(node.config.provider, node.config.model, node, issues, 'LLM')

  if ('require_citations' in (node.config as unknown as Record<string, unknown>)) {
    issues.push({
      code: 'LLM_REQUIRE_CITATIONS_REMOVED',
      message: `Node "${node.label ?? node.id}" still uses removed field require_citations.`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.allowed_outcomes_key !== undefined) {
    validateLookupKey(
      node.config.allowed_outcomes_key,
      {
        code: 'LLM_ALLOWED_OUTCOMES_KEY_INVALID',
        message: `Node "${node.label ?? node.id}" must use an engine namespaced allowed_outcomes_key.`,
        target: node.id,
      },
      issues,
    )
  }
}

function validateAgentLoopNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'agent_loop' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!node.config.prompt.trim()) {
    issues.push({
      code: 'AGENT_PROMPT_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs a prompt.`,
      target: node.id,
      severity: 'error',
    })
  }

  validateLLMSelection(node.config.provider, node.config.model, node, issues, 'AGENT')

  if (node.config.allowed_outcomes_key !== undefined) {
    validateLookupKey(
      node.config.allowed_outcomes_key,
      {
        code: 'AGENT_ALLOWED_OUTCOMES_KEY_INVALID',
        message: `Node "${node.label ?? node.id}" must use an engine namespaced allowed_outcomes_key.`,
        target: node.id,
      },
      issues,
    )
  }

  if (node.config.output_mode && !SUPPORTED_AGENT_OUTPUT_MODES.has(node.config.output_mode)) {
    issues.push({
      code: 'AGENT_OUTPUT_MODE_INVALID',
      message: `Node "${node.label ?? node.id}" uses unsupported output_mode "${node.config.output_mode}".`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.output_mode === 'structured' && !node.config.output_tool?.parameters) {
    issues.push({
      code: 'AGENT_OUTPUT_TOOL_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs output_tool.parameters for structured output.`,
      target: node.id,
      severity: 'error',
    })
  }

  for (const [name, value] of [
    ['timeout_seconds', node.config.timeout_seconds],
    ['tool_timeout_seconds', node.config.tool_timeout_seconds],
    ['max_steps', node.config.max_steps],
    ['max_tool_calls', node.config.max_tool_calls],
    ['max_tool_result_bytes', node.config.max_tool_result_bytes],
    ['tool_result_history', node.config.tool_result_history],
    ['max_history_messages', node.config.max_history_messages],
    ['max_tokens', node.config.max_tokens],
  ] as const) {
    if ((value ?? 0) < 0) {
      issues.push({
        code: 'AGENT_LIMIT_INVALID',
        message: `Node "${node.label ?? node.id}" must use a non-negative ${name}.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  if ((node.config.tool_result_history ?? 1) === 0) {
    issues.push({
      code: 'AGENT_TOOL_RESULT_HISTORY_INVALID',
      message: `Node "${node.label ?? node.id}" must keep at least one tool result in history.`,
      target: node.id,
      severity: 'error',
    })
  }

  if ((node.config.max_history_messages ?? 2) === 1) {
    issues.push({
      code: 'AGENT_MAX_HISTORY_MESSAGES_INVALID',
      message: `Node "${node.label ?? node.id}" must allow at least two history messages.`,
      target: node.id,
      severity: 'error',
    })
  }

  for (const allowed of node.config.context_allowlist ?? []) {
    if (!allowed.trim()) {
      issues.push({
        code: 'AGENT_CONTEXT_ALLOWLIST_INVALID',
        message: `Node "${node.label ?? node.id}" has a blank context_allowlist entry.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  validateDynamicBlueprintPolicy(node.config.dynamic_blueprint_policy, node, issues)

  for (const [index, tool] of (node.config.tools ?? []).entries()) {
    validateAgentTool(node, tool, index, issues)
  }
}

function validateAwaitSignalNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'await_signal' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!node.config.signal_type.trim()) {
    issues.push({
      code: 'AWAIT_SIGNAL_TYPE_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs a signal_type.`,
      target: node.id,
      severity: 'error',
    })
  }

  if ((node.config.timeout_seconds ?? 0) < 0) {
    issues.push({
      code: 'AWAIT_TIMEOUT_INVALID',
      message: `Node "${node.label ?? node.id}" must use a non-negative timeout.`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.required_payload?.some((value) => !value.trim())) {
    issues.push({
      code: 'AWAIT_REQUIRED_PAYLOAD_INVALID',
      message: `Node "${node.label ?? node.id}" has a blank required_payload entry.`,
      target: node.id,
      severity: 'error',
    })
  }

  validateStringRecord(node.id, node.label, node.config.default_outputs, 'AWAIT_DEFAULT_OUTPUTS_INVALID', issues)
  validateStringRecord(node.id, node.label, node.config.timeout_outputs, 'AWAIT_TIMEOUT_OUTPUTS_INVALID', issues)
}

function validateWaitNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'wait' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if ((node.config.duration_seconds ?? 0) < 0) {
    issues.push({
      code: 'WAIT_DURATION_INVALID',
      message: `Node "${node.label ?? node.id}" must use a non-negative duration.`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.mode && !SUPPORTED_WAIT_MODES.has(node.config.mode)) {
    issues.push({
      code: 'WAIT_MODE_INVALID',
      message: `Node "${node.label ?? node.id}" uses unsupported mode "${node.config.mode}".`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.start_from && !SUPPORTED_WAIT_START_FROMS.has(node.config.start_from)) {
    issues.push({
      code: 'WAIT_START_FROM_INVALID',
      message: `Node "${node.label ?? node.id}" uses unsupported start_from "${node.config.start_from}".`,
      target: node.id,
      severity: 'error',
    })
  }

  const maxInlineSeconds = node.config.max_inline_seconds
  if (maxInlineSeconds !== undefined && (maxInlineSeconds < -1 || maxInlineSeconds > 300)) {
    issues.push({
      code: 'WAIT_MAX_INLINE_SECONDS_INVALID',
      message: `Node "${node.label ?? node.id}" must use max_inline_seconds between -1 and 300.`,
      target: node.id,
      severity: 'error',
    })
  }
}

function validateCelEvalNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'cel_eval' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  const expressions = node.config.expressions ?? {}
  if (Object.keys(expressions).length === 0) {
    issues.push({
      code: 'CEL_EXPRESSIONS_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs at least one CEL expression.`,
      target: node.id,
      severity: 'error',
    })
    return
  }

  for (const [key, expression] of Object.entries(expressions)) {
    if (!key.trim()) {
      issues.push({
        code: 'CEL_EXPRESSION_KEY_INVALID',
        message: `Node "${node.label ?? node.id}" has a blank CEL output key.`,
        target: node.id,
        severity: 'error',
      })
    }
    if (!expression.trim()) {
      issues.push({
        code: 'CEL_EXPRESSION_EMPTY',
        message: `Node "${node.label ?? node.id}" has an empty CEL expression for "${key}".`,
        target: node.id,
        severity: 'error',
      })
    }
  }
}

function validateMapNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'map' }>,
  issues: ResolutionBlueprintValidationIssue[],
  options: ResolutionBlueprintValidationOptions,
  nodeIds: Set<string>,
) {
  validateLookupKey(
    node.config.items_key,
    {
      code: 'MAP_ITEMS_KEY_INVALID',
      message: `Node "${node.label ?? node.id}" must use an engine namespaced items_key.`,
      target: node.id,
    },
    issues,
  )

  if (!node.config.inline || node.config.inline.nodes.length === 0) {
    issues.push({
      code: 'MAP_INLINE_REQUIRED',
      message: `Node "${node.label ?? node.id}" needs an inline child blueprint.`,
      target: node.id,
      severity: 'error',
    })
  } else {
    validateChildBlueprint(node, node.config.inline, 'MAP_INLINE', issues, options)
  }

  for (const [name, value] of [
    ['batch_size', node.config.batch_size],
    ['max_concurrency', node.config.max_concurrency],
    ['max_items', node.config.max_items],
    ['max_depth', node.config.max_depth],
    ['per_batch_timeout_seconds', node.config.per_batch_timeout_seconds],
  ] as const) {
    if ((value ?? 0) < 0) {
      issues.push({
        code: 'MAP_LIMIT_INVALID',
        message: `Node "${node.label ?? node.id}" must use a non-negative ${name}.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  if (node.config.on_error && !SUPPORTED_NODE_ERROR_MODES.has(node.config.on_error)) {
    issues.push({
      code: 'MAP_ON_ERROR_INVALID',
      message: `Node "${node.label ?? node.id}" must use on_error "fail" or "continue".`,
      target: node.id,
      severity: 'error',
    })
  }

  validateInputMappings(node, node.config.input_mappings, 'MAP_INPUT_MAPPING_INVALID', issues, nodeIds)
}

function validateGadgetNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'gadget' }>,
  issues: ResolutionBlueprintValidationIssue[],
  options: ResolutionBlueprintValidationOptions,
  nodeIds: Set<string>,
) {
  const sourceCount =
    (node.config.blueprint_json?.trim() ? 1 : 0) +
    (node.config.blueprint_json_key?.trim() ? 1 : 0) +
    (node.config.inline ? 1 : 0)

  if (sourceCount === 0) {
    issues.push({
      code: 'GADGET_SOURCE_REQUIRED',
      message: `Node "${node.label ?? node.id}" must define blueprint_json, blueprint_json_key, or inline.`,
      target: node.id,
      severity: 'error',
    })
  }

  if (sourceCount > 1) {
    issues.push({
      code: 'GADGET_SOURCE_CONFLICT',
      message: `Node "${node.label ?? node.id}" may only define one child blueprint source.`,
      target: node.id,
      severity: 'error',
    })
  }

  if (node.config.blueprint_json_key !== undefined) {
    validateLookupKey(
      node.config.blueprint_json_key,
      {
        code: 'GADGET_BLUEPRINT_JSON_KEY_INVALID',
        message: `Node "${node.label ?? node.id}" must use an engine namespaced blueprint_json_key.`,
        target: node.id,
      },
      issues,
    )
  }

  if ((node.config.timeout_seconds ?? 0) < 0 || (node.config.max_depth ?? 0) < 0) {
    issues.push({
      code: 'GADGET_LIMIT_INVALID',
      message: `Node "${node.label ?? node.id}" must use non-negative timeout and max_depth values.`,
      target: node.id,
      severity: 'error',
    })
  }

  validateDynamicBlueprintPolicy(node.config.dynamic_blueprint_policy, node, issues)
  validateInputMappings(node, node.config.input_mappings, 'GADGET_INPUT_MAPPING_INVALID', issues, nodeIds)

  if (node.config.inline) {
    validateChildBlueprint(node, node.config.inline, 'GADGET_INLINE', issues, options)
  }

  if (node.config.blueprint_json?.trim()) {
    try {
      const parsed = JSON.parse(node.config.blueprint_json) as ResolutionBlueprint
      validateChildBlueprint(node, parsed, 'GADGET_BLUEPRINT_JSON', issues, options)
    } catch {
      issues.push({
        code: 'GADGET_BLUEPRINT_JSON_INVALID',
        message: `Node "${node.label ?? node.id}" has invalid blueprint_json text.`,
        target: node.id,
        severity: 'error',
      })
    }
  }
}

function validateValidateBlueprintNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'validate_blueprint' }>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  validateLookupKey(
    node.config.blueprint_json_key,
    {
      code: 'VALIDATE_BLUEPRINT_KEY_INVALID',
      message: `Node "${node.label ?? node.id}" must use an engine namespaced blueprint_json_key.`,
      target: node.id,
    },
    issues,
  )
}

function validateReturnNode(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'return' }>,
  issues: ResolutionBlueprintValidationIssue[],
  nodeIds: Set<string>,
) {
  const cfg = node.config as ReturnConfig
  const hasValue = cfg.value !== undefined
  const hasFromKey = Boolean(cfg.from_key?.trim())

  if (hasValue === hasFromKey) {
    issues.push({
      code: 'RETURN_CONFIG_INVALID',
      message: `Node "${node.label ?? node.id}" must define exactly one of value or from_key.`,
      target: node.id,
      severity: 'error',
    })
    return
  }

  if (hasFromKey) {
    validateLookupKey(
      cfg.from_key,
      {
        code: 'RETURN_FROM_KEY_INVALID',
        message: `Node "${node.label ?? node.id}" must use an engine namespaced from_key.`,
        target: node.id,
      },
      issues,
    )
    validateResultsNodeReference(cfg.from_key ?? '', nodeIds, node.id, 'RETURN_FROM_KEY_UNKNOWN_SOURCE', issues)
    return
  }

  if (!cfg.value || Array.isArray(cfg.value) || typeof cfg.value !== 'object') {
    issues.push({
      code: 'RETURN_VALUE_INVALID',
      message: `Node "${node.label ?? node.id}" must use a JSON object for value.`,
      target: node.id,
      severity: 'error',
    })
    return
  }

  if (typeof cfg.value.status !== 'string' || !cfg.value.status.trim()) {
    issues.push({
      code: 'RETURN_STATUS_REQUIRED',
      message: `Node "${node.label ?? node.id}" must include a non-empty value.status string.`,
      target: node.id,
      severity: 'error',
    })
  }
}

function validateLLMSelection(
  provider: string | undefined,
  model: string | undefined,
  node: ResolutionBlueprintNodeDef,
  issues: ResolutionBlueprintValidationIssue[],
  prefix: 'LLM' | 'AGENT',
) {
  const trimmedProvider = provider?.trim()
  const trimmedModel = model?.trim()
  if (!trimmedProvider && !trimmedModel) {
    return
  }

  if (trimmedProvider && !isLLMProvider(trimmedProvider)) {
    issues.push({
      code: `${prefix}_PROVIDER_UNSUPPORTED`,
      message: `Node "${node.label ?? node.id}" uses unsupported provider "${trimmedProvider}".`,
      target: node.id,
      severity: 'error',
    })
    return
  }

  if (!trimmedModel) {
    return
  }

  const inferredProvider = inferLLMProviderFromModel(trimmedModel)
  if (!inferredProvider) {
    issues.push({
      code: `${prefix}_MODEL_UNSUPPORTED`,
      message: `Node "${node.label ?? node.id}" uses unsupported model "${trimmedModel}".`,
      target: node.id,
      severity: 'error',
    })
    return
  }

  if (trimmedProvider && isLLMProvider(trimmedProvider) && !isLLMModelCompatible(trimmedProvider, trimmedModel)) {
    issues.push({
      code: `${prefix}_PROVIDER_MODEL_MISMATCH`,
      message: `Node "${node.label ?? node.id}" mixes provider "${trimmedProvider}" with model "${trimmedModel}".`,
      target: node.id,
      severity: 'error',
    })
  }
}

function validateAgentTool(
  node: Extract<ResolutionBlueprintNodeDef, { type: 'agent_loop' }>,
  tool: AgentToolConfig,
  index: number,
  issues: ResolutionBlueprintValidationIssue[],
) {
  const target = `${node.id}.tools[${index}]`
  const kind = tool.kind?.trim()

  if (!tool.name.trim()) {
    issues.push({
      code: 'AGENT_TOOL_NAME_REQUIRED',
      message: `Node "${node.label ?? node.id}" has a tool without a name.`,
      target,
      severity: 'error',
    })
  }

  if (kind && !SUPPORTED_AGENT_TOOL_KINDS.has(kind)) {
    issues.push({
      code: 'AGENT_TOOL_KIND_INVALID',
      message: `Node "${node.label ?? node.id}" uses unsupported tool kind "${tool.kind}".`,
      target,
      severity: 'error',
    })
  }

  const resolvedKind = kind || (tool.inline ? 'blueprint' : tool.builtin ? 'builtin' : '')
  if (!resolvedKind) {
    issues.push({
      code: 'AGENT_TOOL_KIND_REQUIRED',
      message: `Node "${node.label ?? node.id}" must define a builtin or inline blueprint tool.`,
      target,
      severity: 'error',
    })
  }

  if (resolvedKind === 'builtin') {
    if (!tool.builtin || !SUPPORTED_AGENT_BUILTINS.has(tool.builtin)) {
      issues.push({
        code: 'AGENT_TOOL_BUILTIN_INVALID',
        message: `Node "${node.label ?? node.id}" uses unsupported builtin "${tool.builtin ?? ''}".`,
        target,
        severity: 'error',
      })
    }
  }

  if (resolvedKind === 'blueprint') {
    if (!tool.inline) {
      issues.push({
        code: 'AGENT_TOOL_INLINE_REQUIRED',
        message: `Node "${node.label ?? node.id}" needs an inline blueprint tool definition.`,
        target,
        severity: 'error',
      })
    } else {
      validateChildBlueprint(node, tool.inline, 'AGENT_TOOL_INLINE', issues, {})
    }
  }

  if ((tool.timeout_seconds ?? 0) < 0 || (tool.max_depth ?? 0) < 0) {
    issues.push({
      code: 'AGENT_TOOL_LIMIT_INVALID',
      message: `Node "${node.label ?? node.id}" must use non-negative tool timeout and max_depth values.`,
      target,
      severity: 'error',
    })
  }

  for (const [childKey, parentKey] of Object.entries(tool.input_mappings ?? {})) {
    if (!childKey.trim()) {
      issues.push({
        code: 'AGENT_TOOL_INPUT_MAPPING_INVALID',
        message: `Node "${node.label ?? node.id}" has a blank tool input mapping key.`,
        target,
        severity: 'error',
      })
      continue
    }
    validateLookupKey(
      parentKey,
      {
        code: 'AGENT_TOOL_INPUT_MAPPING_INVALID',
        message: `Node "${node.label ?? node.id}" must map tool inputs from engine namespaced parent keys.`,
        target,
      },
      issues,
    )
  }
}

function validateDynamicBlueprintPolicy(
  policy: DynamicBlueprintPolicy | undefined,
  node: ResolutionBlueprintNodeDef,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!policy) return

  for (const [name, value] of [
    ['max_nodes', policy.max_nodes],
    ['max_edges', policy.max_edges],
    ['max_depth', policy.max_depth],
    ['max_total_time_seconds', policy.max_total_time_seconds],
    ['max_total_tokens', policy.max_total_tokens],
  ] as const) {
    if ((value ?? 0) < 0) {
      issues.push({
        code: 'DYNAMIC_BLUEPRINT_POLICY_INVALID',
        message: `Node "${node.label ?? node.id}" must use a non-negative ${name} in dynamic_blueprint_policy.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  for (const nodeType of policy.allowed_node_types ?? []) {
    if (!(nodeType in RESOLUTION_NODE_CAPABILITIES)) {
      issues.push({
        code: 'DYNAMIC_BLUEPRINT_POLICY_NODE_TYPE_INVALID',
        message: `Node "${node.label ?? node.id}" allows unknown node type "${nodeType}".`,
        target: node.id,
        severity: 'error',
      })
    }
  }
}

function validateChildBlueprint(
  node: ResolutionBlueprintNodeDef,
  blueprint: ResolutionBlueprint,
  prefix: 'MAP_INLINE' | 'GADGET_INLINE' | 'GADGET_BLUEPRINT_JSON' | 'AGENT_TOOL_INLINE',
  issues: ResolutionBlueprintValidationIssue[],
  options: ResolutionBlueprintValidationOptions,
) {
  const childValidation = validateResolutionBlueprint(blueprint, options)
  for (const issue of childValidation.issues) {
    issues.push({
      code: `${prefix}_${issue.code}`,
      message: `Node "${node.label ?? node.id}" child blueprint: ${issue.message}`,
      target: issue.target ? `${node.id}:${issue.target}` : node.id,
      severity: issue.severity,
    })
  }

  const suspensionNode = findSuspensionCapableNode(blueprint)
  if (suspensionNode) {
    issues.push({
      code: `${prefix}_SUSPENSION_NODE`,
      message:
        `Node "${node.label ?? node.id}" child blueprint contains suspension-capable node ` +
        `"${suspensionNode.label ?? suspensionNode.id}" (${suspensionNode.type}).`,
      target: node.id,
      severity: 'error',
    })
  }
}

function findSuspensionCapableNode(blueprint: ResolutionBlueprint): ResolutionBlueprintNodeDef | null {
  return blueprint.nodes.find((node) => nodeCanSuspend(node)) ?? null
}

function nodeCanSuspend(node: ResolutionBlueprintNodeDef): boolean {
  switch (node.type) {
    case 'await_signal':
      return true
    case 'agent_loop':
      return Boolean(node.config.async)
    case 'wait':
      return waitCanSuspend(node.config)
    default:
      return false
  }
}

function waitCanSuspend(config: WaitConfig): boolean {
  const mode = config.mode?.trim() || 'sleep'
  if (mode !== 'sleep') return true
  const duration = Math.max(0, Number(config.duration_seconds) || 0)
  if (duration === 0) return false
  return duration > resolveInlineWaitCap(config)
}

function resolveInlineWaitCap(config: WaitConfig): number {
  if ((config.max_inline_seconds ?? 0) < 0) return 0
  if ((config.max_inline_seconds ?? 0) > 0) return config.max_inline_seconds!
  return 20
}

function validateInputMappings(
  node: ResolutionBlueprintNodeDef,
  inputMappings: Record<string, string> | undefined,
  code: string,
  issues: ResolutionBlueprintValidationIssue[],
  nodeIds: Set<string>,
) {
  for (const [childKey, parentKey] of Object.entries(inputMappings ?? {})) {
    if (!childKey.trim()) {
      issues.push({
        code,
        message: `Node "${node.label ?? node.id}" has a blank input mapping key.`,
        target: node.id,
        severity: 'error',
      })
      continue
    }
    validateLookupKey(
      parentKey,
      {
        code,
        message: `Node "${node.label ?? node.id}" must map child inputs from engine namespaced parent keys.`,
        target: node.id,
      },
      issues,
    )
    validateResultsNodeReference(parentKey, nodeIds, node.id, code, issues)
  }
}

function validateStringRecord(
  nodeID: string,
  label: string | undefined,
  record: Record<string, string> | undefined,
  code: string,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!record) return
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      issues.push({
        code,
        message: `Node "${label ?? nodeID}" must use string values for "${key}".`,
        target: nodeID,
        severity: 'error',
      })
    }
  }
}

function validateLookupKey(
  value: string | undefined,
  issue: Pick<ResolutionBlueprintValidationIssue, 'code' | 'message' | 'target'>,
  issues: ResolutionBlueprintValidationIssue[],
) {
  if (!isNamespacedLookupKey(value)) {
    issues.push({ ...issue, severity: 'error' })
  }
}

function isNamespacedLookupKey(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return false
  return (
    /^inputs\.[A-Za-z0-9_.-]+$/.test(trimmed) ||
    /^run\.[A-Za-z0-9_.-]+$/.test(trimmed) ||
    /^results\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(trimmed)
  )
}

function validateResultsNodeReference(
  value: string,
  nodeIds: Set<string>,
  target: string,
  code: string,
  issues: ResolutionBlueprintValidationIssue[],
) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('results.')) return
  const match = /^results\.([A-Za-z0-9_-]+)\./.exec(trimmed)
  if (!match?.[1]) return
  if (!nodeIds.has(match[1])) {
    issues.push({
      code,
      message: `Node "${target}" references unknown source node "${match[1]}".`,
      target,
      severity: 'error',
    })
  }
}

function validateEdgeCondition(
  edge: ResolutionBlueprintEdgeDef,
  nodeIds: Set<string>,
): ResolutionBlueprintValidationIssue[] {
  const issues: ResolutionBlueprintValidationIssue[] = []
  const condition = edge.condition?.trim()
  if (!condition) return issues

  const edgeId = `${edge.from}->${edge.to}`
  const syntaxError = findConditionSyntaxError(condition)
  if (syntaxError) {
    issues.push({
      code: 'EDGE_CONDITION_INVALID',
      message: `Edge "${edgeId}" has malformed condition syntax: ${syntaxError}.`,
      target: edgeId,
      severity: 'error',
    })
    return issues
  }

  const allowedRoots = new Set(['inputs', 'results', 'run'])
  for (const root of collectConditionRoots(condition)) {
    if (!allowedRoots.has(root)) {
      issues.push({
        code: 'EDGE_CONDITION_UNKNOWN_ROOT',
        message: `Edge "${edgeId}" references unsupported root "${root}". Use inputs.*, results.*, or run.*.`,
        target: edgeId,
        severity: 'error',
      })
    }
  }

  for (const match of condition.matchAll(/\bresults\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_.-]+\b/g)) {
    const nodeID = match[1]?.trim()
    if (nodeID && !nodeIds.has(nodeID)) {
      issues.push({
        code: 'EDGE_CONDITION_UNKNOWN_SOURCE',
        message: `Edge "${edgeId}" references unknown results node "${nodeID}".`,
        target: edgeId,
        severity: 'error',
      })
    }
  }

  return issues
}

function validateEdgeReferences(
  blueprint: ResolutionBlueprint,
  issues: ResolutionBlueprintValidationIssue[],
) {
  const nodeTypes = new Map(blueprint.nodes.map((node) => [node.id, node.type] as const))
  const keysByType = new Map<ResolutionBlueprintNodeType, Set<string>>()

  for (const edge of blueprint.edges) {
    const condition = edge.condition?.trim()
    if (!condition) continue

    const edgeID = `${edge.from}->${edge.to}`
    for (const match of condition.matchAll(/\bresults\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\b/g)) {
      const nodeID = match[1]?.trim()
      const key = match[2]?.trim()
      if (!nodeID || !key) continue

      const nodeType = nodeTypes.get(nodeID)
      if (!nodeType) continue

      if (key === 'status' || key === 'history') continue

      let knownKeys = keysByType.get(nodeType)
      if (!knownKeys) {
        const capability = RESOLUTION_NODE_CAPABILITIES[nodeType]
        knownKeys = knownOutputKeys(nodeType, capability.defaultConfig())
        keysByType.set(nodeType, knownKeys)
      }
      if (knownKeys.size === 0) continue
      if (knownKeys.has(key)) continue
      if (Array.from(knownKeys).some((candidate) => key.startsWith(`${candidate}.`))) continue

      issues.push({
        code: 'EDGE_UNKNOWN_OUTPUT_KEY',
        message: `Edge "${edgeID}" references "results.${nodeID}.${key}" but ${nodeType} does not declare that output key.`,
        target: edgeID,
        severity: 'warning',
      })
    }
  }
}

function knownOutputKeys(
  nodeType: ResolutionBlueprintNodeType,
  config: ResolutionBlueprintNodeDef['config'],
): Set<string> {
  switch (nodeType) {
    case 'api_fetch':
      return new Set(['status', 'outcome', 'raw', 'json_path_value', 'error', 'http_status'])
    case 'llm_call':
      return new Set(['status', 'outcome', 'reasoning', 'confidence', 'raw', 'citations_json', 'error'])
    case 'agent_loop':
      return new Set([
        'status',
        'error',
        'outcome',
        'summary',
        'text',
        'output_json',
        'raw',
        'resolution_status',
        'confidence',
        'reasoning',
        'citations_json',
        'citations_count',
        'tool_calls_count',
        'tool_calls_json',
        'steps_json',
        'transcript_tail',
      ])
    case 'await_signal':
      return new Set(['status'])
    case 'wait':
      return new Set(['status', 'waited', 'mode', 'start_from', 'anchor_ts', 'ready_at', 'remaining_seconds'])
    case 'cel_eval':
      return new Set(['status', ...Object.keys((config as { expressions?: Record<string, string> }).expressions ?? {})])
    case 'map':
      return new Set([
        'status',
        'results',
        'total_items',
        'total_batches',
        'completed_batches',
        'failed_batches',
        'skipped_batches',
        'first_error',
      ])
    case 'gadget':
      return new Set(['status', 'error', 'run_status', 'child_run_id', 'return_json'])
    case 'validate_blueprint':
      return new Set([
        'status',
        'valid',
        'issue_count',
        'issues_json',
        'issues_text',
        'blueprint_json',
        'first_issue_code',
        'first_issue_message',
        'first_issue_target',
      ])
    case 'return':
      return new Set(['status'])
  }
}

function findConditionSyntaxError(condition: string): string | null {
  let parenDepth = 0
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let index = 0; index < condition.length; index += 1) {
    const char = condition[index]
    const previous = index > 0 ? condition[index - 1] : ''
    const escaped = previous === '\\'

    if (!inDoubleQuote && char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (!inSingleQuote && char === '"' && !escaped) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (inSingleQuote || inDoubleQuote) continue

    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth -= 1
      if (parenDepth < 0) {
        return 'unbalanced parentheses'
      }
    }
  }

  if (inSingleQuote || inDoubleQuote) return 'unterminated string literal'
  if (parenDepth !== 0) return 'unbalanced parentheses'
  return null
}

function collectConditionRoots(condition: string): Set<string> {
  const roots = new Set<string>()
  const rootPattern = /(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g

  for (const match of condition.matchAll(rootPattern)) {
    const root = match[1]?.trim()
    if (root) roots.add(root)
  }

  return roots
}

function collectForwardEdges(
  edges: ResolutionBlueprintEdgeDef[],
  backEdges: Set<string>,
): ResolutionBlueprintEdgeDef[] {
  return edges.filter((edge) => !backEdges.has(`${edge.from}->${edge.to}`))
}

function getRootNodes(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): string[] {
  const hasIncoming = new Set(edges.map((edge) => edge.to))
  return nodes.map((node) => node.id).filter((nodeId) => !hasIncoming.has(nodeId))
}

function reachableViaEdges(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
  roots: string[],
): Set<string> {
  const adjacency = buildAdjacency(nodes, edges)
  const reachable = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const nodeID = queue.shift()
    if (!nodeID || reachable.has(nodeID)) continue
    reachable.add(nodeID)
    for (const neighbor of adjacency.get(nodeID) ?? []) {
      queue.push(neighbor)
    }
  }

  return reachable
}

function buildAdjacency(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) {
    adjacency.set(node.id, [])
  }
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.from) ?? []
    outgoing.push(edge.to)
    adjacency.set(edge.from, outgoing)
  }
  return adjacency
}

function buildOutgoingMap(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): Map<string, ResolutionBlueprintEdgeDef[]> {
  const outgoing = new Map<string, ResolutionBlueprintEdgeDef[]>()
  for (const node of nodes) {
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    const next = outgoing.get(edge.from) ?? []
    next.push(edge)
    outgoing.set(edge.from, next)
  }
  return outgoing
}

function computeReachabilityToReturn(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): Set<string> {
  const reverse = new Map<string, string[]>()
  for (const node of nodes) {
    reverse.set(node.id, [])
  }

  for (const edge of edges) {
    const incoming = reverse.get(edge.to) ?? []
    incoming.push(edge.from)
    reverse.set(edge.to, incoming)
  }

  const reachable = new Set<string>()
  const queue = nodes
    .filter((node) => TERMINAL_NODE_TYPES.has(node.type))
    .map((node) => node.id)

  while (queue.length > 0) {
    const nodeID = queue.shift()
    if (!nodeID || reachable.has(nodeID)) continue
    reachable.add(nodeID)
    for (const source of reverse.get(nodeID) ?? []) {
      queue.push(source)
    }
  }

  return reachable
}

function safeJSONStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}
