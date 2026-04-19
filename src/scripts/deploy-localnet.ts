/**
 * Deploy the full question.market protocol stack on AlgoKit localnet.
 *
 * Usage:
 *   npx tsx src/scripts/deploy-localnet.ts --contracts-dir ../question/contracts
 *
 * Optional flags:
 *   --contracts-dir <path>     Path to the question.market contracts workspace
 *   --out <path>               Write deployment JSON to a specific file
 *   --frontend-env-out <path>  Write frontend env vars to a specific file
 *
 * Environment equivalents:
 *   QUESTION_MARKET_CONTRACTS_DIR
 *   QUESTION_MARKET_DEPLOYMENT_OUT
 *   QUESTION_MARKET_FRONTEND_ENV_OUT
 *
 * When no output paths are provided, the script prints the deployment JSON to
 * stdout and does not write project-local files.
 */

import algosdk from 'algosdk'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadMethods } from '../clients/base.js'
import { requiredExtraPages } from './avm-pages.js'

import protocolConfigSpec from '../clients/specs/ProtocolConfig.arc56.json' with { type: 'json' }
import marketFactorySpec from '../clients/specs/MarketFactory.arc56.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SDK_ROOT = path.resolve(__dirname, '../..')

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://localhost'
const ALGOD_PORT = 4001
const KMD_TOKEN = 'a'.repeat(64)
const KMD_SERVER = 'http://localhost'
const KMD_PORT = 4002

type DeploymentRecord = {
  network: 'localnet'
  deployer: string
  protocolConfigAppId: number
  marketFactoryAppId: number
  usdcAsaId: number
  deployedAt: string
}

type CliOptions = {
  contractsDir?: string
  deploymentOut?: string
  frontendEnvOut?: string
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--contracts-dir':
        if (!value) throw new Error('--contracts-dir requires a value')
        options.contractsDir = value
        i += 1
        break
      case '--out':
        if (!value) throw new Error('--out requires a value')
        options.deploymentOut = value
        i += 1
        break
      case '--frontend-env-out':
        if (!value) throw new Error('--frontend-env-out requires a value')
        options.frontendEnvOut = value
        i += 1
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function resolveOptionalPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}

function resolveContractsDir(override: string | undefined): string {
  const candidates = [
    resolveOptionalPath(override),
    resolveOptionalPath(process.env.QUESTION_MARKET_CONTRACTS_DIR),
    path.resolve(SDK_ROOT, '../question/contracts'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'smart_contracts'))) {
      return candidate
    }
  }

  throw new Error(
    'Contracts workspace not found. Pass --contracts-dir or set QUESTION_MARKET_CONTRACTS_DIR.',
  )
}

async function getLocalnetAccount(
  kmd: algosdk.Kmd,
  algod: algosdk.Algodv2,
): Promise<{ addr: string; sk: Uint8Array }> {
  const wallets = await kmd.listWallets()
  const defaultWallet = wallets.wallets.find((wallet: any) => wallet.name === 'unencrypted-default-wallet')
  if (!defaultWallet) throw new Error('Default localnet wallet not found')

  const handle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token
  const keys = await kmd.listKeys(handle)

  let address = keys.addresses[0]
  let bestBalance = 0n

  for (const candidate of keys.addresses) {
    try {
      const accountInfo = await algod.accountInformation(candidate).do()
      const balance = BigInt(accountInfo.amount ?? 0)
      if (balance > bestBalance) {
        bestBalance = balance
        address = candidate
      }
    } catch {
      // Ignore stale or inaccessible accounts and keep looking.
    }
  }

  if (!address) {
    throw new Error('No funded localnet account found in default wallet')
  }

  const secret = await kmd.exportKey(handle, '', address)
  await kmd.releaseWalletHandle(handle)
  return { addr: address, sk: secret.private_key }
}

async function compileTeal(algod: algosdk.Algodv2, tealPath: string): Promise<Uint8Array> {
  const source = fs.readFileSync(tealPath, 'utf8')
  const result = await algod.compile(source).do()
  return new Uint8Array(Buffer.from(result.result, 'base64'))
}

