import { describe, expect, it } from 'vitest'
import {
  RESOLUTION_NODE_CAPABILITIES,
  getNodeCapability,
  createDefaultNode,
  createNodeId,
  AUTHORABLE_NODE_TYPES,
} from './capabilities'
import type { ResolutionBlueprintNodeType, ResolutionBlueprint } from './types'

const ALL_NODE_TYPES: ResolutionBlueprintNodeType[] = [
  'api_fetch', 'market_evidence', 'llm_judge', 'human_judge',
  'wait', 'defer_resolution', 'submit_result', 'cancel_market',
]

describe('RESOLUTION_NODE_CAPABILITIES', () => {
  it('defines capabilities for all 8 node types', () => {
    expect(Object.keys(RESOLUTION_NODE_CAPABILITIES).length).toBe(8)
    for (const type of ALL_NODE_TYPES) {
      expect(RESOLUTION_NODE_CAPABILITIES[type]).toBeDefined()
      expect(RESOLUTION_NODE_CAPABILITIES[type].type).toBe(type)
    }
  })

  it('marks terminal nodes correctly', () => {
    const terminals = ALL_NODE_TYPES.filter(t => RESOLUTION_NODE_CAPABILITIES[t].terminal)
    expect(terminals).toContain('submit_result')
    expect(terminals).toContain('cancel_market')
    expect(terminals).toContain('defer_resolution')
    expect(terminals).not.toContain('api_fetch')
    expect(terminals).not.toContain('llm_judge')
  })

  it('assigns trust impact by node type', () => {
    expect(RESOLUTION_NODE_CAPABILITIES.llm_judge.trustImpact).toBe('agent_assisted')
    expect(RESOLUTION_NODE_CAPABILITIES.human_judge.trustImpact).toBe('human_judged')
    expect(RESOLUTION_NODE_CAPABILITIES.api_fetch.trustImpact).toBe('objective')
    expect(RESOLUTION_NODE_CAPABILITIES.submit_result.trustImpact).toBe('objective')
  })

  it('terminal nodes do not support outgoing edges', () => {
    for (const type of ALL_NODE_TYPES) {
      const cap = RESOLUTION_NODE_CAPABILITIES[type]
      if (cap.terminal) {
        expect(cap.supportsOutgoing).toBe(false)
      }
    }
  })
})

describe('getNodeCapability', () => {
  it('returns the correct capability for each type', () => {
    expect(getNodeCapability('llm_judge').label).toBe('LLM Judge')
    expect(getNodeCapability('api_fetch').label).toBe('API Fetch')
  })
})

describe('createDefaultNode', () => {
  it('creates a node with the correct type and default config', () => {
    const node = createDefaultNode('llm_judge', 'judge_1', { x: 100, y: 200 })
    expect(node.type).toBe('llm_judge')
    expect(node.id).toBe('judge_1')
    expect(node.position).toEqual({ x: 100, y: 200 })
    expect(node.config).toBeDefined()
    expect((node.config as any).provider).toBe('anthropic')
  })

  it('creates default nodes for all 8 types without throwing', () => {
    for (const type of ALL_NODE_TYPES) {
      const node = createDefaultNode(type, `test_${type}`, { x: 0, y: 0 })
      expect(node.type).toBe(type)
      expect(node.config).toBeDefined()
    }
  })
})

describe('createNodeId', () => {
  it('generates a unique id based on type prefix', () => {
    const blueprint: ResolutionBlueprint = {
      id: 'test', nodes: [], edges: [], version: 1,
    }
    expect(createNodeId('llm_judge', blueprint)).toBe('judge')
  })

  it('increments suffix when prefix is taken', () => {
    const blueprint: ResolutionBlueprint = {
      id: 'test',
      nodes: [
        createDefaultNode('llm_judge', 'judge', { x: 0, y: 0 }),
      ],
      edges: [],
      version: 1,
    }
    expect(createNodeId('llm_judge', blueprint)).toBe('judge_2')
  })
})

describe('AUTHORABLE_NODE_TYPES', () => {
  it('includes all 8 types in V1', () => {
    expect(AUTHORABLE_NODE_TYPES.length).toBe(8)
  })
})
