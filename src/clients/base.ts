import algosdk from 'algosdk'
import {
  MARKET_BOX_DISPUTE_BLUEPRINT,
  MARKET_BOX_MAIN_BLUEPRINT,
  MARKET_BOX_Q,
  MARKET_BOX_TOTAL_USER_SHARES,
  MARKET_BOX_USER_COST_BASIS_PREFIX,
  MARKET_BOX_USER_FEES_PREFIX,
  MARKET_BOX_USER_SHARES_PREFIX,
} from './market-schema'

export interface ClientConfig {
  algodClient: algosdk.Algodv2
  appId: number | bigint
  sender: string
  signer: algosdk.TransactionSigner
}

export interface MethodCallOptions {
  boxes?: algosdk.BoxReference[]
  appForeignApps?: number[]
  appForeignAssets?: number[]
  appAccounts?: string[]
  prependTxns?: algosdk.TransactionWithSigner[]
  note?: Uint8Array
  innerTxnCount?: number
}

/**
 * Load ABIMethod objects from an ARC56 spec's methods array.
 */
export function loadMethods(spec: any): Map<string, algosdk.ABIMethod> {
  const methods = new Map<string, algosdk.ABIMethod>()
  for (const m of spec.methods) {
    methods.set(m.name, new algosdk.ABIMethod(m))
  }
  return methods
}

/**
 * Call a contract ABI method via AtomicTransactionComposer.
 */
export async function callMethod(
  config: ClientConfig,
  methods: Map<string, algosdk.ABIMethod>,
  methodName: string,
  args: (algosdk.ABIValue | algosdk.TransactionWithSigner)[],
  opts?: MethodCallOptions,
): Promise<algosdk.ABIResult> {
  const method = methods.get(methodName)
  if (!method) throw new Error(`Method '${methodName}' not found in ABI spec`)

  const atc = new algosdk.AtomicTransactionComposer()

  // Add prepended transactions (e.g. MBR funding payments)
  if (opts?.prependTxns) {
    for (const txnWithSigner of opts.prependTxns) {
      atc.addTransaction(txnWithSigner)
    }
  }

  const suggestedParams = await config.algodClient.getTransactionParams().do()

  // Cover inner transaction fees via fee pooling
  if (opts?.innerTxnCount) {
    suggestedParams.flatFee = true
    suggestedParams.fee = BigInt((1 + opts.innerTxnCount) * 1000)
  }

  atc.addMethodCall({
    appID: Number(config.appId),
    method,
    methodArgs: args,
    sender: config.sender,
    suggestedParams,
    signer: config.signer,
    boxes: opts?.boxes,
    appForeignApps: opts?.appForeignApps,
    appForeignAssets: opts?.appForeignAssets,
    appAccounts: opts?.appAccounts,
    note: opts?.note,
  })

  const result = await atc.execute(config.algodClient, 4)
  return result.methodResults[0]
}

/**
 * Read decoded global state from an application.
 */
export async function readGlobalState(
  algod: algosdk.Algodv2,
  appId: number | bigint,
): Promise<Record<string, bigint | Uint8Array>> {
  const app = await algod.getApplicationByID(Number(appId)).do()
  const state: Record<string, bigint | Uint8Array> = {}

  for (const kv of app.params?.globalState ?? []) {
    const key = new TextDecoder().decode(kv.key)

    if (kv.value.type === 2) {
      state[key] = kv.value.uint
    } else {
      state[key] = kv.value.bytes
    }
  }

  return state
}

/**
 * Read a box value from an application.
 */
export async function readBox(
  algod: algosdk.Algodv2,
  appId: number | bigint,
  name: Uint8Array,
): Promise<Uint8Array> {
  const result = await algod.getApplicationBoxByName(Number(appId), name).do()
  return result.value
}

/**
 * Build a box name from a string prefix + uint64 key.
 */
export function boxName(prefix: string, key: number | bigint): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix)
  const keyBytes = algosdk.encodeUint64(Number(key))
  const combined = new Uint8Array(prefixBytes.length + keyBytes.length)
  combined.set(prefixBytes, 0)
  combined.set(keyBytes, prefixBytes.length)
  return combined
}

/**
 * Build a box name from a string prefix + address bytes.
 */
export function boxNameAddr(prefix: string, address: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix)
  const addrBytes = algosdk.decodeAddress(address).publicKey
  const combined = new Uint8Array(prefixBytes.length + addrBytes.length)
  combined.set(prefixBytes, 0)
  combined.set(addrBytes, prefixBytes.length)
  return combined
}

/**
 * Build a box name from prefix + address + uint64 index.
 */
export function boxNameAddrIdx(prefix: string, address: string, index: number | bigint): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix)
  const addrBytes = algosdk.decodeAddress(address).publicKey
  const idxBytes = algosdk.encodeUint64(Number(index))
  const combined = new Uint8Array(prefixBytes.length + addrBytes.length + idxBytes.length)
  combined.set(prefixBytes, 0)
  combined.set(addrBytes, prefixBytes.length)
  combined.set(idxBytes, prefixBytes.length + addrBytes.length)
  return combined
}

/**
 * Build box references for a market contract call.
 * AVM limits to 8 box refs per transaction, so we must be selective.
 */
export function marketBoxRefs(
  appId: number,
  numOutcomes: number,
  sender?: string,
  outcomeIndex?: number,
): algosdk.BoxReference[] {
  const refs: algosdk.BoxReference[] = pricingBoxRefs(appId, numOutcomes)
  refs.push({ appIndex: appId, name: new TextEncoder().encode(MARKET_BOX_TOTAL_USER_SHARES) })

  // User-specific boxes for the traded outcome
  if (sender !== undefined && outcomeIndex !== undefined) {
    refs.push({ appIndex: appId, name: boxNameAddrIdx(MARKET_BOX_USER_SHARES_PREFIX, sender, outcomeIndex) })
    refs.push({ appIndex: appId, name: boxNameAddrIdx(MARKET_BOX_USER_COST_BASIS_PREFIX, sender, outcomeIndex) })
    refs.push({ appIndex: appId, name: boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, sender) })
  } else if (sender) {
    refs.push({ appIndex: appId, name: boxNameAddr(MARKET_BOX_USER_FEES_PREFIX, sender) })
  }

  return refs
}

/**
 * Box refs for LMSR pricing state only.
 */
export function pricingBoxRefs(
  appId: number,
  numOutcomes: number,
): algosdk.BoxReference[] {
  return Array.from({ length: numOutcomes }, (_, i) => ({
    appIndex: appId,
    name: boxName(MARKET_BOX_Q, i),
  }))
}

/**
 * Box refs for bootstrap: q boxes per outcome, total-user-shares, and the
 * main/dispute blueprint boxes required by the contract before bootstrap.
 */
export function bootstrapBoxRefs(appId: number, numOutcomes: number): algosdk.BoxReference[] {
  const refs: algosdk.BoxReference[] = []
  for (let i = 0; i < numOutcomes; i++) {
    refs.push({ appIndex: appId, name: boxName(MARKET_BOX_Q, i) })
  }
  refs.push({ appIndex: appId, name: new TextEncoder().encode(MARKET_BOX_TOTAL_USER_SHARES) })
  refs.push({ appIndex: appId, name: new TextEncoder().encode(MARKET_BOX_MAIN_BLUEPRINT) })
  refs.push({ appIndex: appId, name: new TextEncoder().encode(MARKET_BOX_DISPUTE_BLUEPRINT) })
  return refs
}
