import { describe, expect, it } from 'vitest'
import {
  AUTHORABLE_NODE_TYPES,
  RESOLUTION_NODE_CAPABILITIES,
  createDefaultNode,
  createNodeId,
  getNodeCapability,
} from './capabilities'
import type { ResolutionBlueprint, ResolutionBlueprintNodeType } from './types'

const ALL_NODE_TYPES: ResolutionBlueprintNodeType[] = [
  'api_fetch',
  'llm_call',
  'agent_loop',
  'await_signal',
  'wait',
  'cel_eval',
  'map',
  'gadget',
  'validate_blueprint',
  'return',
]

describe('RESOLUTION_NODE_CAPABILITIES', () => {
  it('defines capabilities for all engine node types', () => {
    expect(Object.keys(RESOLUTION_NODE_CAPABILITIES).length).toBe(10)
    for (const type of ALL_NODE_TYPES) {
      expect(RESOLUTION_NODE_CAPABILITIES[type]).toBeDefined()
      expect(RESOLUTION_NODE_CAPABILITIES[type].type).toBe(type)
    }
  })

  it('marks terminal nodes correctly', () => {
    const terminals = ALL_NODE_TYPES.filter((type) => RESOLUTION_NODE_CAPABILITIES[type].terminal)
    expect(terminals).toEqual(['return'])
  })

  it('assigns trust impact by node type', () => {
    expect(RESOLUTION_NODE_CAPABILITIES.llm_call.trustImpact).toBe('agent_assisted')
    expect(RESOLUTION_NODE_CAPABILITIES.agent_loop.trustImpact).toBe('agent_assisted')
    expect(RESOLUTION_NODE_CAPABILITIES.await_signal.trustImpact).toBe('human_judged')
    expect(RESOLUTION_NODE_CAPABILITIES.api_fetch.trustImpact).toBe('objective')
    expect(RESOLUTION_NODE_CAPABILITIES.return.trustImpact).toBe('objective')
  })

  it('terminal nodes do not support outgoing edges', () => {
    for (const type of ALL_NODE_TYPES) {
      const capability = RESOLUTION_NODE_CAPABILITIES[type]
      if (capability.terminal) {
        expect(capability.supportsOutgoing).toBe(false)
      }
    }
  })
})

describe('getNodeCapability', () => {
  it('returns the correct capability for each type', () => {
    expect(getNodeCapability('llm_call').label).toBe('LLM Call')
    expect(getNodeCapability('api_fetch').label).toBe('API Fetch')
    expect(getNodeCapability('return').label).toBe('Return')
  })
})

describe('createDefaultNode', () => {
  it('creates an agent node with the correct default config', () => {
    const node = createDefaultNode('agent_loop', 'agent_1', { x: 100, y: 200 })
    expect(node.type).toBe('agent_loop')
    expect(node.id).toBe('agent_1')
    expect(node.position).toEqual({ x: 100, y: 200 })
    expect(node.config).toBeDefined()
    expect((node.config as { output_mode?: string }).output_mode).toBe('resolution')
  })

  it('creates default nodes for all engine node types without throwing', () => {
    for (const type of ALL_NODE_TYPES) {
      const node = createDefaultNode(type, `test_${type}`, { x: 0, y: 0 })
      expect(node.type).toBe(type)
      expect(node.config).toBeDefined()
    }
  })
})

describe('createNodeId', () => {
  it('generates a unique id based on the node prefix', () => {
    const blueprint: ResolutionBlueprint = {
      id: 'test',
      version: 1,
      nodes: [],
      edges: [],
    }
    expect(createNodeId('agent_loop', blueprint)).toBe('agent')
  })

  it('increments suffix when the prefix is already taken', () => {
    const blueprint: ResolutionBlueprint = {
      id: 'test',
      version: 1,
      nodes: [
        createDefaultNode('agent_loop', 'agent', { x: 0, y: 0 }),
      ],
      edges: [],
    }
    expect(createNodeId('agent_loop', blueprint)).toBe('agent_2')
  })
})

describe('AUTHORABLE_NODE_TYPES', () => {
  it('includes every engine node type', () => {
    expect(AUTHORABLE_NODE_TYPES).toEqual(ALL_NODE_TYPES)
  })
})
