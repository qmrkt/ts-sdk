import algosdk from 'algosdk'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig } from '../protocol-config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = path.resolve(__dirname, '../../..')
const TSX_CLI = path.resolve(SDK_ROOT, 'node_modules/tsx/dist/cli.mjs')
const DEFAULT_CONTRACTS_DIR = path.resolve(SDK_ROOT, '../question/contracts')
const SHARED_DEPLOYMENT_PATH = path.join(os.tmpdir(), 'question-sdk-localnet-deployment.json')

export type LocalnetDeployment = {
  network?: string
  deployer: string
  protocolConfigAppId: number
  marketFactoryAppId: number
  usdcAsaId: number
  deployedAt?: string
}

function parseDeployment(stdout: string): LocalnetDeployment {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith('DEPLOYMENT_JSON='))

  if (!line) {
    throw new Error(`deploy-localnet.ts did not emit DEPLOYMENT_JSON output:\n${stdout}`)
  }

  return JSON.parse(line.slice('DEPLOYMENT_JSON='.length)) as LocalnetDeployment
}

function isDeploymentShape(value: unknown): value is LocalnetDeployment {
  return typeof value === 'object'
    && value !== null
    && typeof (value as LocalnetDeployment).deployer === 'string'
    && typeof (value as LocalnetDeployment).protocolConfigAppId === 'number'
    && typeof (value as LocalnetDeployment).marketFactoryAppId === 'number'
    && typeof (value as LocalnetDeployment).usdcAsaId === 'number'
}

function readDeploymentFile(filePath: string): LocalnetDeployment | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    return isDeploymentShape(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function getSharedLocalnetDeploymentPath(): string {
  return SHARED_DEPLOYMENT_PATH
}

export async function loadUsableLocalnetDeployment(
  algodClient: algosdk.Algodv2,
  deploymentPath = SHARED_DEPLOYMENT_PATH,
): Promise<LocalnetDeployment | null> {
  const deployment = readDeploymentFile(deploymentPath)
  if (!deployment) return null

  try {
    await readConfig(algodClient, deployment.protocolConfigAppId)
    await algodClient.getApplicationByID(deployment.marketFactoryAppId).do()
    await algodClient.getAssetByID(deployment.usdcAsaId).do()
    return deployment
  } catch {
    return null
  }
}

export function deployLocalnetProtocol(options?: {
  reset?: boolean
  deploymentPath?: string
  contractsDir?: string
}): LocalnetDeployment {
  const deploymentPath = options?.deploymentPath ?? SHARED_DEPLOYMENT_PATH
  const contractsDir = options?.contractsDir ?? DEFAULT_CONTRACTS_DIR

  if (options?.reset !== false) {
    execFileSync('algokit', ['localnet', 'reset'], {
      cwd: SDK_ROOT,
      stdio: 'pipe',
    })
  }

  const env = {
    ...process.env,
    QUESTION_MARKET_CONTRACTS_DIR: contractsDir,
    QUESTION_MARKET_DEPLOYMENT_OUT: deploymentPath,
  }

  const stdout = execFileSync(process.execPath, [TSX_CLI, 'src/scripts/deploy-localnet.ts'], {
    cwd: SDK_ROOT,
    stdio: 'pipe',
    env,
  }).toString('utf8')

  const deployment = parseDeployment(stdout)
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2))
  return deployment
}
