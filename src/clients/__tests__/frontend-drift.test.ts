/**
 * Frontend drift guard -- ensures the frontend's contract specs and box-ref
 * helpers stay in sync with the compiled artifacts and the working SDK E2E.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const ARTIFACTS = path.resolve(ROOT, "../contracts/smart_contracts/artifacts");
const FRONTEND_CONTRACTS = path.resolve(ROOT, "../frontend/src/lib/contracts");
const SDK_CONTRACTS = path.resolve(ROOT, "src/clients/specs");
const FRONTEND_COMPILED_PROGRAMS = path.resolve(
  ROOT,
  "../frontend/src/lib/contracts/compiled-programs.json"
);
const FRONTEND_CHAIN = path.resolve(ROOT, "../frontend/src/lib/chain.ts");
const FRONTEND_CHAIN_CLIENT = path.resolve(ROOT, "../frontend/src/lib/chain-client.ts");
const FRONTEND_CREATE = path.resolve(
  ROOT,
  "../frontend/src/lib/create-market.ts"
);
const FRONTEND_TRADE = path.resolve(ROOT, "../frontend/src/lib/trade.ts");
const FRONTEND_LIFECYCLE = path.resolve(
  ROOT,
  "../frontend/e2e/lifecycle-e2e.ts"
);

function loadSpec(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function itIfFiles(
  requiredPaths: string[],
  name: string,
  fn: Parameters<typeof it>[1]
) {
  const runner = requiredPaths.every((filePath) => fs.existsSync(filePath))
    ? it
    : it.skip;
  runner(name, fn);
}

function methodSignature(method: any): string {
  const args = method.args.map((a: any) => a.type).join(",");
  const ret = method.returns?.type ?? "void";
  return `${method.name}(${args})${ret}`;
}

function countArrayLiteralEntries(source: string): number {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function extractFunctionBody(source: string, name: string): string {
  const fnMatch = source.match(
    new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}[\\s\\S]*?^}`, "m")
  );
  expect(fnMatch, `${name} function not found`).toBeTruthy();
  return fnMatch![0];
}

describe("Frontend spec drift guard", () => {
  itIfFiles([
    path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json"),
    path.join(FRONTEND_CONTRACTS, "QuestionMarket.arc56.json"),
  ], "frontend QuestionMarket.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json")
    );
    const frontend = loadSpec(
      path.join(FRONTEND_CONTRACTS, "QuestionMarket.arc56.json")
    );
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const frontendSigs = frontend.methods.map(methodSignature).sort();
    expect(frontendSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json"),
    path.join(FRONTEND_CONTRACTS, "MarketFactory.arc56.json"),
  ], "frontend MarketFactory.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json")
    );
    const frontend = loadSpec(
      path.join(FRONTEND_CONTRACTS, "MarketFactory.arc56.json")
    );
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const frontendSigs = frontend.methods.map(methodSignature).sort();
    expect(frontendSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json"),
    path.join(SDK_CONTRACTS, "QuestionMarket.arc56.json"),
  ], "sdk QuestionMarket.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json")
    );
    const sdk = loadSpec(path.join(SDK_CONTRACTS, "QuestionMarket.arc56.json"));
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const sdkSigs = sdk.methods.map(methodSignature).sort();
    expect(sdkSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json"),
    path.join(SDK_CONTRACTS, "MarketFactory.arc56.json"),
  ], "sdk MarketFactory.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json")
    );
    const sdk = loadSpec(path.join(SDK_CONTRACTS, "MarketFactory.arc56.json"));
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const sdkSigs = sdk.methods.map(methodSignature).sort();
    expect(sdkSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json"),
    path.join(FRONTEND_CONTRACTS, "ProtocolConfig.arc56.json"),
  ], "frontend ProtocolConfig.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json")
    );
    const frontend = loadSpec(
      path.join(FRONTEND_CONTRACTS, "ProtocolConfig.arc56.json")
    );
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const frontendSigs = frontend.methods.map(methodSignature).sort();
    expect(frontendSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json"),
    path.join(SDK_CONTRACTS, "ProtocolConfig.arc56.json"),
  ], "sdk ProtocolConfig.arc56.json matches compiled artifact", () => {
    const compiled = loadSpec(
      path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json")
    );
    const sdk = loadSpec(path.join(SDK_CONTRACTS, "ProtocolConfig.arc56.json"));
    const compiledSigs = compiled.methods.map(methodSignature).sort();
    const sdkSigs = sdk.methods.map(methodSignature).sort();
    expect(sdkSigs).toEqual(compiledSigs);
  });

  itIfFiles([
    FRONTEND_COMPILED_PROGRAMS,
    path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json"),
    path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json"),
    path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json"),
  ], "frontend compiled-programs.json matches compiled artifact bytecode", () => {
    const compiledPrograms = loadSpec(FRONTEND_COMPILED_PROGRAMS);
    const questionMarket = loadSpec(
      path.join(ARTIFACTS, "market_app/QuestionMarket.arc56.json")
    );
    const marketFactory = loadSpec(
      path.join(ARTIFACTS, "market_factory/MarketFactory.arc56.json")
    );
    const protocolConfig = loadSpec(
      path.join(ARTIFACTS, "protocol_config/ProtocolConfig.arc56.json")
    );

    expect(compiledPrograms["QuestionMarket.approval"]).toBe(questionMarket.byteCode.approval);
    expect(compiledPrograms["QuestionMarket.clear"]).toBe(questionMarket.byteCode.clear);
    expect(compiledPrograms["MarketFactory.approval"]).toBe(marketFactory.byteCode.approval);
    expect(compiledPrograms["MarketFactory.clear"]).toBe(marketFactory.byteCode.clear);
    expect(compiledPrograms["ProtocolConfig.approval"]).toBe(protocolConfig.byteCode.approval);
    expect(compiledPrograms["ProtocolConfig.clear"]).toBe(protocolConfig.byteCode.clear);
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "chain-client.ts references shared market box constants", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    for (const constantName of [
      "MARKET_BOX_Q",
      "MARKET_BOX_USER_SHARES_PREFIX",
      "MARKET_BOX_USER_COST_BASIS_PREFIX",
      "MARKET_BOX_USER_FEES_PREFIX",
      "MARKET_BOX_TOTAL_USER_SHARES",
      "MARKET_BOX_MAIN_BLUEPRINT",
      "MARKET_BOX_DISPUTE_BLUEPRINT",
    ]) {
      expect(chainSrc, `Missing shared box constant: "${constantName}"`).toContain(
        constantName
      );
    }
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "bootstrapBoxRefs includes shared totals and blueprint boxes", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    const fnMatch = chainSrc.match(/function bootstrapBoxRefs[\s\S]*?^}/m);
    expect(fnMatch, "bootstrapBoxRefs not found").toBeTruthy();
    expect(fnMatch![0]).toContain("BOX_TOTAL_USER_SHARES");
    expect(fnMatch![0]).toContain("BOX_MAIN_BLUEPRINT");
    expect(fnMatch![0]).toContain("BOX_DISPUTE_BLUEPRINT");
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "tradeBoxRefs includes total-user-shares box", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    const fnMatch = chainSrc.match(/function tradeBoxRefs[\s\S]*?^}/m);
    expect(fnMatch, "tradeBoxRefs not found").toBeTruthy();
    expect(fnMatch![0]).toContain("BOX_TOTAL_USER_SHARES");
  });

  itIfFiles([FRONTEND_CREATE], "create-market.ts delegates UI creation to the atomic SDK path only", () => {
    const createSrc = fs.readFileSync(FRONTEND_CREATE, "utf8");
    expect(createSrc).toContain("createMarketAtomic");
    expect(createSrc).toContain("MAX_ACTIVE_LP_OUTCOMES");
    expect(createSrc).toContain("readConfig");
    expect(createSrc).toContain("getAtomicCreateSupportError");
    expect(createSrc).not.toContain("bootstrapBoxRefs");
    expect(createSrc).not.toContain("store_main_blueprint");
    expect(createSrc).not.toContain("store_dispute_blueprint");
    expect(createSrc).not.toContain("Falling back to legacy flow");
    expect(createSrc).not.toContain(
      "makeAssetCreateTxnWithSuggestedParamsFromObject"
    );
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "executeWithBudget auto-injects prependTxns as axfer method args", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    // Must handle prependTxns -> axfer arg injection
    expect(chainSrc).toContain("txnArgTypes");
    expect(chainSrc).toContain("abiArgTypes");
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "noopCount default is at least 14 for opcode budget", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    const match = chainSrc.match(/noopCount\s*\?\?\s*Math\.max\((\d+)/);
    expect(match, "noopCount default not found").toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(14);
  });

  itIfFiles([FRONTEND_CREATE], "create-market.ts does not hand-roll factory ABI args or standalone prerequisite txns", () => {
    const createSrc = fs.readFileSync(FRONTEND_CREATE, "utf8");
    expect(createSrc).not.toContain("const createArgs = [");
    expect(createSrc).not.toContain("Opting into USDC...");
    expect(createSrc).not.toContain("AtomicTransactionComposer");
  });

  itIfFiles([FRONTEND_CREATE], "frontend create-market preserves ARC-2 metadata note for atomic flow", () => {
    const createSrc = fs.readFileSync(FRONTEND_CREATE, "utf8");
    expect(createSrc).toContain("question.market:j");
    expect(createSrc).toContain("noteBytes");
  });

  itIfFiles([
    path.join(FRONTEND_CONTRACTS, "MarketFactory.arc56.json"),
    FRONTEND_LIFECYCLE,
  ], "lifecycle-e2e uses the current create_market ABI and no removed dispute hook", () => {
    const spec = loadSpec(
      path.join(FRONTEND_CONTRACTS, "MarketFactory.arc56.json")
    );
    const createMarket = spec.methods.find(
      (m: any) => m.name === "create_market"
    );
    expect(createMarket).toBeTruthy();

    const lifecycleSrc = fs.readFileSync(FRONTEND_LIFECYCLE, "utf8");
    const argsMatch = lifecycleSrc.match(
      /const createArgs:[\s\S]*?=\s*\[([\s\S]*?)\n\s*\]/m
    );
    expect(argsMatch).toBeTruthy();
    expect(countArrayLiteralEntries(argsMatch![1])).toBe(
      createMarket.args.length
    );
    expect(lifecycleSrc).toContain("store_main_blueprint");
    expect(lifecycleSrc).toContain("store_dispute_blueprint");
  });
});

// ---------------------------------------------------------------------------
// SDK noop budget and resolution method drift guard
// ---------------------------------------------------------------------------

describe("SDK noop budget and resolution method validation", () => {
  const SDK_QUESTION_MARKET_INTERNAL = path.resolve(
    ROOT,
    "src/clients/question-market/internal.ts"
  );
  const SDK_QUESTION_MARKET_TRADING = path.resolve(
    ROOT,
    "src/clients/question-market/trading.ts"
  );
  const SDK_QUESTION_MARKET_RESOLUTION = path.resolve(
    ROOT,
    "src/clients/question-market/resolution.ts"
  );

  itIfFiles([FRONTEND_CHAIN_CLIENT], "frontend executeWithBudget default noop count is >= 14", () => {
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    const match = chainSrc.match(/noopCount\s*\?\?\s*Math\.max\((\d+)/);
    expect(match, "noopCount default not found in chain.ts").toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(14);
  });

  it("SDK buy uses sufficient noops (scales with outcomes)", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_INTERNAL, "utf8");
    const noopFnMatch = src.match(
      /function noopsFor\(numOutcomes: number\): number \{([\s\S]*?)\n\}/m
    );
    expect(noopFnMatch, "noopsFor helper not found").toBeTruthy();
    expect(noopFnMatch![1]).toContain("if (numOutcomes <= 2) return 10");
    expect(noopFnMatch![1]).toContain("if (numOutcomes <= 3) return 14");

    const buyFn = extractFunctionBody(
      fs.readFileSync(SDK_QUESTION_MARKET_TRADING, "utf8"),
      "buy"
    );
    expect(buyFn).toContain("callWithBudget(config, 'buy'");
    expect(buyFn).toContain("noopsFor(numOutcomes)");
  });

  it("SDK callWithBudget for sell uses at least 10 noops", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_TRADING, "utf8");
    const sellFn = extractFunctionBody(src, "sell");
    expect(sellFn).toContain("callWithBudget(config, 'sell'");
    expect(sellFn).toContain("noopsFor(numOutcomes)");
  });

  it("SDK triggerResolution uses callWithBudget, not callMethod", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_RESOLUTION, "utf8");
    // Extract the triggerResolution function body
    const fnMatch = src.match(
      /export async function triggerResolution[\s\S]*?^}/m
    );
    expect(fnMatch, "triggerResolution function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("callWithBudget");
    expect(fnMatch![0]).toContain("readGlobalState");
    expect(fnMatch![0]).toContain("getLatestBlockTimestamp");
    expect(fnMatch![0]).not.toMatch(/\bcallMethod\b/);
  });

  it("SDK proposeResolution uses callWithBudget, not callMethod", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_RESOLUTION, "utf8");
    const fnMatch = src.match(
      /export async function proposeResolution[\s\S]*?^}/m
    );
    expect(fnMatch, "proposeResolution function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("callWithBudget");
    expect(fnMatch![0]).not.toMatch(/\bcallMethod\b/);
  });

  it("SDK proposeEarlyResolution uses callWithBudget, not callMethod", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_RESOLUTION, "utf8");
    const fnMatch = src.match(
      /export async function proposeEarlyResolution[\s\S]*?^}/m
    );
    expect(fnMatch, "proposeEarlyResolution function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("callWithBudget");
    expect(fnMatch![0]).not.toMatch(/\bcallMethod\b/);
  });

  it("SDK finalizeResolution uses callWithBudget, not callMethod", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_RESOLUTION, "utf8");
    const fnMatch = src.match(
      /export async function finalizeResolution[\s\S]*?^}/m
    );
    expect(fnMatch, "finalizeResolution function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("callWithBudget");
    expect(fnMatch![0]).not.toMatch(/\bcallMethod\b/);
  });

  it("SDK abortEarlyResolution uses callWithBudget, not callMethod", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_RESOLUTION, "utf8");
    const fnMatch = src.match(
      /export async function abortEarlyResolution[\s\S]*?^}/m
    );
    expect(fnMatch, "abortEarlyResolution function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("callWithBudget");
    expect(fnMatch![0]).not.toMatch(/\bcallMethod\b/);
  });

  it("SDK bootstrap noopCount is at least 3", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_INTERNAL, "utf8");
    const bootstrapFn = extractFunctionBody(src, "bootstrap");
    expect(bootstrapFn).toContain("callWithBudget(config, 'bootstrap'");
    expect(bootstrapFn).toContain("noopsFor(numOutcomes)");
  });

  it("SDK opt-in builders do not rely on stale local caches", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_INTERNAL, "utf8");
    expect(src).not.toContain("asaOptedInCache");
    expect(src).not.toContain("appOptedInCache");

    const asaBuilder = extractFunctionBody(src, "buildAsaOptInIfNeeded");
    expect(asaBuilder).toContain("accountAssetInformation");

    const appBuilder = extractFunctionBody(src, "buildAppOptInIfNeeded");
    expect(appBuilder).toContain("accountApplicationInformation");
  });

  it("SDK clones transaction args and prepend txns before budget simulations", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_INTERNAL, "utf8");
    expect(src).toContain("function cloneTxnWithSigner");
    expect(src).toContain("function cloneMethodArgs");

    const buildFn = src.match(/async function buildBudgetedCall[\s\S]*?^}/m);
    expect(buildFn, "buildBudgetedCall not found").toBeTruthy();
    expect(buildFn![0]).toContain("cloneTxnWithSigner(txnWithSigner");
    expect(buildFn![0]).toContain("const methodArgs = cloneMethodArgs(args");
  });

  it("SDK withdrawPendingPayouts prepends USDC opt-in in the same group", () => {
    const src = fs.readFileSync(SDK_QUESTION_MARKET_TRADING, "utf8");
    const fnMatch = src.match(
      /export async function withdrawPendingPayouts[\s\S]*?^}/m
    );
    expect(fnMatch, "withdrawPendingPayouts function not found").toBeTruthy();
    expect(fnMatch![0]).toContain("prependTxns");
    expect(fnMatch![0]).toContain("buildAsaOptInIfNeeded");
    expect(fnMatch![0]).toContain(
      "callWithBudget(config, 'withdraw_pending_payouts'"
    );
  });

  itIfFiles([FRONTEND_CHAIN_CLIENT], "SDK tradeBoxRefs includes shared total-user-shares box for trade calls", () => {
    // The frontend chain-client tradeBoxRefs must include the shared total-user-shares box.
    // The SDK's marketBoxRefs is used for claim/sell/buy via callWithBudget overrides.
    const chainSrc = fs.readFileSync(FRONTEND_CHAIN_CLIENT, "utf8");
    const fnMatch = chainSrc.match(/function tradeBoxRefs[\s\S]*?^}/m);
    expect(fnMatch, "tradeBoxRefs not found").toBeTruthy();
    expect(fnMatch![0]).toContain("BOX_TOTAL_USER_SHARES");
  });

  it("SDK bootstrapBoxRefs includes shared totals and blueprint constants", () => {
    const baseSrc = fs.readFileSync(
      path.resolve(ROOT, "src/clients/base.ts"),
      "utf8"
    );
    const fnMatch = baseSrc.match(
      /export function bootstrapBoxRefs[\s\S]*?^}/m
    );
    expect(fnMatch, "bootstrapBoxRefs not found in base.ts").toBeTruthy();
    expect(fnMatch![0]).toContain("MARKET_BOX_MAIN_BLUEPRINT");
    expect(fnMatch![0]).toContain("MARKET_BOX_DISPUTE_BLUEPRINT");
    expect(fnMatch![0]).toContain("MARKET_BOX_TOTAL_USER_SHARES");
  });
});
