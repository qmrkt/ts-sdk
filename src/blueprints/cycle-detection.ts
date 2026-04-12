import type { ResolutionBlueprintEdgeDef, ResolutionBlueprintNodeDef } from './types.js'

type Color = 'white' | 'gray' | 'black'

export interface CycleDetectionResult {
  hasCycles: boolean
  backEdges: Set<string>
  backEdgeIds: string[]
  loopRegions: string[][]
}

export function detectCycles(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
): CycleDetectionResult {
  const adjacency = new Map<string, string[]>()
  const nodeIds = new Set(nodes.map((node) => node.id))

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, [])
  }

  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? []
    targets.push(edge.to)
    adjacency.set(edge.from, targets)
  }

  const color = new Map<string, Color>()
  const backEdges = new Set<string>()
  const backEdgeIds: string[] = []

  for (const nodeId of nodeIds) {
    color.set(nodeId, 'white')
  }

  function dfs(nodeId: string) {
    color.set(nodeId, 'gray')

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const neighborColor = color.get(neighbor)
      if (neighborColor === 'gray') {
        const edgeId = `${nodeId}->${neighbor}`
        backEdges.add(edgeId)
        backEdgeIds.push(edgeId)
      } else if (neighborColor === 'white') {
        dfs(neighbor)
      }
    }

    color.set(nodeId, 'black')
  }

  for (const nodeId of nodeIds) {
    if (color.get(nodeId) === 'white') {
      dfs(nodeId)
    }
  }

  const loopRegions = findStronglyConnectedComponents(nodes, edges, backEdges)

  return {
    hasCycles: backEdges.size > 0,
    backEdges,
    backEdgeIds,
    loopRegions,
  }
}

function findStronglyConnectedComponents(
  nodes: ResolutionBlueprintNodeDef[],
  edges: ResolutionBlueprintEdgeDef[],
  backEdges: Set<string>,
): string[][] {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const adjacency = new Map<string, string[]>()

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, [])
  }

  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? []
    targets.push(edge.to)
    adjacency.set(edge.from, targets)
  }

  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let currentIndex = 0

  function strongConnect(nodeId: string) {
    index.set(nodeId, currentIndex)
    lowlink.set(nodeId, currentIndex)
    currentIndex += 1
    stack.push(nodeId)
    onStack.add(nodeId)

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (!index.has(neighbor)) {
        strongConnect(neighbor)
        lowlink.set(nodeId, Math.min(lowlink.get(nodeId) ?? Infinity, lowlink.get(neighbor) ?? Infinity))
      } else if (onStack.has(neighbor)) {
        lowlink.set(nodeId, Math.min(lowlink.get(nodeId) ?? Infinity, index.get(neighbor) ?? Infinity))
      }
    }

    if (lowlink.get(nodeId) === index.get(nodeId)) {
      const component: string[] = []
      let nextNode = ''

      do {
        nextNode = stack.pop() ?? ''
        onStack.delete(nextNode)
        component.push(nextNode)
      } while (nextNode !== nodeId)

      if (component.length > 1) {
        components.push(component)
      } else if (component.length === 1 && backEdges.has(`${component[0]}->${component[0]}`)) {
        components.push(component)
      }
    }
  }

  for (const nodeId of nodeIds) {
    if (!index.has(nodeId)) {
      strongConnect(nodeId)
    }
  }

  return components
}

export function isBackEdge(
  from: string,
  to: string,
  backEdges: Set<string>,
): boolean {
  return backEdges.has(`${from}->${to}`)
}
