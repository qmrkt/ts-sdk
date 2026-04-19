import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import algosdk from 'algosdk'
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { fileURLToPath } from 'node:url'

import { createMarketAtomic, type CreateMarketAtomicParams } from '../market-factory'
import {
  getMarketState,
  triggerResolution,
  challengeResolution,
} from '../question-market'
import type { ClientConfig } from '../base'
import { getLocalnetAccountAtIndex, getLocalnetAccountByAddress, type LocalnetAccount } from './localnet-accounts'
import { deployLocalnetProtocol } from './localnet-deployment'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = path.resolve(__dirname, '../../..')
const WORKSPACE_ROOT = path.resolve(SDK_ROOT, '..')

function resolveExistingDir(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate))
}

const QUESTION_REPO_ROOT = resolveExistingDir([
  path.resolve(WORKSPACE_ROOT, 'question'),
  WORKSPACE_ROOT,
])
const INDEXER_ROOT = QUESTION_REPO_ROOT
  ? resolveExistingDir([path.resolve(QUESTION_REPO_ROOT, 'indexer-go')])
  : undefined
const BLUEPRINT_ENGINE_ROOT = resolveExistingDir([
  path.resolve(WORKSPACE_ROOT, 'question-market-blueprint-engine'),
  path.resolve(WORKSPACE_ROOT, 'resolution-engine'),
])

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://127.0.0.1'
const ALGOD_PORT = 4001
const GO_BIN = process.env.GO_BIN
  || (fs.existsSync('/opt/homebrew/bin/go') ? '/opt/homebrew/bin/go' : undefined)
  || (fs.existsSync('/usr/local/bin/go') ? '/usr/local/bin/go' : undefined)
  || 'go'
const TEST_PATH = `/opt/homebrew/bin:${process.env.PATH || ''}`
const ENABLE_RESOLUTION_SMOKE = process.env.QUESTION_MARKET_ENABLE_SMOKE === '1'
const INDEXER_WRITE_TOKEN = 'resolution-smoke-write-token'
const ENGINE_CONTROL_TOKEN = 'resolution-smoke-engine-control-token'
const ENGINE_CALLBACK_TOKEN = 'resolution-smoke-engine-callback-token'

type ServiceHandle = {
  proc: ChildProcessWithoutNullStreams
  logs: string[]
  stop: () => Promise<void>
}

let algod: algosdk.Algodv2
let deployment: {
  protocolConfigAppId: number
  marketFactoryAppId: number
  usdcAsaId: number
  deployer: string
}
let creator: LocalnetAccount
let challenger: LocalnetAccount
let indexerPort: number
let indexerURL: string
let indexerService: ServiceHandle | null = null
let engineService: ServiceHandle | null = null

function debugLog(...args: unknown[]) {
  if (process.env.SMOKE_DEBUG === '1') {
    console.log('[resolution-smoke]', ...args)
  }
}

function recentServiceLogs(): string {
  const sections: string[] = []
  if (indexerService?.logs?.length) {
    sections.push(`Indexer logs:\n${indexerService.logs.slice(-120).join('\n')}`)
  }
  if (engineService?.logs?.length) {
    sections.push(`Resolution engine logs:\n${engineService.logs.slice(-160).join('\n')}`)
  }
  return sections.join('\n\n')
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate free port'))
        return
      }
      const port = address.port
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
    server.on('error', reject)
  })
}

function prefixedEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: TEST_PATH,
    ...extra,
  }
}

function hasGoToolchain(): boolean {
  const result = spawnSync(GO_BIN, ['version'], {
    env: prefixedEnv({}),
    stdio: 'ignore',
  })
  return !result.error && result.status === 0
}

