# @questionmarket/sdk

TypeScript SDK for [question.market](https://question.market) prediction market contracts on Algorand.

## Install

```bash
npm install @questionmarket/sdk
```

## What's in the box

**Contract clients** -- typed wrappers for on-chain operations:

- `market-factory` -- create markets atomically (bootstrap + fund + blueprint in one group)
- `question-market` -- buy, sell, LP entry, fee claims, residual claims, resolution
- `market-schema` -- market state parsing, version checks, status labels
- `protocol-config` -- protocol-level configuration reads
- `base` -- shared client config and Algorand connection types

**LMSR math** -- fixed-point arithmetic matching the AVM contract implementation:

- `quoteBuyForBudgetFromState` / `quoteBuyForSharesFromState` -- trade quoting from indexed state
- `calculatePrices` -- current price vector from LMSR state
- `calculateSellReturn` -- USDC returned when selling shares
- `expFp`, `lnFp`, `logSumExpFp` -- Taylor-series approximations at `SCALE = 10^6`

**Blueprint toolkit** -- resolution blueprint compiler, validator, and presets:

- `compiler` -- template token replacement, validation, canonical JSON serialization
- `validate` -- DAG structure checks, node type validation, edge consistency
- `presets` -- built-in blueprint templates (API fetch, LLM judge, participant evidence, etc.)
- `types` -- full type definitions for blueprints, nodes, edges, trust classes

## Examples

### Get prices for a market

```typescript
import { calculatePrices, SCALE } from '@questionmarket/sdk'

// quantities and b come from on-chain state (all fixed-point at SCALE = 10^6)
const quantities = [5_000_000n, 3_000_000n, 2_000_000n]
const b = 10_000_000n

const prices = calculatePrices(quantities, b)
// prices[i] / SCALE gives the probability for outcome i
// prices always sum to SCALE (1.0)
console.log(prices.map(p => Number(p) / Number(SCALE)))
```

### Quote a buy trade

```typescript
import { quoteBuyForBudgetFromState } from '@questionmarket/sdk'

const quote = quoteBuyForBudgetFromState(
  {
    quantities: [5_000_000n, 3_000_000n],
    b: 10_000_000n,
    lpFeeBps: 100,      // 1% LP fee
    protocolFeeBps: 25,  // 0.25% protocol fee
  },
  0,                     // buy outcome 0
  500_000n,              // budget: 0.50 USDC (in micro-USDC)
)

console.log({
  shares: quote.shares,         // shares received (fixed-point)
  totalCost: quote.totalCost,   // actual cost in micro-USDC
  beforePrices: quote.beforePrices,
  afterPrices: quote.afterPrices,
})
```

### Compile a resolution blueprint

```typescript
import { compileResolutionBlueprint } from '@questionmarket/sdk/blueprints'
import type { ResolutionBlueprint } from '@questionmarket/sdk/blueprints'

const blueprint: ResolutionBlueprint = {
  id: 'entropy-reversal',
  version: 1,
  nodes: [
    {
      id: 'judge',
      type: 'llm_judge',
      label: 'Evaluate evidence',
      config: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        prompt:
          'Question: {{market.question}}\n' +
          'Outcomes: {{market.outcomes.indexed}}\n\n' +
          'Evaluate available evidence and return the correct outcome index.',
        require_citations: false,
        timeout_seconds: 60,
      },
      position: { x: 0, y: 0 },
    },
    {
      id: 'submit',
      type: 'submit_result',
      label: 'Submit',
      config: { outcome_key: 'judge.outcome' },
      position: { x: 200, y: 0 },
    },
  ],
  edges: [{ from: 'judge', to: 'submit' }],
}

const compiled = compileResolutionBlueprint(blueprint, {
  question: 'Can entropy be reversed?',
  outcomes: ['Yes', 'No', 'Not enough data'],
  deadline: 1797897600,
})

console.log(`Blueprint size: ${compiled.bytes.length} bytes`)
```

### Execute a trade on-chain

```typescript
import algosdk from 'algosdk'
import { buy, getMarketState } from '@questionmarket/sdk/clients/question-market'

const algodClient = new algosdk.Algodv2('token', 'http://localhost', 4001)
const account = algosdk.mnemonicToSecretKey('your mnemonic here')
const signer = algosdk.makeBasicAccountTransactionSigner(account)
const appId = 1234
const marketState = await getMarketState(algodClient, appId)

await buy(
  {
    algodClient,
    appId,
    sender: account.addr,
    signer,
  },
  0,             // outcome index
  500_000n,      // max 0.50 USDC
  marketState.numOutcomes,
  31_566_704,    // USDC ASA ID
  1_000_000n,    // 1 share
)
```

## Fixed-point conventions

All numeric values use `bigint` with a scale factor of `10^6` (the `SCALE` constant):

- 1 share = `1_000_000n`
- 1 USDC = `1_000_000n` (micro-USDC)
- A price of 0.75 = `750_000n`
- Prices always sum to `SCALE`

This matches the Algorand contract's uint64 fixed-point arithmetic exactly.

## Requirements

- Node.js 20+

`algosdk` is shipped as a package dependency.

## License

MIT
