import type { NormalizedIndexerLpStake, NormalizedIndexerMarket } from '../clients/market-schema.js'

export interface IndexerClientConfig {
  baseUrl: string
  auth?: string
  authHeader?: string
  timeoutMs?: number
}

export type IndexerMarketsResponse = NormalizedIndexerMarket[]
export type IndexerMarketResponse = NormalizedIndexerMarket
export type IndexerMarketTrade = Record<string, unknown>
export type IndexerMarketTradesResponse = IndexerMarketTrade[]
export type IndexerPriceHistoryPoint = Record<string, unknown>
export type IndexerPriceHistoryResponse = IndexerPriceHistoryPoint[]
export type IndexerPosition = Record<string, unknown>
export type IndexerMarketPosition = IndexerPosition
export type IndexerUserPosition = IndexerPosition
export type IndexerMarketPositionsResponse = IndexerMarketPosition[]
export type IndexerUserPositionsResponse = IndexerUserPosition[]
export type IndexerUserLpResponse = NormalizedIndexerLpStake[]
export type IndexerUserTrade = Record<string, unknown>
export type IndexerUserTradesResponse = IndexerUserTrade[]
export type IndexerLeaderboardEntry = Record<string, unknown>
export type IndexerLeaderboardResponse = IndexerLeaderboardEntry[]
export type IndexerHealthResponse = Record<string, unknown>

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_LIMIT = 1_000

function encodeBasicAuth(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

function assertLimit(limit: number): void {
  assertPositiveInteger(limit, 'limit')
  if (limit > MAX_LIMIT) {
    throw new Error(`limit must be <= ${MAX_LIMIT}`)
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value))
    }
  }
  const query = searchParams.toString()
  return query.length > 0 ? `?${query}` : ''
}

export class IndexerClient {
  private readonly baseUrl: string
  private readonly authHeader?: string
  private readonly timeoutMs: number

  constructor(config: IndexerClientConfig) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/$/, '')
    if (normalizedBaseUrl.length === 0) {
      throw new Error('baseUrl is required')
    }

    this.baseUrl = normalizedBaseUrl
    this.authHeader = config.authHeader ?? (config.auth ? `Basic ${encodeBasicAuth(config.auth)}` : undefined)
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private headers(): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader } : {}
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(`Indexer request timed out after ${this.timeoutMs}ms`), this.timeoutMs)

    try {
      const resp = await fetch(url, {
        headers: this.headers(),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const responseText = (await resp.text()).trim()
        const responseDetail = responseText.length > 0 ? ` - ${responseText}` : ''
        throw new Error(`Indexer GET ${url} failed: ${resp.status} ${resp.statusText}${responseDetail}`)
      }

      if (resp.status === 204) {
        return undefined as T
      }

      return await resp.json() as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Indexer GET ${url} timed out after ${this.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async listMarkets(opts?: { status?: number }): Promise<IndexerMarketsResponse> {
    if (opts?.status !== undefined) {
      assertNonNegativeInteger(opts.status, 'status')
    }
    return this.get<IndexerMarketsResponse>(`/markets${buildQuery({ status: opts?.status })}`)
  }

  async getMarket(appId: number): Promise<IndexerMarketResponse> {
    assertPositiveInteger(appId, 'appId')
    return this.get<IndexerMarketResponse>(`/markets/${appId}`)
  }

  async getMarketTrades(appId: number, limit = 50): Promise<IndexerMarketTradesResponse> {
    assertPositiveInteger(appId, 'appId')
    assertLimit(limit)
    return this.get<IndexerMarketTradesResponse>(`/markets/${appId}/trades${buildQuery({ limit })}`)
  }

  async getPriceHistory(appId: number, limit = 100): Promise<IndexerPriceHistoryResponse> {
    assertPositiveInteger(appId, 'appId')
    assertLimit(limit)
    return this.get<IndexerPriceHistoryResponse>(`/markets/${appId}/prices${buildQuery({ limit })}`)
  }

  async getMarketPositions(appId: number): Promise<IndexerMarketPositionsResponse> {
    assertPositiveInteger(appId, 'appId')
    return this.get<IndexerMarketPositionsResponse>(`/markets/${appId}/positions`)
  }

  async getMarketLp(appId: number): Promise<IndexerUserLpResponse> {
    assertPositiveInteger(appId, 'appId')
    return this.get<IndexerUserLpResponse>(`/markets/${appId}/lp`)
  }

  async getUserPositions(address: string): Promise<IndexerUserPositionsResponse> {
    return this.get<IndexerUserPositionsResponse>(`/users/${encodeURIComponent(address)}/positions`)
  }

  async getUserTrades(address: string, limit = 50): Promise<IndexerUserTradesResponse> {
    assertLimit(limit)
    return this.get<IndexerUserTradesResponse>(`/users/${encodeURIComponent(address)}/trades${buildQuery({ limit })}`)
  }

  async getUserLp(address: string): Promise<IndexerUserLpResponse> {
    return this.get<IndexerUserLpResponse>(`/users/${encodeURIComponent(address)}/lp`)
  }

  async getLeaderboard(): Promise<IndexerLeaderboardResponse> {
    return this.get<IndexerLeaderboardResponse>('/leaderboard')
  }

  async health(): Promise<IndexerHealthResponse> {
    return this.get<IndexerHealthResponse>('/health')
  }
}
