/**
 * Deploy the full question.market protocol stack on AlgoKit localnet.
 *
 * Usage:
 *   npx tsx src/scripts/deploy-localnet.ts
 *
 * Prerequisites:
 *   - AlgoKit localnet running: `algokit localnet start`
 *   - Contract TEAL artifacts compiled: `cd contracts && algokit project run build`
 *
 * Outputs:
 *   - Writes protocol-deployment.json with all app IDs and config
 *   - Writes frontend/.env.local with PUBLIC_ env vars
 */

import algosdk from 'algosdk'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadMethods } from '../clients/base.js'
import { requiredExtraPages } from './avm-pages.js'

import protocolConfigSpec from '../clients/specs/ProtocolConfig.arc56.json' with { type: 'json' }
import marketFactorySpec from '../clients/specs/MarketFactory.arc56.json' with { type: 'json' }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Localnet Config ─────────────────────────────────────────────────────────

const ALGOD_TOKEN = 'a'.repeat(64)
const ALGOD_SERVER = 'http://localhost'
const ALGOD_PORT = 4001
const KMD_TOKEN = 'a'.repeat(64)
const KMD_SERVER = 'http://localhost'
const KMD_PORT = 4002

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getLocalnetAccount(
  kmd: algosdk.Kmd,
  algod: algosdk.Algodv2,
): Promise<{ addr: string; sk: Uint8Array }> {
  const wallets = await kmd.listWallets()
  const defaultWallet = wallets.wallets.find(
    (w: any) => w.name === 'unencrypted-default-wallet',
  )
  if (!defaultWallet) throw new Error('Default localnet wallet not found')

  const handle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token
  const keys = await kmd.listKeys(handle)
  let address = keys.addresses[0]
  let bestBalance = 0n
  for (const candidate of keys.addresses) {
    try {
      const acctInfo = await algod.accountInformation(candidate).do()
      const balance = BigInt(acctInfo.amount ?? 0)
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

  const skResponse = await kmd.exportKey(handle, '', address)
  await kmd.releaseWalletHandle(handle)

  return { addr: address, sk: skResponse.private_key }
}

async function compileTeal(
  algod: algosdk.Algodv2,
  tealPath: string,
): Promise<Uint8Array> {
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
  createArgs: algosdk.ABIValue[],
  schema: { globalInts: number; globalBytes: number; localInts: number; localBytes: number },
  note?: Uint8Array,
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
      appID: 0, // 0 = create new app
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
  // The app ID is in the confirmed transaction
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
  note?: Uint8Array,
): Promise<number> {
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender,
    total: BigInt(10_000_000_000_000), // 10M USDC
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

// ── Main ────────────────────────────────────────────────────────────────────

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
    const outputPaths = outputs.map((rel) => path.join(artifactsDir, rel))
    if (outputPaths.some((output) => !fs.existsSync(output))) return true

    const newestInputMtime = Math.max(
      ...inputs.map((rel) => fs.statSync(path.join(contractsDir, rel)).mtimeMs),
    )
    const oldestOutputMtime = Math.min(...outputPaths.map((output) => fs.statSync(output).mtimeMs))
    return newestInputMtime > oldestOutputMtime
  })
  if (staleTargets.length === 0) return artifactsDir

  const contractsPython = path.join(contractsDir, '.venv/bin/python')
  if (!fs.existsSync(contractsPython)) {
    throw new Error(`Contracts venv missing at ${contractsPython}. Create it before deploying.`)
  }

  console.log(`Stale or missing contract artifacts (${staleTargets.map((target) => target.contractName).join(', ')}); building contracts...`)
  for (const { contractName } of staleTargets) {
    execFileSync(contractsPython, ['-m', 'smart_contracts', 'build', contractName], {
      cwd: contractsDir,
      stdio: 'inherit',
    })
  }

  const requiredFiles = buildTargets.flatMap((target) => target.outputs)
  const stillMissing = requiredFiles.filter((rel) => !fs.existsSync(path.join(artifactsDir, rel)))
  if (stillMissing.length > 0) {
    throw new Error(`Contract artifact build incomplete; still missing: ${stillMissing.join(', ')}`)
  }

  return artifactsDir
}

