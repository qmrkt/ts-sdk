import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import referenceVectors from './fixtures/lmsr_reference_vectors.json';
import {
  BUY_BUDGET_TOO_SMALL_MESSAGE,
  BUY_SINGLE_TXN_TOO_LARGE_MESSAGE,
  MAX_UINT64,
  SCALE,
  SHARE_GRANULARITY,
  calculateAvmBuyCost,
  calculateBuyCost,
  calculateCost,
  calculateLiquidityScaling,
  calculateLiquidityValue,
  calculatePrices,
  calculateSellReturn,
  isAvmBuySafe,
  quoteBuyForBudgetFromState,
  quoteBuyForSharesFromState,
  sdkVersion,
} from './index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version: string }
).version;

type ReferenceCase = {
  id: string;
  q: number[];
  b: number;
  cost: number;
  cost_delta: number;
  prices: number[];
  buy: {
    outcome: number;
    shares: number;
  };
  lp: {
    deposit: number;
    pool: number;
  };
  liquidity_scale: {
    scaled_q: number[];
    scaled_b: number;
  };
};

function toBigIntArray(values: number[]): bigint[] {
  return values.map((value) => BigInt(value));
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

describe('sdk scaffold', () => {
  it('exports a version constant', () => {
    expect(sdkVersion).toBe(PACKAGE_VERSION);
  });
});

describe('calculateBuyCost reference vectors', () => {
  for (const testCase of referenceVectors.cases as ReferenceCase[]) {
    it(`calculateBuyCost matches C1 reference vector ${testCase.id}`, () => {
      const quantities = toBigIntArray(testCase.q);
      const buyCost = calculateBuyCost(quantities, BigInt(testCase.b), testCase.buy.outcome, BigInt(testCase.buy.shares));
      const marketCost = calculateCost(quantities, BigInt(testCase.b));

      expect(buyCost).toBe(BigInt(testCase.cost_delta));
      expect(marketCost).toBe(BigInt(testCase.cost));
    });
  }
});

describe('calculatePrices prices sum', () => {
  for (const testCase of referenceVectors.cases as ReferenceCase[]) {
    it(`calculatePrices matches reference vector ${testCase.id}`, () => {
      const prices = calculatePrices(toBigIntArray(testCase.q), BigInt(testCase.b));
      expect(prices).toEqual(toBigIntArray(testCase.prices));
      expect(sum(prices)).toBe(SCALE);
    });
  }

  it('prices sum to 1.0 in fixed-point units', () => {
    const prices = calculatePrices([100000n, 200000n, 350000n, 500000n, 900000n], 750000n);
    expect(sum(prices)).toBe(1_000_000n);
  });
});

describe('calculateLiquidityValue LP position valuation', () => {
  it('returns pool claim plus accrued fees', () => {
    const result = calculateLiquidityValue({
      poolBalance: 5_000_000n,
      lpSharesTotal: 1_000_000n,
      userLpShares: 250_000n,
      cumulativeFeePerShare: 180_000n,
      userFeeSnapshot: 100_000n,
    });

    expect(result).toEqual({
      poolClaim: 1_250_000n,
      accruedFees: 20_000n,
      totalValue: 1_270_000n,
    });
  });

  it('returns zero for zero LP shares', () => {
    expect(
      calculateLiquidityValue({
        poolBalance: 5_000_000n,
        lpSharesTotal: 1_000_000n,
        userLpShares: 0n,
      }),
    ).toEqual({
      poolClaim: 0n,
      accruedFees: 0n,
      totalValue: 0n,
    });
  });
});

describe('calculateLiquidityScaling price-preserving LP scaling', () => {
  for (const testCase of referenceVectors.cases as ReferenceCase[]) {
    it(`calculateLiquidityScaling matches reference vector ${testCase.id}`, () => {
      const result = calculateLiquidityScaling({
        type: 'deposit',
        quantities: toBigIntArray(testCase.q),
        b: BigInt(testCase.b),
        poolBalance: BigInt(testCase.lp.pool),
        lpSharesTotal: 1_000_000n,
        depositAmount: BigInt(testCase.lp.deposit),
      });

      expect(result.type).toBe('deposit');
      if (result.type !== 'deposit') {
        throw new Error('expected deposit result');
      }

      expect(result.scaledQuantities).toEqual(toBigIntArray(testCase.liquidity_scale.scaled_q));
      expect(result.scaledB).toBe(BigInt(testCase.liquidity_scale.scaled_b));

      const pricesBefore = calculatePrices(toBigIntArray(testCase.q), BigInt(testCase.b));
      const pricesAfter = calculatePrices(result.scaledQuantities, result.scaledB);
      expect(pricesAfter).toEqual(pricesBefore);
    });
  }

  it('preserves prices on withdraw', () => {
    const quantities = [100000n, 200000n, 350000n, 500000n, 900000n];
    const result = calculateLiquidityScaling({
      type: 'withdraw',
      quantities,
      b: 750000n,
      poolBalance: 3_000_000n,
      lpSharesTotal: 1_000_000n,
      withdrawShares: 250_000n,
    });

    expect(result.type).toBe('withdraw');
    if (result.type !== 'withdraw') {
      throw new Error('expected withdraw result');
    }

    expect(calculatePrices(result.scaledQuantities, result.scaledB)).toEqual(calculatePrices(quantities, 750000n));
    expect(result.usdcReturned).toBe(750_000n);
  });
});

describe('C1 known-good reference vector coverage', () => {
  it('covers checked-in deterministic fixtures', () => {
    expect(referenceVectors.version).toBe(1);
    expect(referenceVectors.scale).toBe(1_000_000);
    expect((referenceVectors.cases as ReferenceCase[]).length).toBeGreaterThan(0);
  });
});

describe('budget-edge standalone regressions', () => {
  it('detects exponent overflow before a buy reaches the contract', () => {
    const maxExponentQuantity = MAX_UINT64 / SCALE;

    expect(isAvmBuySafe([maxExponentQuantity - 1n, 0n], 1_000_000n, 0, 1n)).toBe(true);
    expect(isAvmBuySafe([maxExponentQuantity, 0n], 1_000_000n, 0, 1n)).toBe(false);
  });

  it('detects buys that push AVM LMSR math beyond a single transaction', () => {
    expect(isAvmBuySafe([0n, 0n], 50_000_000n, 0, 1_000_000_000n)).toBe(false);
  });

  it('returns a safe shared budget quote for the 50M-b $10 regression case', () => {
    const quote = quoteBuyForBudgetFromState({
      quantities: [0n, 0n],
      b: 50_000_000n,
      lpFeeBps: 200,
      protocolFeeBps: 50,
    }, 0, 10_000_000n);

    expect(quote.error).toBe('');
    expect(quote.shares).toBeGreaterThan(0n);
    expect(quote.shares % SHARE_GRANULARITY).toBe(0n);
    expect(quote.totalCost).toBeLessThanOrEqual(10_000_000n);
  });

  it('floors budget quotes to whole-share granularity', () => {
    const quote = quoteBuyForBudgetFromState({
      quantities: [0n, 0n],
      b: 50_000_000n,
      lpFeeBps: 200,
      protocolFeeBps: 50,
    }, 0, 10_000_000n);

    expect(quote.error).toBe('');
    expect(quote.shares).toBeGreaterThanOrEqual(SHARE_GRANULARITY);
    expect(quote.shares % SHARE_GRANULARITY).toBe(0n);
  });

  it('returns the shared chunking guidance for a budget beyond the AVM domain', () => {
    const quote = quoteBuyForBudgetFromState({
      quantities: [0n, 0n],
      b: 50_000_000n,
      lpFeeBps: 200,
      protocolFeeBps: 50,
    }, 0, 1_000_000_000n);

    expect(quote.shares).toBe(0n);
    expect(quote.error).toBe(BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
  });

  it('returns the shared chunking guidance for an explicit AVM-unsafe share target', () => {
    const quote = quoteBuyForSharesFromState({
      quantities: [0n, 0n],
      b: 50_000_000n,
      lpFeeBps: 200,
      protocolFeeBps: 50,
    }, 0, 1_000_000_000n);

    expect(quote.shares).toBe(0n);
    expect(quote.error).toBe(BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
  });

  it('returns the shared small-budget guidance when nothing fits', () => {
    const quote = quoteBuyForBudgetFromState({
      quantities: [500_000n, 500_000n],
      b: 1_000_000n,
      lpFeeBps: 200,
      protocolFeeBps: 50,
    }, 0, 0n);

    expect(quote.shares).toBe(0n);
    expect(quote.error).toBe(BUY_BUDGET_TOO_SMALL_MESSAGE);
  });
});
