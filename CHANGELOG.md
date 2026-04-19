# Changelog

## 0.3.1 (2026-04-19)

- **Bug fix**: `getMarketState` now decodes outcome quantities from the `qp` global-state value (8 x UInt64 BE, sliced to `numOutcomes`). Previously it read them from per-outcome boxes (`q<idx>`) that the current contract does not create, so every call silently returned `quantities = [0, 0, ...]` and `prices` stuck at the uniform baseline (50/50 for binary, 20/20/20/20/20 for 5-outcome, etc.). All downstream consumers (frontends, MCP servers, indexers that use the SDK) were displaying stuck prices regardless of on-chain state.
- Exported `SHARE_UNIT` from the public `question-market` entrypoint.
- Added an `e2e-localnet` test (`getMarketState reflects actual on-chain quantities and LMSR prices`) that deploys binary + multi-outcome markets, executes asymmetric buys, and asserts quantities and price ordering. Fails against the prior box-reading code path.
- Tightened the previously trivially-passing `state.quantities[i] >= 0n` assertion in the 3-outcome buy+sell LP test.
- `deploy-localnet.ts` now waits up to 30s for algod + kmd to become ready after `algokit localnet reset` instead of erroring out on the first failed status probe.
- `sdkVersion` bumped to `0.3.1`.

## 0.3.0 (2026-04-18)

- Blueprint type system rewrite: replaced legacy node types (`market_evidence`, `llm_judge`, `human_judge`, `defer_resolution`, `submit_result`, `cancel_market`) with the engine model (`llm_call`, `agent_loop`, `await_signal`, `cel_eval`, `map`, `gadget`, `validate_blueprint`, `return`)
- New configs: `APIFetchConfig`, `LLMCallConfig`, `AgentLoopConfig`, `AwaitSignalConfig`, `WaitConfig`, `CelEvalConfig`, `MapConfig`, `GadgetConfig`, `ValidateBlueprintConfig`, `ReturnConfig`; agent tooling types (`AgentToolConfig`, `AgentOutputToolConfig`, `DynamicBlueprintPolicy`)
- Exported const tuples for all enum unions: `LLM_PROVIDERS`, `API_FETCH_METHODS`, `AGENT_OUTPUT_MODES`, `AGENT_TOOL_KINDS`, `AGENT_BUILTIN_TOOLS`, `RESOLUTION_WAIT_MODES`, `RESOLUTION_WAIT_START_FROMS`, `RESOLUTION_NODE_ERROR_MODES`
- Expanded validator: config-level checks for agent_loop, await_signal, wait, cel_eval, map, gadget, validate_blueprint, return; child blueprint validation, edge reference validation, input mapping validation, dynamic blueprint policy validation, LLM provider/model compatibility
- New presets: `api_fetch_wait`, `api_fetch_agent_loop`, `validate_blueprint_gadget`
- Capability metadata expanded with `AUTHORABLE_NODE_TYPES`, `defaultConfig` factories per node type, and `createDefaultNode` / `createNodeId` helpers
- Blueprint `summary` helpers (`summarizeNode`, `deriveTrustClass`, `summarizeTerminalActions`, `estimateCompiledBlueprint`) and `fallback` inference (`hasRenderableBlueprint`, `inferPresetId`)
- Indexer client rewrite: configurable request timeout with `AbortController`, cached Basic auth header, limit/pagination validation (`MAX_LIMIT`), query-string builder, typed responses (`IndexerMarketsResponse`, `IndexerMarketTradesResponse`, `IndexerPriceHistoryResponse`, `IndexerMarketPositionsResponse`, `IndexerUserPositionsResponse`, `IndexerUserLpResponse`, `IndexerLeaderboardResponse`, `IndexerHealthResponse`)
- New `src/indexer/client.test.ts` covering the indexer surface
- `deriveResolutionClassFromBlueprint` in market-schema classifies blueprints into source-based / agent-assisted / human-judged
- Stricter market-schema typings: `asRecord` helper, removal of `any` from `normalizeIndexerMarket`, dedicated input interfaces, `normalizeOutcomeCount` cap at 16 outcomes
- Added ESLint config (`eslint.config.mjs`) and repo-wide lint pass
- Removed contracts symlink, localnet/testnet deploy scripts, avm-pages utility, `protocol-deployment.json`, and contract-math test dependencies
- `sdkVersion` bumped to `0.3.0`

## 0.2.0 (2026-04-12)

- Synced ARC56 specs for `MarketFactory` and `QuestionMarket`
- Consolidated the atomic factory: `market-factory.ts` slimmed substantially
- Added `deploy-localnet.ts` and `seed-testnet.ts` scripts
- Localnet/integration test updates: `atomicity-localnet`, `avm-budget-benchmark`, `e2e-localnet`, `frontend-drift`, `market-factory`, `resolution-engine-smoke`, `stress-test`
- `sdkVersion` bumped to `0.2.0`

## 0.1.1 (2026-04-12)

- IPFS client for market images (`src/ipfs/client.ts`, `src/ipfs/index.ts`)
- Initial indexer client: `listMarkets`, `getMarket`, `getMarketTrades`, `getPriceHistory`, `getMarketPositions`, `getMarketLp`, `getUserPositions`, `getUserTrades`, `getUserLp`, `getLeaderboard`
- `web_search` flag on LLM judge config
- `imageCid` on `NormalizedIndexerMarket`
- Browser compat: replaced `createRequire` + `require()` in `contract-specs.ts` with JSON import assertions so the package loads in non-Node runtimes
- `sdkVersion` bumped to `0.1.1`

## 0.1.0 (2026-04-11)

Initial public release.

- LMSR fixed-point math matching the AVM contract implementation (exp, ln, logSumExp, cost, prices)
- Trade quoting: `quoteBuyForBudgetFromState`, `quoteBuyForSharesFromState`, `calculateSellReturn`
- AVM-safe trade validation: `calculateAvmBuyCost`, `isAvmBuySafe`
- Liquidity scaling for LP deposit/withdraw: `calculateLiquidityScaling`, `calculateLiquidityValue`
- Contract clients: market factory, question market (trading, liquidity, resolution), market schema, protocol config
- Resolution blueprint toolkit: compiler, validator, presets, types, cycle detection, capabilities
- Shared utilities in base: `ceilDiv`, `withMinFlatFee`, `withExplicitFlatFee`, `textEncoder`
- Parallel network calls in buy/sell/claim/refund for lower trade latency
- Question-market split into sub-modules: trading, liquidity, resolution, internal
- Removed deprecated `proposalBond`, `creator`, and `registerOutcomeAsa`
- 90 unit tests
