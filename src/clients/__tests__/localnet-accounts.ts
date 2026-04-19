import algosdk from 'algosdk'

const KMD_TOKEN = 'a'.repeat(64)
const KMD_SERVER = 'http://127.0.0.1'
const KMD_PORT = 4002

export type LocalnetAccount = {
  addr: string
  sk: Uint8Array
  signer: algosdk.TransactionSigner
  balance: bigint
}

async function getDefaultWalletHandle(kmd: algosdk.Kmd): Promise<string> {
  const wallets = await kmd.listWallets()
  const defaultWallet = wallets.wallets.find((wallet: any) => wallet.name === 'unencrypted-default-wallet')
  if (!defaultWallet) throw new Error('Default localnet wallet not found')
  return (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token
}

export async function loadLocalnetWalletAccounts(
  algod: algosdk.Algodv2,
  minCount = 0,
): Promise<LocalnetAccount[]> {
  const kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT)
  const handle = await getDefaultWalletHandle(kmd)

  try {
    const keys = await kmd.listKeys(handle)
    while (keys.addresses.length < minCount) {
      const generated = await kmd.generateKey(handle)
      keys.addresses.push(generated.address)
    }

    const accounts: LocalnetAccount[] = []
    for (const addr of keys.addresses) {
      const secret = await kmd.exportKey(handle, '', addr)
      let balance = 0n
      try {
        const acctInfo = await algod.accountInformation(addr).do()
        balance = BigInt(acctInfo.amount ?? 0)
      } catch {
        balance = 0n
      }
      accounts.push({
        addr,
        sk: secret.private_key,
        signer: algosdk.makeBasicAccountTransactionSigner({ addr, sk: secret.private_key } as any),
        balance,
      })
    }
    return accounts
  } finally {
    await kmd.releaseWalletHandle(handle)
  }
}

export async function getFundedLocalnetAccount(
  algod: algosdk.Algodv2,
): Promise<LocalnetAccount> {
  const accounts = await loadLocalnetWalletAccounts(algod, 1)
  const funded = [...accounts].sort((a, b) => Number(b.balance - a.balance))[0]
  if (!funded || funded.balance <= 0n) {
    throw new Error('No funded localnet account found in default wallet')
  }
  return funded
}

export async function getLocalnetAccountAtIndex(
  algod: algosdk.Algodv2,
  index: number,
): Promise<LocalnetAccount> {
  const accounts = await loadLocalnetWalletAccounts(algod, index + 1)
  const account = accounts[index]
  if (!account) throw new Error(`No localnet key at index ${index}`)
  return account
}

export async function getLocalnetAccountByAddress(
  algod: algosdk.Algodv2,
  address: string,
): Promise<LocalnetAccount> {
  const accounts = await loadLocalnetWalletAccounts(algod, 1)
  const account = accounts.find((candidate) => candidate.addr === address)
  if (!account) {
    throw new Error(`Localnet account ${address} not found in default wallet`)
  }
  return account
}