function spawnService(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ServiceHandle {
  const proc = spawn(GO_BIN, ['run', '.'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs: string[] = []
  const push = (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      logs.push(line)
      if (logs.length > 300) logs.shift()
    }
  }
  proc.stdout.on('data', push)
  proc.stderr.on('data', push)

  return {
    proc,
    logs,
    stop: async () => {
      if (proc.killed || proc.exitCode !== null) return
      proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
          resolve()
        }, 5_000)
        proc.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  for (;;) {
    try {
      const value = await fn()
      if (predicate(value)) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() - started >= timeoutMs) {
      const diagnostics = recentServiceLogs()
      throw new Error(
        `${label} timed out${lastError ? `: ${String(lastError)}` : ''}${diagnostics ? `\n\n${diagnostics}` : ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function waitForHealthy(url: string): Promise<void> {
  await waitFor(
    `health check ${url}`,
    async () => {
      const response = await fetch(url)
      return response
    },
    (response) => response.ok,
    60_000,
    1_000,
  )
}

async function fundAlgo(receiver: string, amount: number) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creator.addr,
    receiver,
    amount,
    suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: creator.signer })
  await atc.execute(algod, 4)
}

async function ensureUsdcOptIn(account: LocalnetAccount) {
  try {
    await algod.accountAssetInformation(account.addr, deployment.usdcAsaId).do()
  } catch {
    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: account.addr,
      assetIndex: deployment.usdcAsaId,
      amount: BigInt(0),
      suggestedParams: sp,
    })
    const atc = new algosdk.AtomicTransactionComposer()
    atc.addTransaction({ txn, signer: account.signer })
    await atc.execute(algod, 4)
  }
}

async function fundUsdc(receiver: string, amount: bigint) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: creator.addr,
    receiver,
    assetIndex: deployment.usdcAsaId,
    amount,
    suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: creator.signer })
  await atc.execute(algod, 4)
}

async function currentBlockTimestamp(): Promise<bigint> {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creator.addr,
    receiver: creator.addr,
    amount: 0,
    suggestedParams: sp,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer: creator.signer })
  const result = await atc.execute(algod, 4)
  const info = await algod.pendingTransactionInformation(result.txIDs[0]).do()
  const round = Number(info.confirmedRound ?? 0)
  const block = await algod.block(round).do()
  const ts = (block as any).block?.header?.timestamp ?? (block as any).block?.ts ?? 0
  return BigInt(ts)
}

async function resetBlockOffsetTimestamp(): Promise<void> {
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do()
    await currentBlockTimestamp()
  } catch {
    // Localnet-only helper may be unavailable outside test algod.
  }
}

async function advanceTimePast(target: bigint): Promise<void> {
  const ts = await currentBlockTimestamp()
  if (ts < target) {
    let offset = 0
    try {
      const response = await (algod as any).getBlockOffsetTimestamp().do()
      offset = Number((response as any).offset ?? 0)
    } catch {}
    await (algod as any).setBlockOffsetTimestamp(offset + Number(target - ts + 1n)).do()
    await currentBlockTimestamp()
  }
  if (await currentBlockTimestamp() >= target) {
    try {
      await (algod as any).setBlockOffsetTimestamp(0).do()
    } catch {}
    return
  }
  throw new Error(`Could not advance block time past ${target}`)
}

function buildHumanJudgeBlueprint(nodeId: string, title: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: title.toLowerCase().replace(/\s+/g, '-'),
      version: 1,
      nodes: [
        {
          id: nodeId,
          type: 'await_signal',
          config: {
            reason:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'Return the correct outcome index with a short reason.',
            signal_type: 'human_judgment.responded',
            timeout_seconds: 600,
            required_payload: ['outcome', 'reason'],
          },
        },
        {
          id: 'success',
          type: 'return',
          config: {
            value: {
              status: 'success',
              outcome: `{{results.${nodeId}.outcome}}`,
              reason: `{{results.${nodeId}.reason}}`,
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          config: {
            value: {
              status: 'cancelled',
              reason: `${title} failed`,
            },
          },
        },
      ],
      edges: [
        {
          from: nodeId,
          to: 'success',
          condition: `results.${nodeId}.status == 'responded' && results.${nodeId}.outcome != ''`,
        },
        {
          from: nodeId,
          to: 'cancelled',
          condition: `results.${nodeId}.status == 'timeout' || results.${nodeId}.status == 'cancelled'`,
        },
      ],
    }),
  )
}

function buildEarlyMonitoringBlueprint(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: 'early-monitoring',
      version: 1,
      execution: {
        active_monitoring: {
          enabled: true,
          poll_interval_seconds: 60,
        },
      },
      nodes: [
        {
          id: 'term',
          type: 'cel_eval',
          config: {
            expressions: {
              outcome: "inputs.market.app_id != '' ? '0' : ''",
            },
          },
        },
        {
          id: 'success',
          type: 'return',
          config: {
            value: {
              status: 'success',
              outcome: '{{results.term.outcome}}',
            },
          },
        },
        {
          id: 'deferred',
          type: 'return',
          config: {
            value: {
              status: 'deferred',
              reason: 'Monitoring did not reach a terminal result.',
            },
          },
        },
      ],
      edges: [
        { from: 'term', to: 'success', condition: "results.term.outcome != ''" },
        { from: 'term', to: 'deferred', condition: "results.term.outcome == ''" },
      ],
    }),
  )
}

function buildDeferResolutionBlueprint(reason: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: 'defer-resolution',
      version: 1,
      nodes: [
        {
          id: 'defer',
          type: 'return',
          config: {
            value: {
              status: 'deferred',
              reason,
            },
          },
        },
      ],
      edges: [],
    }),
  )
}

async function waitForIndexerMarket(appId: number) {
  return waitFor(
    `indexer market ${appId}`,
    async () => {
      const response = await fetch(`${indexerURL}/markets`)
      if (!response.ok) throw new Error(`indexer returned ${response.status}`)
      return (await response.json()) as Array<{ appId: number }>
    },
    (markets) => markets.some((market) => market.appId === appId),
    process.env.SMOKE_DEBUG === '1' ? 15_000 : 60_000,
    1_000,
  )
}

async function setMarketMeta(appId: number, question: string, outcomes: string[]) {
  const response = await fetch(`${indexerURL}/markets/${appId}/meta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INDEXER_WRITE_TOKEN}`,
    },
    body: JSON.stringify({ question, outcomes }),
  })
  if (!response.ok) {
    throw new Error(`setMarketMeta failed: ${response.status} ${await response.text()}`)
  }
}

type HumanJudgmentRecord = {
  judgmentId: string
  runId: string
  nodeId: string
  status: string
  responseNonce: string
}

async function waitForPendingJudgment(appId: number, nodeId: string): Promise<HumanJudgmentRecord> {
  return waitFor(
    `pending human judgment ${appId}:${nodeId}`,
    async () => {
      const response = await fetch(`${indexerURL}/markets/${appId}/human-judgments`)
      if (!response.ok) throw new Error(`human judgments returned ${response.status}`)
      const payload = await response.json() as { judgments: HumanJudgmentRecord[] }
      return payload.judgments
    },
    (judgments) => judgments.some((judgment) => judgment.nodeId === nodeId && judgment.status === 'pending'),
    90_000,
    1_000,
  ).then((judgments) => judgments.find((judgment) => judgment.nodeId === nodeId && judgment.status === 'pending')!)
}

function createHumanJudgmentMessage(input: {
  appId: number
  judgmentId: string
  runId: string
  nonce: string
  responderAddress: string
  responderRole: 'creator'
  outcomeIndex: number | null
  reason: string
  cancel: boolean
  submittedAt: number
}): string {
  return JSON.stringify({
    action: 'question.market/human-judgment-response',
    appId: input.appId,
    judgmentId: input.judgmentId,
    runId: input.runId,
    nonce: input.nonce,
    responderAddress: input.responderAddress,
    responderRole: input.responderRole,
    outcomeIndex: input.outcomeIndex,
    reason: input.reason.trim(),
    cancel: input.cancel,
    submittedAt: input.submittedAt,
  })
}

async function respondToJudgment(
  appId: number,
  judgment: HumanJudgmentRecord,
  responder: LocalnetAccount,
  outcomeIndex: number,
  reason: string,
) {
  const submittedAt = Date.now()
  const message = createHumanJudgmentMessage({
    appId,
    judgmentId: judgment.judgmentId,
    runId: judgment.runId,
    nonce: judgment.responseNonce,
    responderAddress: responder.addr,
    responderRole: 'creator',
    outcomeIndex,
    reason,
    cancel: false,
    submittedAt,
  })
  const signature = algosdk.signBytes(new TextEncoder().encode(message), responder.sk)

  const response = await fetch(`${indexerURL}/markets/${appId}/human-judgments/${judgment.judgmentId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: judgment.runId,
      responderAddress: responder.addr,
      responderRole: 'creator',
      outcomeIndex,
      reason,
      cancel: false,
      submittedAt,
      auth: {
        kind: 'sign_data',
        nonce: judgment.responseNonce,
        signature: Buffer.from(signature).toString('base64'),
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`respondToJudgment failed: ${response.status} ${await response.text()}`)
  }
}

async function waitForMarketStatus(appId: number, status: number) {
  return waitFor(
    `market ${appId} status ${status}`,
    async () => getMarketState(algod, appId),
    (state) => state.status === status,
    90_000,
    1_000,
  )
}

type SmokeMarketOptions = {
  deadlineOffsetSecs?: number
  challengeWindowSecs?: number
  blueprintCid?: Uint8Array
}

async function createSmokeMarket(question: string, options: SmokeMarketOptions = {}): Promise<number> {
  debugLog('createSmokeMarket:start', question)
  const deadline = Number(await currentBlockTimestamp()) + (options.deadlineOffsetSecs ?? 15)
  

  const factoryConfig: ClientConfig = {
    algodClient: algod,
    appId: deployment.marketFactoryAppId,
    sender: creator.addr,
    signer: creator.signer,
  }
  const result = await createMarketAtomic(factoryConfig, {
    creator: creator.addr,
    currencyAsa: deployment.usdcAsaId,
    questionHash: new TextEncoder().encode(question),
    numOutcomes: 2,
    initialB: 0n,
    lpFeeBps: 200,
    blueprintCid: options.blueprintCid ?? new TextEncoder().encode("QmTestCid"),
    deadline,
    challengeWindowSecs: options.challengeWindowSecs ?? 30,
    cancellable: false,
    bootstrapDeposit: 50_000_000n,
    protocolConfigAppId: deployment.protocolConfigAppId,
  })
  const marketAppId = result.marketAppId
  debugLog('createSmokeMarket:created+bootstrapped', marketAppId)

  await waitForIndexerMarket(marketAppId)
  debugLog('createSmokeMarket:indexed', marketAppId)
  await setMarketMeta(marketAppId, question, ['Yes', 'No'])
  debugLog('createSmokeMarket:meta', marketAppId)

  return marketAppId
}

const describeResolutionEngine =
  ENABLE_RESOLUTION_SMOKE && hasGoToolchain() && INDEXER_ROOT && BLUEPRINT_ENGINE_ROOT
    ? describe
    : describe.skip

describeResolutionEngine('E2E: resolution engine smoke on localnet', () => {
  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
    try {
      await algod.status().do()
    } catch {
      throw new Error('Localnet not running. Start with: algokit localnet start')
    }

    execFileSync('algokit', ['localnet', 'reset'], {
      cwd: SDK_ROOT,
      stdio: 'pipe',
      env: prefixedEnv({}),
    })

    deployment = deployLocalnetProtocol({ reset: false })
    creator = await getLocalnetAccountByAddress(algod, deployment.deployer)
    const walletAccounts = await Promise.all([getLocalnetAccountAtIndex(algod, 0), getLocalnetAccountAtIndex(algod, 1)])
    challenger = walletAccounts.find((account) => account.addr !== creator.addr) ?? await getLocalnetAccountAtIndex(algod, 2)

    await fundAlgo(challenger.addr, 10_000_000)
    await ensureUsdcOptIn(challenger)
    await fundUsdc(challenger.addr, 100_000_000n)

    if (!INDEXER_ROOT) {
      throw new Error('Missing sibling repo required for smoke test: question/indexer-go')
    }
    if (!BLUEPRINT_ENGINE_ROOT) {
      throw new Error('Missing sibling repo required for smoke test: question-market-blueprint-engine')
    }

    indexerPort = await getFreePort()
    indexerURL = `http://127.0.0.1:${indexerPort}`
    const enginePort = await getFreePort()
    const engineURL = `http://127.0.0.1:${enginePort}`

    const indexerDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-indexer-smoke-'))
    const engineDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-engine-smoke-'))

    indexerService = spawnService(
      'indexer',
      INDEXER_ROOT,
      prefixedEnv({
        ALGOD_SERVER,
        ALGOD_PORT: String(ALGOD_PORT),
        ALGOD_TOKEN,
        FACTORY_APP_ID: String(deployment.marketFactoryAppId),
        PORT: String(indexerPort),
        POLL_INTERVAL: '1000',
        INDEXER_DATA_DIR: indexerDataDir,
        INDEXER_WRITE_TOKEN,
        ENGINE_URL: engineURL,
        ENGINE_CONTROL_TOKEN,
        ENGINE_CALLBACK_TOKEN,
        INDEXER_PUBLIC_URL: indexerURL,
        RESOLUTION_AUTHORITY_MNEMONIC: algosdk.secretKeyToMnemonic(creator.sk),
      }),
    )

    await waitForHealthy(`${indexerURL}/health`)

    engineService = spawnService(
      'question-market-blueprint-engine',
      BLUEPRINT_ENGINE_ROOT,
      prefixedEnv({
        ALGOD_SERVER,
        ALGOD_PORT: String(ALGOD_PORT),
        ALGOD_TOKEN,
        INDEXER_URL: indexerURL,
        LISTEN_PORT: String(enginePort),
        INDEXER_WRITE_TOKEN,
        ENGINE_CONTROL_TOKEN,
        ENGINE_CALLBACK_TOKEN,
        RESOLUTION_DATA_DIR: engineDataDir,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 2_000))
    if (engineService.proc.exitCode !== null) {
      throw new Error(`resolution-engine exited early:\n${engineService.logs.join('\n')}`)
    }
  }, 180_000)

  beforeEach(async () => {
    if (!algod) return
    await resetBlockOffsetTimestamp()
  })

  afterAll(async () => {
    await engineService?.stop()
    await indexerService?.stop()
  })

  it('automates main-path proposal and finalize from on-chain human-judge blueprint', async () => {
    const marketAppId = await createSmokeMarket('Will the main-path smoke test pass?')
    debugLog('test:main-path market ready', marketAppId)

    const marketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: creator.addr,
      signer: creator.signer,
    }

    const stateBeforeDeadline = await getMarketState(algod, marketAppId)
    await advanceTimePast(BigInt(stateBeforeDeadline.deadline + 1))
    debugLog('test:main-path advanced past deadline', marketAppId)

    await triggerResolution(marketConfig, 2)
    await waitForMarketStatus(marketAppId, 2)
    debugLog('test:main-path pending', marketAppId)

    const pendingJudgment = await waitForPendingJudgment(marketAppId, 'main_judge')
    debugLog('test:main-path pending judgment', pendingJudgment.judgmentId)
    await respondToJudgment(
      marketAppId,
      pendingJudgment,
      creator,
      0,
      'Main-path smoke test outcome',
    )
    debugLog('test:main-path judgment responded', marketAppId)

    const proposedState = await waitForMarketStatus(marketAppId, 3)
    debugLog('test:main-path proposed', proposedState.proposedOutcome)
    expect(proposedState.proposedOutcome).toBe(0)

    const proposalBlockTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalBlockTs + proposedState.challengeWindowSecs + 1))
    debugLog('test:main-path advanced past challenge window', marketAppId)

    const resolvedState = await waitForMarketStatus(marketAppId, 5)
    debugLog('test:main-path resolved', resolvedState.winningOutcome)
    expect(resolvedState.winningOutcome).toBe(0)
  }, 180_000)

  it('automates disputed finalization from the on-chain dispute blueprint', async () => {
    const marketAppId = await createSmokeMarket('Will the dispute smoke test use the dispute blueprint?', {
      challengeWindowSecs: 120,
    })

    const creatorMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: creator.addr,
      signer: creator.signer,
    }
    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challenger.addr,
      signer: challenger.signer,
    }

    const activeState = await getMarketState(algod, marketAppId)
    await advanceTimePast(BigInt(activeState.deadline + 1))

    await triggerResolution(creatorMarketConfig, 2)
    await waitForMarketStatus(marketAppId, 2)

    const mainJudgment = await waitForPendingJudgment(marketAppId, 'main_judge')
    await respondToJudgment(
      marketAppId,
      mainJudgment,
      creator,
      0,
      'Initial proposal before challenge',
    )

    const proposedState = await waitForMarketStatus(marketAppId, 3)
    expect(proposedState.proposedOutcome).toBe(0)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0xcd
    await challengeResolution(challengerMarketConfig, 2, challengeEvidenceHash, 2)

    await waitForMarketStatus(marketAppId, 6)

    const disputeJudgment = await waitForPendingJudgment(marketAppId, 'dispute_judge')
    await respondToJudgment(
      marketAppId,
      disputeJudgment,
      creator,
      1,
      'Dispute path overturned the initial proposal',
    )

    const resolvedState = await waitForMarketStatus(marketAppId, 5)
    expect(resolvedState.winningOutcome).toBe(1)
  }, 180_000)

  it('automates early proposal and finalization from active monitoring', async () => {
    const marketAppId = await createSmokeMarket('Will active monitoring propose early?', {
      deadlineOffsetSecs: 600,
      challengeWindowSecs: 10,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
    })

    const proposedState = await waitForMarketStatus(marketAppId, 3)
    expect(proposedState.proposedOutcome).toBe(0)
    expect(proposedState.deadline).toBeGreaterThan(Number(await currentBlockTimestamp()))

    const proposalBlockTs = Number(await currentBlockTimestamp())
    await advanceTimePast(BigInt(proposalBlockTs + proposedState.challengeWindowSecs + 1))

    const resolvedState = await waitForMarketStatus(marketAppId, 5)
    expect(resolvedState.winningOutcome).toBe(0)
  }, 180_000)

  it('automates deferred results for challenged early proposals', async () => {
    const marketAppId = await createSmokeMarket('Will challenged early proposal reopen?', {
      deadlineOffsetSecs: 600,
      challengeWindowSecs: 30,
      blueprintCid: new TextEncoder().encode("QmTestCid"),
    })

    const challengerMarketConfig: ClientConfig = {
      algodClient: algod,
      appId: marketAppId,
      sender: challenger.addr,
      signer: challenger.signer,
    }

    const proposedState = await waitForMarketStatus(marketAppId, 3)
    expect(proposedState.proposedOutcome).toBe(0)

    const challengeEvidenceHash = new Uint8Array(32)
    challengeEvidenceHash[0] = 0xee
    await challengeResolution(challengerMarketConfig, 7, challengeEvidenceHash, 2)

    const activeState = await waitForMarketStatus(marketAppId, 1)
    expect(activeState.proposerBondHeld).toBe(0n)
    expect(activeState.challengerBondHeld).toBe(0n)
  }, 180_000)
})
