/**
 * Seed testnet with Polymarket-style prediction markets.
 * Uses LLM judge blueprints with web search and IPFS images via Pinata.
 *
 * Usage:
 *   DEPLOYER_MNEMONIC="..." PINATA_JWT="..." npx tsx src/scripts/seed-testnet.ts
 *
 * Env vars:
 *   DEPLOYER_MNEMONIC  - 25-word mnemonic for the deployer account
 *   PINATA_JWT         - Pinata API JWT for IPFS image pinning
 *   ALGOD_SERVER       - defaults to https://testnet-api.4160.nodely.dev
 *   FACTORY_APP_ID     - defaults to 758374629
 *   PROTOCOL_CONFIG_APP_ID - defaults to 758374628
 *   USDC_ASA_ID        - defaults to 758374618
 */

import algosdk from 'algosdk'
import { createMarketAtomic } from '../clients/market-factory.js'
import { buy, getMarketState } from '../clients/question-market.js'
import { calculateBuyCost, SCALE } from '../index.js'
import type { ClientConfig } from '../clients/base.js'

const ALGOD_SERVER = process.env.ALGOD_SERVER || 'https://testnet-api.4160.nodely.dev'
const ALGOD_PORT = Number(process.env.ALGOD_PORT || '443')
const ALGOD_TOKEN = process.env.ALGOD_TOKEN || ''
const FACTORY_APP_ID = Number(process.env.FACTORY_APP_ID || '758374629')
const PROTOCOL_CONFIG_APP_ID = Number(process.env.PROTOCOL_CONFIG_APP_ID || '758374628')
const USDC_ASA_ID = Number(process.env.USDC_ASA_ID || '758374618')
const PINATA_JWT = process.env.PINATA_JWT || ''

const textEncoder = new TextEncoder()

// ── Account ──────────────────────────────────────────────────────────────────

function getAccount(): { addr: string; signer: algosdk.TransactionSigner } {
  const mnemonic = process.env.DEPLOYER_MNEMONIC
  if (!mnemonic) {
    console.error('ERROR: DEPLOYER_MNEMONIC required')
    process.exit(1)
  }
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic.trim())
  const signer = algosdk.makeBasicAccountTransactionSigner({ addr, sk } as any)
  return { addr: addr.toString(), signer }
}

// ── IPFS Image Pinning ───────────────────────────────────────────────────────

async function pinImageFromUrl(imageUrl: string, jwt: string): Promise<string | null> {
  try {
    const resp = await fetch(imageUrl, { redirect: 'follow' })
    if (!resp.ok) return null
    const contentType = resp.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      console.error(`    Not an image: content-type=${contentType}`)
      return null
    }
    const buffer = await resp.arrayBuffer()
    if (buffer.byteLength > 2 * 1024 * 1024) return null
    if (buffer.byteLength < 100) return null

    const form = new FormData()
    const blob = new Blob([buffer], { type: contentType })
    form.append('file', blob, 'market-image')

    const pinResp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    })
    if (!pinResp.ok) {
      console.error(`    Pinata error: ${pinResp.status}`)
      return null
    }
    const result = await pinResp.json() as { IpfsHash?: string }
    return result.IpfsHash || null
  } catch (err: any) {
    console.error(`    Image pin failed: ${err.message}`)
    return null
  }
}

// ── LLM Judge Blueprint ──────────────────────────────────────────────────────

function buildLLMJudgeBlueprint(question: string, outcomes: string[], searchContext: string): Uint8Array {
  const prompt =
    `You are resolving a prediction market. Search the web for the most current, authoritative answer.\n\n` +
    `Question: ${question}\n` +
    `Possible outcomes: ${outcomes.map((o, i) => `${i}: ${o}`).join(', ')}\n\n` +
    `Search context: ${searchContext}\n\n` +
    `Instructions:\n` +
    `1. Search the web for the latest results, standings, or official announcements.\n` +
    `2. Use only authoritative sources (official league sites, government sources, major news outlets).\n` +
    `3. If the event has not yet occurred, return outcome_index for the most likely outcome with confidence "low".\n` +
    `4. If you find a definitive answer, return it with confidence "high" and cite your sources.\n` +
    `5. Return ONLY a JSON object with outcome_index, confidence, reasoning, and citations.`

  return textEncoder.encode(JSON.stringify({
    id: 'polymarket-llm-web-judge',
    version: 1,
    nodes: [
      {
        id: 'judge',
        type: 'llm_judge',
        config: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          prompt,
          require_citations: true,
          web_search: true,
          timeout_seconds: 120,
        },
      },
      { id: 'submit', type: 'submit_result', config: { outcome_key: 'judge.outcome' } },
      { id: 'cancel', type: 'cancel_market', config: { reason: 'LLM judge inconclusive after web search' } },
    ],
    edges: [
      { from: 'judge', to: 'submit', condition: "judge.outcome != 'inconclusive' && judge.outcome != ''" },
      { from: 'judge', to: 'cancel', condition: "judge.outcome == 'inconclusive' || judge.outcome == ''" },
    ],
    budget: {
      max_total_time_seconds: 3600,
      max_total_tokens: 200000,
    },
  }))
}

