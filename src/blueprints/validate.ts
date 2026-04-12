import algosdk from 'algosdk'

import {
  AUTHORABLE_NODE_TYPES,
  RESOLUTION_NODE_CAPABILITIES,
  getNodeCapability,
} from './capabilities.js'
import { detectCycles } from './cycle-detection.js'
import { inferLLMProviderFromModel, isLLMModelCompatible, isLLMProvider } from './llm-models.js'
import type {
  ResolutionBlueprint,
  ResolutionBlueprintEdgeDef,
  ResolutionBlueprintNodeDef,
  ResolutionBlueprintValidationIssue,
  ResolutionBlueprintValidationResult,
} from './types.js'

const TERMINAL_NODE_TYPES = new Set(['submit_result', 'cancel_market', 'defer_resolution'])

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

  if (blueprint.nodes.length > 16) {
    issues.push({
      code: 'TOO_MANY_NODES',
      message: 'Blueprints are capped at 16 nodes in V1.',
      severity: 'error',
    })
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
        message: `"${node.type}" is not authorable in the V1 editor.`,
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

    for (const issue of validateEdgeCondition(edge, nodeIds)) {
      issues.push(issue)
    }
  }

  const cycleResult = detectCycles(blueprint.nodes, blueprint.edges)
  if (cycleResult.hasCycles) {
    for (const backEdgeId of cycleResult.backEdgeIds) {
      const edge = blueprint.edges.find((candidate) => `${candidate.from}->${candidate.to}` === backEdgeId)
      if (!edge?.max_traversals) {
        issues.push({
          code: 'BACK_EDGE_MISSING_MAX_TRAVERSALS',
          message: `Loop edge "${backEdgeId}" must set max traversals.`,
          target: backEdgeId,
          severity: 'error',
        })
      }
    }
  }

  const roots = getRootNodes(blueprint.nodes, blueprint.edges)
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
      code: 'NO_TERMINAL_NODE',
      message: 'Blueprint needs at least one terminal node.',
      severity: 'error',
    })
  }

  const adjacency = buildAdjacency(blueprint.nodes, blueprint.edges)
  const reachable = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      queue.push(neighbor)
    }
  }

  for (const node of blueprint.nodes) {
    if (!reachable.has(node.id) && roots.length > 0) {
      issues.push({
        code: 'UNREACHABLE_NODE',
        message: `Node "${node.label ?? node.id}" is unreachable from the graph roots.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  const outgoingByNode = new Map<string, ResolutionBlueprintEdgeDef[]>()
  for (const node of blueprint.nodes) {
    outgoingByNode.set(node.id, [])
  }
  for (const edge of blueprint.edges) {
    const outgoing = outgoingByNode.get(edge.from) ?? []
    outgoing.push(edge)
    outgoingByNode.set(edge.from, outgoing)
  }

  for (const node of blueprint.nodes) {
    const outgoing = outgoingByNode.get(node.id) ?? []
    if (TERMINAL_NODE_TYPES.has(node.type)) {
      if (outgoing.length > 0) {
        issues.push({
          code: 'TERMINAL_HAS_OUTGOING',
          message: `Terminal node "${node.label ?? node.id}" cannot have outgoing edges.`,
          target: node.id,
          severity: 'error',
        })
      }
    } else if (outgoing.length === 0) {
      issues.push({
        code: 'NON_TERMINAL_LEAF',
        message: `Node "${node.label ?? node.id}" needs an outgoing path to a terminal node.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

  const canReachTerminal = computeReachabilityToTerminal(blueprint.nodes, blueprint.edges)
  for (const node of blueprint.nodes) {
    if (!canReachTerminal.has(node.id)) {
      issues.push({
        code: 'NO_TERMINAL_PATH',
        message: `Node "${node.label ?? node.id}" does not lead to any terminal action.`,
        target: node.id,
        severity: 'error',
      })
    }
  }

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
      if (!node.config.url.trim()) {
        issues.push({
          code: 'API_URL_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs a URL.`,
          target: node.id,
          severity: 'error',
        })
      }

      if (node.config.url.trim()) {
        try {
          new URL(node.config.url)
        } catch {
          issues.push({
            code: 'API_URL_INVALID',
            message: `Node "${node.label ?? node.id}" needs a valid absolute URL.`,
            target: node.id,
            severity: 'error',
          })
        }
      }
      if (!node.config.json_path.trim()) {
        issues.push({
          code: 'API_JSON_PATH_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs a JSON path.`,
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

        const outcomeIndex = Number(target)
        if (
          Array.isArray(options.marketOutcomes) &&
          options.marketOutcomes.length > 0 &&
          outcomeIndex >= options.marketOutcomes.length
        ) {
          issues.push({
            code: 'API_OUTCOME_MAPPING_UNKNOWN_OUTCOME',
            message: `Node "${node.label ?? node.id}" maps "${rawValue}" to outcome ${outcomeIndex}, but only ${options.marketOutcomes.length} market outcomes exist.`,
            target: node.id,
            severity: 'error',
          })
        }
      }
      break
    case 'market_evidence':
      break
    case 'llm_judge':
      if (node.config.provider && !isLLMProvider(node.config.provider)) {
        issues.push({
          code: 'LLM_PROVIDER_UNSUPPORTED',
          message: `Node "${node.label ?? node.id}" uses unsupported provider "${node.config.provider}".`,
          target: node.id,
          severity: 'error',
        })
      }

      if (node.config.model?.trim()) {
        const inferredProvider = inferLLMProviderFromModel(node.config.model)
        if (!inferredProvider) {
          issues.push({
            code: 'LLM_MODEL_UNSUPPORTED',
            message: `Node "${node.label ?? node.id}" uses unsupported model "${node.config.model}".`,
            target: node.id,
            severity: 'error',
          })
        } else if (isLLMProvider(node.config.provider) && !isLLMModelCompatible(node.config.provider, node.config.model)) {
          issues.push({
            code: 'LLM_PROVIDER_MODEL_MISMATCH',
            message: `Node "${node.label ?? node.id}" selects ${node.config.provider} but model "${node.config.model}" belongs to ${inferredProvider}.`,
            target: node.id,
            severity: 'error',
          })
        }
      }

      if (!node.config.prompt.trim()) {
        issues.push({
          code: 'LLM_PROMPT_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs a prompt.`,
          target: node.id,
          severity: 'error',
        })
      }
      break
    case 'human_judge':
      if (!node.config.prompt.trim()) {
        issues.push({
          code: 'HUMAN_PROMPT_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs a prompt.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (!Array.isArray(node.config.allowed_responders) || node.config.allowed_responders.length === 0) {
        issues.push({
          code: 'HUMAN_RESPONDERS_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs at least one allowed responder.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (
        !Number.isFinite(node.config.timeout_seconds) ||
        node.config.timeout_seconds < 300 ||
        node.config.timeout_seconds > 604800
      ) {
        issues.push({
          code: 'HUMAN_TIMEOUT_INVALID',
          message: `Node "${node.label ?? node.id}" needs a timeout between 300 and 604800 seconds.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (
        node.config.allowed_responders.includes('designated') &&
        !node.config.designated_address?.trim()
      ) {
        issues.push({
          code: 'HUMAN_DESIGNATED_ADDRESS_REQUIRED',
          message: `Node "${node.label ?? node.id}" has a designated responder but no address.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (
        node.config.allowed_responders.includes('designated') &&
        node.config.designated_address?.trim() &&
        !algosdk.isValidAddress(node.config.designated_address.trim())
      ) {
        issues.push({
          code: 'HUMAN_DESIGNATED_ADDRESS_INVALID',
          message: `Node "${node.label ?? node.id}" must use a valid Algorand address for the designated responder.`,
          target: node.id,
          severity: 'error',
        })
      }
      break
    case 'wait':
      if (!Number.isFinite(node.config.duration_seconds) || node.config.duration_seconds < 0) {
        issues.push({
          code: 'WAIT_DURATION_INVALID',
          message: `Node "${node.label ?? node.id}" needs a non-negative wait duration.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (node.config.mode && node.config.mode !== 'sleep' && node.config.mode !== 'defer') {
        issues.push({
          code: 'WAIT_MODE_INVALID',
          message: `Node "${node.label ?? node.id}" must use either sleep or defer mode.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (
        node.config.start_from &&
        node.config.start_from !== 'now' &&
        node.config.start_from !== 'deadline' &&
        node.config.start_from !== 'resolution_pending_since'
      ) {
        issues.push({
          code: 'WAIT_START_FROM_INVALID',
          message: `Node "${node.label ?? node.id}" has an unsupported wait anchor.`,
          target: node.id,
          severity: 'error',
        })
      }
      if (node.config.mode === 'defer' && node.config.start_from === 'now') {
        issues.push({
          code: 'WAIT_DEFER_START_NOW_UNSUPPORTED',
          message: `Node "${node.label ?? node.id}" cannot use "now" with defer mode.`,
          target: node.id,
          severity: 'error',
        })
      }
      break
    case 'defer_resolution':
      break
    case 'submit_result':
      if (!node.config.outcome_key?.trim()) {
        issues.push({
          code: 'SUBMIT_OUTCOME_KEY_REQUIRED',
          message: `Node "${node.label ?? node.id}" needs an outcome source.`,
          target: node.id,
          severity: 'error',
        })
      } else {
        const outcomeKey = node.config.outcome_key.trim()
        const [sourceNodeId, outputKey] = outcomeKey.split('.', 2)
        if (!sourceNodeId || !outputKey) {
          issues.push({
            code: 'SUBMIT_OUTCOME_KEY_INVALID',
            message: `Node "${node.label ?? node.id}" must reference an upstream context key like "judge.outcome".`,
            target: node.id,
            severity: 'error',
          })
        } else if (!nodeIds.has(sourceNodeId)) {
          issues.push({
            code: 'SUBMIT_OUTCOME_KEY_UNKNOWN_SOURCE',
            message: `Node "${node.label ?? node.id}" references unknown source node "${sourceNodeId}".`,
            target: node.id,
            severity: 'error',
          })
        }
      }
      break
    case 'cancel_market':
      break
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

  const allowedRoots = new Set(['market', 'input'])
  for (const root of collectConditionRoots(condition)) {
    if (!allowedRoots.has(root) && !nodeIds.has(root)) {
      issues.push({
        code: 'EDGE_CONDITION_UNKNOWN_SOURCE',
        message: `Edge "${edgeId}" references unknown context root "${root}".`,
        target: edgeId,
        severity: 'error',
      })
    }
  }

  return issues
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

  if (inSingleQuote || inDoubleQuote) {
    return 'unterminated string literal'
  }

  if (parenDepth !== 0) {
    return 'unbalanced parentheses'
  }

  return null
}

function collectConditionRoots(condition: string): Set<string> {
  const roots = new Set<string>()
  const rootPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g

  for (const match of condition.matchAll(rootPattern)) {
    const root = match[1]?.trim()
    if (root) roots.add(root)
  }

  return roots
}

function getRootNodes(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): string[] {
  const hasIncoming = new Set(edges.map((edge) => edge.to))
  return nodes.map((node) => node.id).filter((nodeId) => !hasIncoming.has(nodeId))
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

function computeReachabilityToTerminal(
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
    const nodeId = queue.shift()!
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const source of reverse.get(nodeId) ?? []) {
      queue.push(source)
    }
  }

  return reachable
}
