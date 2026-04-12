export interface IndexerClientConfig {
  baseUrl: string
  auth?: string
}

export class IndexerClient {
  private baseUrl: string
  private auth?: string

  constructor(config: IndexerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.auth = config.auth
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.auth) {
      h['Authorization'] = `Basic ${btoa(this.auth)}`
    }
    return h
  }

  private async get(path: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() })
    if (!resp.ok) throw new Error(`Indexer ${path}: ${resp.status}`)
    return resp.json()
  }

  async listMarkets(opts?: { status?: number }): Promise<unknown> {
    const qs = opts?.status !== undefined ? `?status=${opts.status}` : ''
    return this.get(`/markets${qs}`)
  }

  async getMarket(appId: number): Promise<unknown> {
    return this.get(`/markets/${appId}`)
  }

  async getMarketTrades(appId: number, limit = 50): Promise<unknown> {
    return this.get(`/markets/${appId}/trades?limit=${limit}`)
  }

  async getPriceHistory(appId: number, limit = 100): Promise<unknown> {
    return this.get(`/markets/${appId}/prices?limit=${limit}`)
  }

  async getMarketPositions(appId: number): Promise<unknown> {
    return this.get(`/markets/${appId}/positions`)
  }

  async getMarketLp(appId: number): Promise<unknown> {
    return this.get(`/markets/${appId}/lp`)
  }

  async getUserPositions(address: string): Promise<unknown> {
    return this.get(`/users/${address}/positions`)
  }

  async getUserTrades(address: string, limit = 50): Promise<unknown> {
    return this.get(`/users/${address}/trades?limit=${limit}`)
  }

  async getUserLp(address: string): Promise<unknown> {
    return this.get(`/users/${address}/lp`)
  }

  async getLeaderboard(): Promise<unknown> {
    return this.get('/leaderboard')
  }

  async health(): Promise<unknown> {
    return this.get('/health')
  }
}