async function deployApp(
  algod: algosdk.Algodv2,
  sender: string,
  signer: algosdk.TransactionSigner,
  approvalTeal: string,
  clearTeal: string,
  spec: any,
  createArgs: any[],
  schema: {
    globalInts: number
    globalBytes: number
    localInts: number
    localBytes: number
  },
  note: Uint8Array,
): Promise<number> {
  const approval = await compileTeal(algod, approvalTeal)
  const clear = await compileTeal(algod, clearTeal)
  const extraPages = requiredExtraPages(approval, clear)
  const methods = loadMethods(spec)
  const createMethod = methods.get('create')
  const suggestedParams = await algod.getTransactionParams().do()
  const atc = new algosdk.AtomicTransactionComposer()

  if (createMethod) {
    atc.addMethodCall({
      appID: 0,
      method: createMethod,
      methodArgs: createArgs,
      sender,
      suggestedParams,
      signer,
      approvalProgram: approval,
      clearProgram: clear,
      numGlobalInts: schema.globalInts,
      numGlobalByteSlices: schema.globalBytes,
      numLocalInts: schema.localInts,
      numLocalByteSlices: schema.localBytes,
      extraPages,
      note,
    })
  } else {
    if (createArgs.length > 0) {
      throw new Error('Bare create deployment does not support ABI create args')
    }

    const txn = algosdk.makeApplicationCreateTxnFromObject({
      sender,
      suggestedParams,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      approvalProgram: approval,
      clearProgram: clear,
      numGlobalInts: schema.globalInts,
      numGlobalByteSlices: schema.globalBytes,
      numLocalInts: schema.localInts,
      numLocalByteSlices: schema.localBytes,
      extraPages,
      note,
    })
    atc.addTransaction({ txn, signer })
  }

  const result = await atc.execute(algod, 4)
  const txId = result.txIDs[0]
  const txInfo = await algod.pendingTransactionInformation(txId).do()
  const appId = txInfo.applicationIndex
  if (!appId) throw new Error(`App creation failed: no application-index in txn ${txId}`)
  return Number(appId)
}

async function createMockUSDC(
  algod: algosdk.Algodv2,
  sender: string,
  signer: algosdk.TransactionSigner,
  note: Uint8Array,
): Promise<number> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender,
    total: BigInt(10_000_000_000_000),
    decimals: 6,
    defaultFrozen: false,
    unitName: 'USDC',
    assetName: 'Mock USDC (Localnet)',
    suggestedParams,
    note,
  })
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addTransaction({ txn, signer })
  const result = await atc.execute(algod, 4)
  const txInfo = await algod.pendingTransactionInformation(result.txIDs[0]).do()
  const asaId = txInfo.assetIndex
  if (!asaId) throw new Error('ASA creation failed')
  return Number(asaId)
}

function ensureArtifactsBuilt(contractsDir: string): string {
  const buildTargets = [
    {
      contractName: 'protocol_config',
      inputs: ['smart_contracts/protocol_config/contract.py'],
      outputs: [
        'protocol_config/ProtocolConfig.approval.teal',
        'protocol_config/ProtocolConfig.clear.teal',
      ],
    },
    {
      contractName: 'market_app',
      inputs: [
        'smart_contracts/market_app/contract.py',
        'smart_contracts/protocol_config/contract.py',
      ],
      outputs: [
        'market_app/QuestionMarket.approval.teal',
        'market_app/QuestionMarket.clear.teal',
      ],
    },
    {
      contractName: 'market_factory',
      inputs: [
        'smart_contracts/market_factory/contract.py',
        'smart_contracts/market_app/contract.py',
        'smart_contracts/protocol_config/contract.py',
      ],
      outputs: [
        'market_factory/MarketFactory.approval.teal',
        'market_factory/MarketFactory.clear.teal',
      ],
    },
  ]

  const artifactsDir = path.join(contractsDir, 'smart_contracts/artifacts')
  const staleTargets = buildTargets.filter(({ inputs, outputs }) => {
    const outputPaths = outputs.map((relativePath) => path.join(artifactsDir, relativePath))
    if (outputPaths.some((outputPath) => !fs.existsSync(outputPath))) return true

    const newestInputMtime = Math.max(
      ...inputs.map((relativePath) => fs.statSync(path.join(contractsDir, relativePath)).mtimeMs),
    )
    const oldestOutputMtime = Math.min(...outputPaths.map((outputPath) => fs.statSync(outputPath).mtimeMs))
    return newestInputMtime > oldestOutputMtime
  })

  if (staleTargets.length === 0) return artifactsDir

  const contractsPython = path.join(contractsDir, '.venv/bin/python')
  if (!fs.existsSync(contractsPython)) {
    throw new Error(`Contracts venv missing at ${contractsPython}. Create it before deploying.`)
  }

  console.log(
    `Stale or missing contract artifacts (${staleTargets.map((target) => target.contractName).join(', ')}); building contracts...`,
  )
  for (const { contractName } of staleTargets) {
    execFileSync(contractsPython, ['-m', 'smart_contracts', 'build', contractName], {
      cwd: contractsDir,
      stdio: 'inherit',
    })
  }

  const requiredFiles = buildTargets.flatMap((target) => target.outputs)
  const stillMissing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(artifactsDir, relativePath)))
  if (stillMissing.length > 0) {
    throw new Error(`Contract artifact build incomplete; still missing: ${stillMissing.join(', ')}`)
  }

  return artifactsDir
}

