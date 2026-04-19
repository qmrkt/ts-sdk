import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
  IndexerHealthResponse,
  IndexerLeaderboardEntry,
  IndexerLeaderboardResponse,
  IndexerMarketPositionsResponse,
  IndexerMarketResponse,
  IndexerMarketTradesResponse,
  IndexerMarketsResponse,
  IndexerPriceHistoryResponse,
  IndexerUserLpResponse,
  IndexerUserPositionsResponse,
  IndexerUserTradesResponse,
} from './client'
import { IndexerClient } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('IndexerClient', () => {
  it('exposes typed responses for public methods', () => {
    type Client = InstanceType<typeof IndexerClient>

    expectTypeOf<Client['listMarkets']>().returns.toEqualTypeOf<Promise<IndexerMarketsResponse>>()
    expectTypeOf<Client['getMarket']>().returns.toEqualTypeOf<Promise<IndexerMarketResponse>>()
    expectTypeOf<Client['getMarketTrades']>().returns.toEqualTypeOf<Promise<IndexerMarketTradesResponse>>()
    expectTypeOf<Client['getPriceHistory']>().returns.toEqualTypeOf<Promise<IndexerPriceHistoryResponse>>()
    expectTypeOf<Client['getMarketPositions']>().returns.toEqualTypeOf<Promise<IndexerMarketPositionsResponse>>()
    expectTypeOf<Client['getMarketLp']>().returns.toEqualTypeOf<Promise<IndexerUserLpResponse>>()
    expectTypeOf<Client['getUserPositions']>().returns.toEqualTypeOf<Promise<IndexerUserPositionsResponse>>()
    expectTypeOf<Client['getUserTrades']>().returns.toEqualTypeOf<Promise<IndexerUserTradesResponse>>()
    expectTypeOf<Client['getUserLp']>().returns.toEqualTypeOf<Promise<IndexerUserLpResponse>>()
    expectTypeOf<Client['getLeaderboard']>().returns.toEqualTypeOf<Promise<IndexerLeaderboardResponse>>()
    expectTypeOf<Client['health']>().returns.toEqualTypeOf<Promise<IndexerHealthResponse>>()

    expectTypeOf<IndexerLeaderboardResponse[number]>().toEqualTypeOf<IndexerLeaderboardEntry>()
  })

  it('uses configured request timeout and abort signal', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new IndexerClient({
      baseUrl: 'https://indexer.example/',
      timeoutMs: 1234,
    })

    await client.health()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('https://indexer.example/health')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('supports explicit bearer auth headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new IndexerClient({
      baseUrl: 'https://indexer.example',
      authHeader: 'Bearer secret-token',
    })

    await client.listMarkets()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
  })

  it('includes response body text in HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not authorized', {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'text/plain' },
    })))

    const client = new IndexerClient({
      baseUrl: 'https://indexer.example',
      authHeader: 'Bearer secret-token',
    })

    await expect(client.health()).rejects.toThrow(
      'Indexer GET https://indexer.example/health failed: 401 Unauthorized - not authorized',
    )
  })

  it('validates app ids and limit parameters before making requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new IndexerClient({ baseUrl: 'https://indexer.example' })

    await expect(client.getMarket(0)).rejects.toThrow('appId must be a positive integer')
    await expect(client.getMarketTrades(1, 0)).rejects.toThrow('limit must be a positive integer')
    await expect(client.getPriceHistory(1, 10_001)).rejects.toThrow('limit must be <= 1000')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes user addresses in path segments', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new IndexerClient({ baseUrl: 'https://indexer.example' })

    await client.getUserTrades('ADDR/with spaces', 25)

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('https://indexer.example/users/ADDR%2Fwith%20spaces/trades?limit=25')
  })

  it('preserves legacy basic auth support', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new IndexerClient({
      baseUrl: 'https://indexer.example',
      auth: 'user:pass',
    })

    await client.health()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(init?.headers).toMatchObject({ Authorization: 'Basic dXNlcjpwYXNz' })
  })
})