// ── Market Definitions ───────────────────────────────────────────────────────

interface MarketDef {
  question: string
  outcomes: string[]
  targetProbabilities: number[]
  liquidityUsdc: number
  deadlineDate: string
  category: string
  searchContext: string
  imageUrl: string
}

const MARKETS: MarketDef[] = [
  {
    question: 'Who will be the 2028 Democratic presidential nominee?',
    outcomes: ['Gavin Newsom', 'Gretchen Whitmer', 'Josh Shapiro', 'Other'],
    targetProbabilities: [0.28, 0.22, 0.15, 0.35],
    liquidityUsdc: 100,
    deadlineDate: '2028-08-30',
    category: 'Politics',
    searchContext: '2028 Democratic primary polls, DNC convention date, declared candidates',
    imageUrl: 'https://images.pexels.com/photos/1550337/pexels-photo-1550337.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will be the 2028 Republican presidential nominee?',
    outcomes: ['J.D. Vance', 'Marco Rubio', 'Ron DeSantis', 'Other'],
    targetProbabilities: [0.37, 0.22, 0.15, 0.26],
    liquidityUsdc: 100,
    deadlineDate: '2028-08-30',
    category: 'Politics',
    searchContext: '2028 Republican primary polls, RNC convention date, declared candidates',
    imageUrl: 'https://images.pexels.com/photos/1550337/pexels-photo-1550337.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2028 US presidential election?',
    outcomes: ['Democrat', 'Republican', 'Other'],
    targetProbabilities: [0.46, 0.50, 0.04],
    liquidityUsdc: 100,
    deadlineDate: '2028-11-10',
    category: 'Politics',
    searchContext: '2028 US presidential election polls, general election forecasts',
    imageUrl: 'https://images.pexels.com/photos/1550337/pexels-photo-1550337.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 FIFA World Cup?',
    outcomes: ['Spain', 'France', 'Brazil', 'Argentina', 'England', 'Other'],
    targetProbabilities: [0.16, 0.14, 0.12, 0.13, 0.10, 0.35],
    liquidityUsdc: 100,
    deadlineDate: '2026-07-20',
    category: 'Sports',
    searchContext: 'FIFA World Cup 2026 results, winner, final match score',
    imageUrl: 'https://images.pexels.com/photos/46798/the-ball-stadion-football-the-pitch-46798.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2025-26 English Premier League?',
    outcomes: ['Liverpool', 'Arsenal', 'Man City', 'Other'],
    targetProbabilities: [0.38, 0.30, 0.18, 0.14],
    liquidityUsdc: 100,
    deadlineDate: '2026-05-25',
    category: 'Sports',
    searchContext: 'Premier League 2025-26 standings, final table, champion',
    imageUrl: 'https://images.pexels.com/photos/274422/pexels-photo-274422.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2025-26 UEFA Champions League?',
    outcomes: ['Real Madrid', 'Barcelona', 'Arsenal', 'Bayern', 'Other'],
    targetProbabilities: [0.22, 0.18, 0.15, 0.12, 0.33],
    liquidityUsdc: 100,
    deadlineDate: '2026-06-01',
    category: 'Sports',
    searchContext: 'UEFA Champions League 2025-26 final, winner, results',
    imageUrl: 'https://images.pexels.com/photos/3621104/pexels-photo-3621104.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2025-26 La Liga?',
    outcomes: ['Barcelona', 'Real Madrid', 'Atletico Madrid', 'Other'],
    targetProbabilities: [0.40, 0.35, 0.15, 0.10],
    liquidityUsdc: 100,
    deadlineDate: '2026-05-25',
    category: 'Sports',
    searchContext: 'La Liga 2025-26 standings, final table, champion',
    imageUrl: 'https://images.pexels.com/photos/3621104/pexels-photo-3621104.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 Masters golf tournament?',
    outcomes: ['Scottie Scheffler', 'Rory McIlroy', 'Cameron Young', 'Other'],
    targetProbabilities: [0.22, 0.20, 0.15, 0.43],
    liquidityUsdc: 100,
    deadlineDate: '2026-04-14',
    category: 'Sports',
    searchContext: 'Masters Tournament 2026 Augusta winner, final leaderboard, results',
    imageUrl: 'https://images.pexels.com/photos/54123/pexels-photo-54123.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 Formula 1 Drivers Championship?',
    outcomes: ['Max Verstappen', 'Lewis Hamilton', 'Lando Norris', 'Other'],
    targetProbabilities: [0.30, 0.18, 0.22, 0.30],
    liquidityUsdc: 100,
    deadlineDate: '2026-12-10',
    category: 'Sports',
    searchContext: 'Formula 1 2026 season standings, drivers championship winner',
    imageUrl: 'https://images.pexels.com/photos/12749791/pexels-photo-12749791.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 NHL Stanley Cup?',
    outcomes: ['Colorado', 'Florida', 'Edmonton', 'Other'],
    targetProbabilities: [0.20, 0.18, 0.15, 0.47],
    liquidityUsdc: 100,
    deadlineDate: '2026-06-25',
    category: 'Sports',
    searchContext: 'NHL Stanley Cup 2026 champion, finals results',
    imageUrl: 'https://images.pexels.com/photos/2834917/pexels-photo-2834917.jpeg?auto=compress&w=800',
  },
  {
    question: 'Will Netanyahu still be Prime Minister of Israel on December 31, 2026?',
    outcomes: ['Yes', 'No'],
    targetProbabilities: [0.40, 0.60],
    liquidityUsdc: 100,
    deadlineDate: '2027-01-02',
    category: 'Politics',
    searchContext: 'Netanyahu Israel prime minister 2026, Israeli elections, coalition status',
    imageUrl: 'https://images.pexels.com/photos/3943716/pexels-photo-3943716.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 Hungarian parliamentary election?',
    outcomes: ['Fidesz (Orban)', 'TISZA (Magyar)', 'Coalition/Other'],
    targetProbabilities: [0.35, 0.50, 0.15],
    liquidityUsdc: 100,
    deadlineDate: '2026-04-20',
    category: 'Politics',
    searchContext: 'Hungary parliamentary election April 2026 results, winner, Orban Magyar',
    imageUrl: 'https://images.pexels.com/photos/259091/pexels-photo-259091.jpeg?auto=compress&w=800',
  },
  {
    question: 'Who will win the 2026 Brazilian presidential election?',
    outcomes: ['Lula (PT)', 'Flavio Bolsonaro (PL)', 'Other'],
    targetProbabilities: [0.42, 0.38, 0.20],
    liquidityUsdc: 100,
    deadlineDate: '2026-10-10',
    category: 'Politics',
    searchContext: 'Brazil presidential election October 2026 results, winner, polls',
    imageUrl: 'https://images.pexels.com/photos/534216/pexels-photo-534216.jpeg?auto=compress&w=800',
  },
  {
    question: 'Will the Fed cut rates at the May 2026 FOMC meeting?',
    outcomes: ['Yes (cut)', 'No (hold or hike)'],
    targetProbabilities: [0.15, 0.85],
    liquidityUsdc: 100,
    deadlineDate: '2026-05-10',
    category: 'Economics',
    searchContext: 'Federal Reserve FOMC May 2026 decision, interest rate cut hold',
    imageUrl: 'https://images.pexels.com/photos/210574/pexels-photo-210574.jpeg?auto=compress&w=800',
  },
  {
    question: 'Will the US confirm extraterrestrial life before 2027?',
    outcomes: ['Yes', 'No'],
    targetProbabilities: [0.03, 0.97],
    liquidityUsdc: 100,
    deadlineDate: '2027-01-02',
    category: 'Science',
    searchContext: 'US government extraterrestrial life confirmation UFO UAP disclosure',
    imageUrl: 'https://images.pexels.com/photos/2397414/pexels-photo-2397414.jpeg?auto=compress&w=800',
  },
]