async function main() {
  console.log('Connecting to localnet...')
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT)
  const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)

  // Verify localnet is running
  try {
    await algod.status().do()
  } catch {
    console.error('ERROR: Localnet not running. Start it with: algokit localnet start')
    process.exit(1)
  }

  console.log('Getting funded account from KMD...')
  const { addr: deployer, sk } = await getLocalnetAccount(kmd, algod)
  const signer = algosdk.makeBasicAccountTransactionSigner({ addr: deployer, sk } as any)
  console.log(`  Deployer: ${deployer}`)

  // Check balance
  const acctInfo = await algod.accountInformation(deployer).do()
  console.log(`  Balance: ${Number(acctInfo.amount) / 1_000_000} ALGO`)

  const contractsDir = path.resolve(__dirname, '../../contracts')
  const artifactsDir = ensureArtifactsBuilt(contractsDir)
  const deploymentTag = `deploy:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const noteFor = (label: string) => new TextEncoder().encode(`${deploymentTag}:${label}`)

  // 1. Create mock USDC
  console.log('\nCreating mock USDC ASA...')
  const usdcId = await createMockUSDC(algod, deployer, signer, noteFor('usdc'))
  console.log(`  USDC ASA ID: ${usdcId}`)

  // 2. Deploy ProtocolConfig
  console.log('\nDeploying ProtocolConfig...')
  const configAppId = await deployApp(
    algod, deployer, signer,
    path.join(artifactsDir, 'protocol_config/ProtocolConfig.approval.teal'),
    path.join(artifactsDir, 'protocol_config/ProtocolConfig.clear.teal'),
    protocolConfigSpec,
    [
      deployer,                // admin
      BigInt(10_000_000),      // min_bootstrap_deposit (10 USDC)
      BigInt(10_000_000),      // challenge_bond minimum (10 USDC)
      BigInt(10_000_000),      // proposal_bond minimum (10 USDC)
      BigInt(500),             // challenge_bond_bps (5%)
      BigInt(500),             // proposal_bond_bps (5%)
      BigInt(100_000_000),     // challenge_bond_cap (100 USDC)
      BigInt(100_000_000),     // proposal_bond_cap (100 USDC)
      BigInt(20),              // proposer_fee_bps (20 bps of proposal bond at 24h)
      BigInt(10_000),          // proposer_fee_floor_bps (100% of proposal bond floor)
      BigInt(50_000_000),      // default_b (50 USDC)
      BigInt(500),             // protocol_fee_ceiling_bps (5%)
      BigInt(50),              // protocol_fee_bps (0.5%)
      deployer,                // protocol_treasury
      BigInt(0),               // market_factory_id (will update later)
      BigInt(16),              // max_outcomes
      BigInt(5),               // min_challenge_window_secs (fast localnet E2E)
      BigInt(5),               // min_grace_period_secs (fast localnet E2E)
      BigInt(500),             // max_lp_fee_bps (5%)
      BigInt(150_000),         // default_residual_linear_lambda_fp
      BigInt(8),               // max_active_lp_v4_outcomes
    ],
    { globalInts: 19, globalBytes: 2, localInts: 0, localBytes: 0 },
    noteFor('protocol-config'),
  )
  console.log(`  ProtocolConfig App ID: ${configAppId}`)

  // 3. Deploy MarketFactory
  console.log('\nDeploying MarketFactory...')
  const factoryAppId = await deployApp(
    algod, deployer, signer,
    path.join(artifactsDir, 'market_factory/MarketFactory.approval.teal'),
    path.join(artifactsDir, 'market_factory/MarketFactory.clear.teal'),
    marketFactorySpec,
    [],
    { globalInts: 0, globalBytes: 0, localInts: 0, localBytes: 0 },
    noteFor('market-factory'),
  )
  console.log(`  MarketFactory App ID: ${factoryAppId}`)

  // 4. Update ProtocolConfig with factory ID
  console.log('\nLinking ProtocolConfig → MarketFactory...')
  const { updateMarketFactoryId } = await import('../clients/protocol-config.js')
  await updateMarketFactoryId(
    { algodClient: algod, appId: configAppId, sender: deployer, signer },
    factoryAppId,
  )
  console.log('  Done')

  // 5. Store QuestionMarket bytecode in factory boxes
  console.log('\nStoring QuestionMarket bytecode in factory boxes...')
  const { callMethod, loadMethods: loadFactoryMethods } = await import('../clients/base.js')
  const factoryMethods = loadFactoryMethods(marketFactorySpec)
  const factoryConfig = { algodClient: algod, appId: factoryAppId, sender: deployer, signer }

  const approvalBytecode = await compileTeal(algod, path.join(artifactsDir, 'market_app/QuestionMarket.approval.teal'))
  const clearBytecode = await compileTeal(algod, path.join(artifactsDir, 'market_app/QuestionMarket.clear.teal'))
  console.log(`  Approval program: ${approvalBytecode.length} bytes`)
  console.log(`  Clear program: ${clearBytecode.length} bytes`)

  // Fund factory for box MBR: 2500 + 400*(2 + programSize) per box
  const apBoxMbr = 2_500 + 400 * (2 + approvalBytecode.length)
  const cpBoxMbr = 2_500 + 400 * (2 + clearBytecode.length)
  const factoryMbrNeeded = BigInt(apBoxMbr + cpBoxMbr + 200_000) // extra for ASA opt-in
  const factoryAddr = algosdk.getApplicationAddress(factoryAppId).toString()
  const fundSp = await algod.getTransactionParams().do()
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer,
    receiver: factoryAddr,
    amount: factoryMbrNeeded,
    suggestedParams: fundSp,
  })
  const fundAtc = new algosdk.AtomicTransactionComposer()
  fundAtc.addTransaction({ txn: fundTxn, signer })
  await fundAtc.execute(algod, 4)
  console.log(`  Factory funded with ${Number(factoryMbrNeeded) / 1_000_000} ALGO for box MBR`)

  // Store programs in factory boxes using chunked writes (ABI args limited to 2048 bytes)
  async function storeInBox(appId: number, boxName: string, data: Uint8Array) {
    const CHUNK_SIZE = 1900 // leave room for ABI encoding overhead
    const boxNameBytes = new TextEncoder().encode(boxName)
    const boxRef: algosdk.BoxReference = { appIndex: appId, name: boxNameBytes }

    // Step 1: Create the box with the correct size
    // Box IO budget: each box ref in the group adds 1024 bytes of read+write budget.
    // Build the full group manually with enough refs.
    const refsNeeded = Math.max(Math.ceil(data.length / 1024), 1)
    const noopMethod = factoryMethods.get('noop')!
    const createMethod = factoryMethods.get('create_program_box')!
    const createAtc = new algosdk.AtomicTransactionComposer()
    const createSp = await algod.getTransactionParams().do()

    // Add noop padding calls with box refs
    for (let i = 0; i < refsNeeded; i++) {
      createAtc.addMethodCall({
        appID: appId, method: noopMethod, methodArgs: [],
        sender: deployer, suggestedParams: createSp, signer,
        boxes: [boxRef],
        note: new TextEncoder().encode(`bp:${boxName}:${i}`),
      })
    }

    // Add the actual create_program_box call
    createAtc.addMethodCall({
      appID: appId, method: createMethod, methodArgs: [boxNameBytes, BigInt(data.length)],
      sender: deployer, suggestedParams: createSp, signer,
      boxes: [boxRef],
    })

    await createAtc.execute(algod, 4)

    // Step 2: Write chunks. box_replace needs read+write budget for the FULL box size,
    // not just the chunk. Add noop padding with box refs for budget.
    const writeMethod = factoryMethods.get('write_program_chunk')!
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length))
      const writeAtc = new algosdk.AtomicTransactionComposer()
      const writeSp = await algod.getTransactionParams().do()

      // Add noop padding for box IO budget (need budget for full box, not just chunk)
      for (let i = 0; i < refsNeeded; i++) {
        writeAtc.addMethodCall({
          appID: appId, method: noopMethod, methodArgs: [],
          sender: deployer, suggestedParams: writeSp, signer,
          boxes: [boxRef],
          note: new TextEncoder().encode(`bw:${boxName}:${offset}:${i}`),
        })
      }

      writeAtc.addMethodCall({
        appID: appId, method: writeMethod,
        methodArgs: [boxNameBytes, BigInt(offset), chunk],
        sender: deployer, suggestedParams: writeSp, signer,
        boxes: [boxRef],
      })

      await writeAtc.execute(algod, 4)
    }
  }

  await storeInBox(factoryAppId, 'ap', approvalBytecode)
  console.log(`  Approval program stored (${approvalBytecode.length} bytes, ${Math.ceil(approvalBytecode.length / 1900)} chunks)`)

  await storeInBox(factoryAppId, 'cp', clearBytecode)
  console.log(`  Clear program stored (${clearBytecode.length} bytes)`)

  // Opt factory into USDC
  await callMethod(factoryConfig, factoryMethods, 'opt_into_asset', [BigInt(usdcId)], {
    appForeignAssets: [usdcId],
    innerTxnCount: 1,
  })
  console.log(`  Factory opted into USDC (ASA ${usdcId})`)

  // 6. Verify deployment
  console.log('\nVerifying deployment...')
  const { readConfig } = await import('../clients/protocol-config.js')
  const config = await readConfig(algod, configAppId)
  console.log(`  ProtocolConfig.market_factory_id: ${config.marketFactoryId}`)
  console.log(`  ProtocolConfig.min_bootstrap_deposit: ${config.minBootstrapDeposit}`)
  console.log(`  ProtocolConfig.proposal_bond_min: ${config.proposalBond}`)
  console.log(`  ProtocolConfig.proposal_bond_bps: ${config.proposalBondBps}`)
  console.log(`  ProtocolConfig.proposer_fee_bps: ${config.proposerFeeBps}`)
  console.log(`  ProtocolConfig.proposer_fee_floor_bps: ${config.proposerFeeFloorBps}`)
  console.log(`  ProtocolConfig.max_outcomes: ${config.maxOutcomes}`)

  // 6. Write deployment config
  const deployment = {
    network: 'localnet',
    deployer,
    protocolConfigAppId: configAppId,
    marketFactoryAppId: factoryAppId,
    usdcAsaId: usdcId,
    deployedAt: new Date().toISOString(),
  }

  const outputPath = path.resolve(__dirname, '../../protocol-deployment.json')
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2))
  console.log(`\nDeployment config written to: ${outputPath}`)

  // Also write frontend env vars
  const frontendEnvPath = path.resolve(__dirname, '../../../question/frontend/.env.local')
  const envContent = [
    `PUBLIC_ALGORAND_NETWORK=localnet`,
    `PUBLIC_PROTOCOL_CONFIG_APP_ID=${configAppId}`,
    `PUBLIC_MARKET_FACTORY_APP_ID=${factoryAppId}`,
    `PUBLIC_USDC_ASA_ID=${usdcId}`,
    `PUBLIC_DEPLOYER_ADDRESS=${deployer}`,
    `PUBLIC_ENABLE_SESSION_RECORDING=false`,
  ].join('\n') + '\n'
  fs.writeFileSync(frontendEnvPath, envContent)
  console.log(`Frontend env written to: ${frontendEnvPath}`)

  console.log('\n✓ Protocol deployed successfully!')
  console.log(`  Config:  ${configAppId}`)
  console.log(`  Factory: ${factoryAppId}`)
  console.log(`  USDC:    ${usdcId}`)
}

main().catch((err) => {
  console.error('Deployment failed:', err)
  process.exit(1)
})
