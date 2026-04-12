import { describe, expect, it } from 'vitest'
import { detectCycles, isBackEdge } from './cycle-detection'
import type { ResolutionBlueprintNodeDef, ResolutionBlueprintEdgeDef } from './types'

function node(id: string): ResolutionBlueprintNodeDef {
  return { id, type: 'wait', label: id, config: { duration_seconds: 1, mode: 'sleep', start_from: 'deadline' }, position: { x: 0, y: 0 } }
}

function edge(from: string, to: string): ResolutionBlueprintEdgeDef {
  return { from, to }
}

describe('detectCycles', () => {
  it('returns no cycles for a linear DAG', () => {
    const result = detectCycles(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c')],
    )
    expect(result.hasCycles).toBe(false)
    expect(result.backEdgeIds).toEqual([])
    expect(result.loopRegions).toEqual([])
  })

  it('returns no cycles for a diamond DAG', () => {
    const result = detectCycles(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    )
    expect(result.hasCycles).toBe(false)
  })

  it('detects a simple two-node cycle', () => {
    const result = detectCycles(
      [node('a'), node('b')],
      [edge('a', 'b'), edge('b', 'a')],
    )
    expect(result.hasCycles).toBe(true)
    expect(result.backEdgeIds.length).toBe(1)
    expect(result.loopRegions.length).toBe(1)
    expect(result.loopRegions[0]).toContain('a')
    expect(result.loopRegions[0]).toContain('b')
  })

  it('detects a self-loop', () => {
    const result = detectCycles(
      [node('a'), node('b')],
      [edge('a', 'b'), edge('a', 'a')],
    )
    expect(result.hasCycles).toBe(true)
    expect(result.backEdgeIds).toContain('a->a')
  })

  it('detects a three-node cycle', () => {
    const result = detectCycles(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    )
    expect(result.hasCycles).toBe(true)
    expect(result.loopRegions.length).toBe(1)
    expect(result.loopRegions[0].length).toBe(3)
  })

  it('handles disconnected components with one cycle', () => {
    const result = detectCycles(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('c', 'd'), edge('d', 'c')],
    )
    expect(result.hasCycles).toBe(true)
    expect(result.loopRegions.length).toBe(1)
    expect(result.loopRegions[0]).toContain('c')
    expect(result.loopRegions[0]).toContain('d')
  })

  it('handles empty graph', () => {
    const result = detectCycles([], [])
    expect(result.hasCycles).toBe(false)
    expect(result.backEdgeIds).toEqual([])
  })

  it('handles single node no edges', () => {
    const result = detectCycles([node('a')], [])
    expect(result.hasCycles).toBe(false)
  })
})

describe('isBackEdge', () => {
  it('returns true for edges in the back-edge set', () => {
    const backEdges = new Set(['b->a'])
    expect(isBackEdge('b', 'a', backEdges)).toBe(true)
  })

  it('returns false for forward edges', () => {
    const backEdges = new Set(['b->a'])
    expect(isBackEdge('a', 'b', backEdges)).toBe(false)
  })
})