// ── Price Simulation ─────────────────────────────────────────────────────────

function computeBuyDeltas(quantities: bigint[], b: bigint, targetProbs: number[]): bigint[] {
  const n = quantities.length
  const deltas = new Array<bigint>(n).fill(0n)
  let anchorIdx = 0
  for (let i = 1; i < n; i++) {
    if (targetProbs[i] < targetProbs[anchorIdx]) anchorIdx = i
  }
  const anchorProb = targetProbs[anchorIdx]
  for (let i = 0; i < n; i++) {
    if (i === anchorIdx) continue
    const logRatio = Math.log(targetProbs[i] / anchorProb)
    const rawDelta = Number(b) * logRatio
    deltas[i] = rawDelta > 0 ? BigInt(Math.round(rawDelta)) : 0n
  }
  return deltas
}

function pricePct(p: bigint): number { return Number(p) / Number(SCALE) }

async function pushToTarget(
  algod: algosdk.Algodv2, config: ClientConfig, targets: number[],
) {
  const TOLERANCE = 0.02
  const SHARE_STEP = 5_000_000n

  for (let round = 0; round < 100; round++) {
    const state = await getMarketState(algod, Number(config.appId))
    let worstIdx = -1
    let worstGap = 0
    for (let i = 0; i < targets.length; i++) {
      const gap = targets[i] - pricePct(state.prices[i])
      if (gap > worstGap) { worstGap = gap; worstIdx = i }
    }
    if (worstGap < TOLERANCE) break
    try {
      const cost = calculateBuyCost(state.quantities, state.b, worstIdx, SHARE_STEP)
      await buy(config, worstIdx, cost, state.numOutcomes, USDC_ASA_ID)
    } catch { break }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Seeding testnet with prediction markets ===\n')

  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
  const status = await algod.status().do()
  console.log(`Network round: ${status.lastRound}`)

  const { addr, signer } = getAccount()
  console.log(`Deployer: ${addr}`)

  const acctInfo = await algod.accountInformation(addr).do()
  const algoBalance = Number(acctInfo.amount) / 1_000_000
  const usdcHolding = acctInfo.assets?.find((a: any) => Number(a.assetId ?? a['asset-id']) === USDC_ASA_ID)
  const usdcBalance = usdcHolding ? Number(usdcHolding.amount) / 1_000_000 : 0
  console.log(`ALGO: ${algoBalance}, tUSDC: ${usdcBalance}\n`)

  if (algoBalance < 50) {
    console.error('Need at least 50 ALGO. Fund at https://bank.testnet.algorand.network')
    process.exit(1)
  }

  if (!PINATA_JWT) console.log('PINATA_JWT not set, images will be skipped\n')

  const block = await algod.block(Number(status.lastRound)).do()
  const blockTs = Number(block.block.header.timestamp)

  const factoryConfig: ClientConfig = { algodClient: algod, appId: FACTORY_APP_ID, sender: addr, signer }

  interface CreatedMarket { appId: number; def: MarketDef }
  const created: CreatedMarket[] = []

  for (let i = 0; i < MARKETS.length; i++) {
    const def = MARKETS[i]
    console.log(`[${i + 1}/${MARKETS.length}] "${def.question}"`)

    let imageCid: string | null = null
    if (PINATA_JWT && def.imageUrl) {
      imageCid = await pinImageFromUrl(def.imageUrl, PINATA_JWT)
      if (imageCid) console.log(`    Image CID: ${imageCid}`)
    }

    const deadlineTs = Math.floor(new Date(def.deadlineDate + 'T23:59:59Z').getTime() / 1000)
    const deadline = Math.max(deadlineTs, blockTs + 86400)
    const liquidityMicro = BigInt(def.liquidityUsdc * 1_000_000)
    const blueprint = buildLLMJudgeBlueprint(def.question, def.outcomes, def.searchContext)

    const noteObj: Record<string, unknown> = { q: def.question, o: def.outcomes, c: def.category }
    if (imageCid) noteObj.img = imageCid

    try {
      const result = await createMarketAtomic(factoryConfig, {
        currencyAsa: USDC_ASA_ID,
        questionHash: textEncoder.encode(def.question),
        numOutcomes: def.outcomes.length,
        initialB: 0n,
        lpFeeBps: 200,
        blueprintCid: textEncoder.encode('QmPlaceholderBlueprintCID'),
        deadline,
        challengeWindowSecs: 3600,
        cancellable: true,
        bootstrapDeposit: liquidityMicro,
        protocolConfigAppId: PROTOCOL_CONFIG_APP_ID,
        note: textEncoder.encode(`question.market:j${JSON.stringify(noteObj)}`),
      })
      console.log(`    App ID: ${result.marketAppId}`)
      created.push({ appId: result.marketAppId, def })
    } catch (err: any) {
      console.error(`    FAILED: ${err.message}`)
    }
    console.log()
  }

  console.log(`Created ${created.length}/${MARKETS.length} markets.\n`)

  if (created.length === 0) {
    console.error('No markets created.')
    process.exit(1)
  }

  // Push prices
  console.log('=== Pushing prices to targets ===\n')
  for (const { appId, def } of created) {
    const state = await getMarketState(algod, appId)
    const before = state.prices.map(p => `${(pricePct(p) * 100).toFixed(0)}%`).join(' | ')
    const target = def.targetProbabilities.map(t => `${(t * 100).toFixed(0)}%`).join(' | ')
    console.log(`  ${appId}: ${before} -> ${target}`)
    await pushToTarget(algod, { algodClient: algod, appId, sender: addr, signer }, def.targetProbabilities)
    const after = await getMarketState(algod, appId)
    console.log(`    => ${after.prices.map(p => `${(pricePct(p) * 100).toFixed(0)}%`).join(' | ')}`)
  }

  console.log(`\nApp IDs: [${created.map(m => m.appId).join(', ')}]`)
}

main().catch((err) => { console.error('Seeding failed:', err); process.exit(1) })