async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2))
  const deploymentOut = resolveOptionalPath(cliOptions.deploymentOut ?? process.env.QUESTION_MARKET_DEPLOYMENT_OUT)
  const frontendEnvOut = resolveOptionalPath(cliOptions.frontendEnvOut ?? process.env.QUESTION_MARKET_FRONTEND_ENV_OUT)

  console.log('Connecting to localnet...')
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
  const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)

  // Retry briefly after an `algokit localnet reset`: the container takes a few seconds
  // to bring algod and kmd back up, and the first status call races that restart.
  const readyDeadline = Date.now() + 30_000
  let ready = false
  while (!ready && Date.now() < readyDeadline) {
    try {
      await algod.status().do()
      await kmd.listWallets()
      ready = true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  if (!ready) {
    console.error('ERROR: Localnet not running. Start it with: algokit localnet start')
    process.exit(1)
  }

  console.log('Getting funded account from KMD...')
  const { addr: deployer, sk } = await getLocalnetAccount(kmd, algod)
  const signer = algosdk.makeBasicAccountTransactionSigner({ addr: deployer, sk } as any)
  console.log(`  Deployer: ${deployer}`)

  const accountInfo = await algod.accountInformation(deployer).do()
  console.log(`  Balance: ${Number(accountInfo.amount) / 1_000_000} ALGO`)

  const contractsDir = resolveContractsDir(cliOptions.contractsDir)
  const artifactsDir = ensureArtifactsBuilt(contractsDir)
  const deploymentTag = `deploy:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const noteFor = (label: string) => new TextEncoder().encode(`${deploymentTag}:${label}`)

  console.log('\nCreating mock USDC ASA...')
  const usdcId = await createMockUSDC(algod, deployer, signer, noteFor('usdc'))
  console.log(`  USDC ASA ID: ${usdcId}`)

  console.log('\nDeploying ProtocolConfig...')
  const configAppId = await deployApp(
    algod,
    deployer,
    signer,
    path.join(artifactsDir, 'protocol_config/ProtocolConfig.approval.teal'),
    path.join(artifactsDir, 'protocol_config/ProtocolConfig.clear.teal'),
    protocolConfigSpec,
    [
      deployer,
      BigInt(10_000_000),
      BigInt(10_000_000),
      BigInt(10_000_000),
      BigInt(500),
      BigInt(500),
      BigInt(100_000_000),
      BigInt(100_000_000),
      BigInt(20),
      BigInt(10_000),
      BigInt(50_000_000),
      BigInt(500),
      BigInt(50),
      deployer,
      BigInt(0),
      BigInt(16),
      BigInt(5),
      BigInt(5),
      BigInt(500),
      BigInt(150_000),
      BigInt(8),
    ],
    { globalInts: 19, globalBytes: 2, localInts: 0, localBytes: 0 },
    noteFor('protocol-config'),
  )
  console.log(`  ProtocolConfig App ID: ${configAppId}`)

  console.log('\nDeploying MarketFactory...')
  const factoryAppId = await deployApp(
    algod,
    deployer,
    signer,
    path.join(artifactsDir, 'market_factory/MarketFactory.approval.teal'),
    path.join(artifactsDir, 'market_factory/MarketFactory.clear.teal'),
    marketFactorySpec,
    [],
    { globalInts: 0, globalBytes: 0, localInts: 0, localBytes: 0 },
    noteFor('market-factory'),
  )
  console.log(`  MarketFactory App ID: ${factoryAppId}`)

  console.log('\nLinking ProtocolConfig -> MarketFactory...')
  const { updateMarketFactoryId, readConfig } = await import('../clients/protocol-config.js')
  await updateMarketFactoryId(
    { algodClient: algod, appId: configAppId, sender: deployer, signer },
    factoryAppId,
  )
  console.log('  Done')

  console.log('\nStoring QuestionMarket bytecode in factory boxes...')
  const { callMethod, loadMethods: loadFactoryMethods } = await import('../clients/base.js')
  const factoryMethods = loadFactoryMethods(marketFactorySpec)
  const factoryConfig = { algodClient: algod, appId: factoryAppId, sender: deployer, signer }
  const approvalBytecode = await compileTeal(algod, path.join(artifactsDir, 'market_app/QuestionMarket.approval.teal'))
  const clearBytecode = await compileTeal(algod, path.join(artifactsDir, 'market_app/QuestionMarket.clear.teal'))

  console.log(`  Approval program: ${approvalBytecode.length} bytes`)
  console.log(`  Clear program: ${clearBytecode.length} bytes`)

  const approvalBoxMbr = 2_500 + 400 * (2 + approvalBytecode.length)
  const clearBoxMbr = 2_500 + 400 * (2 + clearBytecode.length)
  const factoryMbrNeeded = BigInt(approvalBoxMbr + clearBoxMbr + 200_000)
  const factoryAddr = algosdk.getApplicationAddress(factoryAppId).toString()
  const fundingSuggestedParams = await algod.getTransactionParams().do()
  const fundingTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: factoryAddr,
    amount: factoryMbrNeeded,
    suggestedParams: fundingSuggestedParams,
  })
  const fundAtc = new algosdk.AtomicTransactionComposer()
  fundAtc.addTransaction({ txn: fundingTxn, signer })
  await fundAtc.execute(algod, 4)
  console.log(`  Factory funded with ${Number(factoryMbrNeeded) / 1_000_000} ALGO for box MBR`)

  async function storeInBox(appId: number, boxName: string, data: Uint8Array): Promise<void> {
    const chunkSize = 1900
    const boxNameBytes = new TextEncoder().encode(boxName)
    const boxRef = { appIndex: appId, name: boxNameBytes }
    const refsNeeded = Math.max(Math.ceil(data.length / 1024), 1)
    const noopMethod = factoryMethods.get('noop')
    const createMethod = factoryMethods.get('create_program_box')

    if (!noopMethod || !createMethod) {
      throw new Error('MarketFactory spec is missing noop/create_program_box methods')
    }

    const createAtc = new algosdk.AtomicTransactionComposer()
    const createSuggestedParams = await algod.getTransactionParams().do()

    for (let i = 0; i < refsNeeded; i += 1) {
      createAtc.addMethodCall({
        appID: appId,
        method: noopMethod,
        methodArgs: [],
        sender: deployer,
        suggestedParams: createSuggestedParams,
        signer,
        boxes: [boxRef],
        note: new TextEncoder().encode(`bp:${boxName}:${i}`),
      })
    }

    createAtc.addMethodCall({
      appID: appId,
      method: createMethod,
      methodArgs: [boxNameBytes, BigInt(data.length)],
      sender: deployer,
      suggestedParams: createSuggestedParams,
      signer,
      boxes: [boxRef],
    })
    await createAtc.execute(algod, 4)

    const writeMethod = factoryMethods.get('write_program_chunk')
    if (!writeMethod) {
      throw new Error('MarketFactory spec is missing write_program_chunk')
    }

    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.slice(offset, Math.min(offset + chunkSize, data.length))
      const writeAtc = new algosdk.AtomicTransactionComposer()
      const writeSuggestedParams = await algod.getTransactionParams().do()

      for (let i = 0; i < refsNeeded; i += 1) {
        writeAtc.addMethodCall({
          appID: appId,
          method: noopMethod,
          methodArgs: [],
          sender: deployer,
          suggestedParams: writeSuggestedParams,
          signer,
          boxes: [boxRef],
          note: new TextEncoder().encode(`bw:${boxName}:${offset}:${i}`),
        })
      }

      writeAtc.addMethodCall({
        appID: appId,
        method: writeMethod,
        methodArgs: [boxNameBytes, BigInt(offset), chunk],
        sender: deployer,
        suggestedParams: writeSuggestedParams,
        signer,
        boxes: [boxRef],
      })
      await writeAtc.execute(algod, 4)
    }
  }

  await storeInBox(factoryAppId, 'ap', approvalBytecode)
  console.log(`  Approval program stored (${approvalBytecode.length} bytes, ${Math.ceil(approvalBytecode.length / 1900)} chunks)`)
  await storeInBox(factoryAppId, 'cp', clearBytecode)
  console.log(`  Clear program stored (${clearBytecode.length} bytes)`)

  await callMethod(factoryConfig, factoryMethods, 'opt_into_asset', [BigInt(usdcId)], {
    appForeignAssets: [usdcId],
    innerTxnCount: 1,
  })
  console.log(`  Factory opted into USDC (ASA ${usdcId})`)

  console.log('\nVerifying deployment...')
  const config = await readConfig(algod, configAppId)
  console.log(`  ProtocolConfig.market_factory_id: ${config.marketFactoryId}`)
  console.log(`  ProtocolConfig.min_bootstrap_deposit: ${config.minBootstrapDeposit}`)
  console.log(`  ProtocolConfig.proposal_bond_min: ${config.proposalBond}`)
  console.log(`  ProtocolConfig.proposal_bond_bps: ${config.proposalBondBps}`)
  console.log(`  ProtocolConfig.proposer_fee_bps: ${config.proposerFeeBps}`)
  console.log(`  ProtocolConfig.proposer_fee_floor_bps: ${config.proposerFeeFloorBps}`)
  console.log(`  ProtocolConfig.max_outcomes: ${config.maxOutcomes}`)

  const deployment: DeploymentRecord = {
    network: 'localnet',
    deployer,
    protocolConfigAppId: configAppId,
    marketFactoryAppId: factoryAppId,
    usdcAsaId: usdcId,
    deployedAt: new Date().toISOString(),
  }

  if (deploymentOut) {
    fs.mkdirSync(path.dirname(deploymentOut), { recursive: true })
    fs.writeFileSync(deploymentOut, JSON.stringify(deployment, null, 2))
    console.log(`\nDeployment config written to: ${deploymentOut}`)
  } else {
    console.log('\nDeployment config not written to disk (no --out / QUESTION_MARKET_DEPLOYMENT_OUT supplied)')
  }

  if (frontendEnvOut) {
    const envContent = [
      'PUBLIC_ALGORAND_NETWORK=localnet',
      `PUBLIC_PROTOCOL_CONFIG_APP_ID=${configAppId}`,
      `PUBLIC_MARKET_FACTORY_APP_ID=${factoryAppId}`,
      `PUBLIC_USDC_ASA_ID=${usdcId}`,
      `PUBLIC_DEPLOYER_ADDRESS=${deployer}`,
      'PUBLIC_ENABLE_SESSION_RECORDING=false',
    ].join('\n') + '\n'
    fs.mkdirSync(path.dirname(frontendEnvOut), { recursive: true })
    fs.writeFileSync(frontendEnvOut, envContent)
    console.log(`Frontend env written to: ${frontendEnvOut}`)
  }

  console.log('\n✓ Protocol deployed successfully!')
  console.log(`  Config:  ${configAppId}`)
  console.log(`  Factory: ${factoryAppId}`)
  console.log(`  USDC:    ${usdcId}`)
  console.log(`DEPLOYMENT_JSON=${JSON.stringify(deployment)}`)
}

main().catch((error) => {
  console.error('Deployment failed:', error)
  process.exit(1)
})
