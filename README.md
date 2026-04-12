# @question/sdk

TypeScript SDK for [question.market](https://question.market) prediction market contracts on Algorand.

## Install

```bash
npm install @question/sdk
```

## What's in the box

**Contract clients** -- typed wrappers for on-chain operations:

- `market-factory` -- create markets atomically (bootstrap + fund + blueprint in one group)
- `question-market` -- buy, sell, LP entry, fee claims, residual claims, resolution
- `market-schema` -- market state parsing, version checks, status labels
- `protocol-config` -- protocol-level configuration reads
- `base` -- shared client config and Algorand connection types

**LMSR math** -- fixed-point arithmetic matching the AVM contract implementation:

- `quoteBuyForBudget` / `quoteBuyForShares` -- trade quoting from indexed state
- `exp`, `ln`, `logSumExp` -- Taylor-series approximations at `SCALE = 10^6`

**Blueprint toolkit** -- resolution blueprint compiler, validator, and presets:

- `compiler` -- template token replacement, validation, canonical JSON serialization
- `validate` -- DAG structure checks, node type validation, edge consistency
- `presets` -- built-in blueprint templates (API fetch, LLM judge, participant evidence, etc.)
- `types` -- full type definitions for blueprints, nodes, edges, trust classes

## Usage

```typescript
import { quoteBuyForBudgetFromState } from '@question/sdk'
import { buy, getMarketState } from '@question/sdk/clients/question-market'
import { compileResolutionBlueprint } from '@question/sdk/blueprints'
```

## Requirements

- Node.js 18+
- `algosdk` ^3.5.2 (peer dependency)

## License

MIT
