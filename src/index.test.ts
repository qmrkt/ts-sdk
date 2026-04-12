import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import referenceVectors from '../../contracts/tests/fixtures/lmsr_reference_vectors.json';
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

function runPythonContractMath(payload: unknown) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    "root = Path.cwd().parent",
    'sys.path.insert(0, str(root / "contracts"))',
    'from smart_contracts.lmsr_math import lmsr_cost_delta, lmsr_sell_return, lmsr_prices, lmsr_cost',
    'payload = json.loads(sys.argv[1])',
    'q = payload["q"]',
    'b = payload["b"]',
    'outcome = payload["outcome"]',
    'shares = payload["shares"]',
    'print(json.dumps({',
    '  "buy_cost": lmsr_cost_delta(q, b, outcome, shares),',
    '  "sell_return": lmsr_sell_return(q, b, outcome, shares),',
    '  "prices": lmsr_prices(q, b),',
    '  "cost": lmsr_cost(q, b),',
    '}))',
  ].join('\n');

  const stdout = execFileSync('python3', ['-c', script, JSON.stringify(payload)], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as {
    buy_cost: number;
    sell_return: number;
    prices: number[];
    cost: number;
  };
}

function runPythonBuyCost(payload: { q: number[]; b: number; outcome: number; shares: number }) {
  const script = [
    'import json, sys',
    'from pathlib import Path',
    "root = Path.cwd().parent",
    'sys.path.insert(0, str(root / "contracts"))',
    'from smart_contracts.lmsr_math import lmsr_cost_delta',
    'payload = json.loads(sys.argv[1])',
    'print(lmsr_cost_delta(payload["q"], payload["b"], payload["outcome"], payload["shares"]))',
  ].join('\n');

  const stdout = execFileSync('python3', ['-c', script, JSON.stringify(payload)], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  return BigInt(stdout.trim());
}

describe('sdk scaffold', () => {
  it('exports a version constant', () => {
    expect(sdkVersion).toBe('0.0.0');
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

describe('calculateSellReturn contract expectations', () => {
  const contractCases = [
    { id: 'balanced_partial_sell', q: [500000, 500000], b: 1000000, outcome: 0, shares: 125000 },
    { id: 'skewed_mid_sell', q: [100000, 200000, 350000, 500000, 900000], b: 750000, outcome: 3, shares: 125000 },
    {
      id: 'wide_tail_sell',
      q: [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000, 140000, 150000, 160000],
      b: 1500000,
      outcome: 15,
      shares: 55000,
    },
  ];

  for (const testCase of contractCases) {
    it(`calculateSellReturn matches contract math for ${testCase.id}`, () => {
      const expected = runPythonContractMath(testCase);
      const actual = calculateSellReturn(toBigIntArray(testCase.q), BigInt(testCase.b), testCase.outcome, BigInt(testCase.shares));
      expect(actual).toBe(BigInt(expected.sell_return));
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

describe('cross-validation with contract math implementation', () => {
  const randomCases = [
    { q: [100_000, 0], b: 1_000_000, outcome: 0, shares: 1 },
    { q: [500_000, 700_000], b: 1_100_000, outcome: 1, shares: 125_000 },
    { q: [2_000_000, 1_000_000, 500_000], b: 800_000, outcome: 2, shares: 100_000 },
    { q: [10_000, 20_000, 30_000, 40_000, 50_000], b: 300_000, outcome: 4, shares: 5_000 },
    { q: [90_000, 140_000, 250_000, 350_000, 600_000, 1_200_000], b: 1_500_000, outcome: 5, shares: 200_000 },
  ];

  for (const [index, testCase] of randomCases.entries()) {
    it(`produces identical outputs against contract math case ${index + 1}`, () => {
      const expected = runPythonContractMath(testCase);
      const quantities = toBigIntArray(testCase.q);

      expect(calculateBuyCost(quantities, BigInt(testCase.b), testCase.outcome, BigInt(testCase.shares))).toBe(BigInt(expected.buy_cost));
      expect(calculateSellReturn(quantities, BigInt(testCase.b), testCase.outcome, BigInt(testCase.shares))).toBe(BigInt(expected.sell_return));
      expect(calculatePrices(quantities, BigInt(testCase.b))).toEqual(toBigIntArray(expected.prices));
      expect(calculateCost(quantities, BigInt(testCase.b))).toBe(BigInt(expected.cost));
    });
  }
});

describe('budget-edge contract parity regressions', () => {
  it('matches contract math for the 50M-b $10 budget regression case', () => {
    const regressionCase = {
      q: [0, 0],
      b: 50_000_000,
      outcome: 0,
      shares: 17_915_899,
    };

    const expected = runPythonBuyCost(regressionCase);
    const actual = calculateBuyCost(
      toBigIntArray(regressionCase.q),
      BigInt(regressionCase.b),
      regressionCase.outcome,
      BigInt(regressionCase.shares),
    );

    expect(actual).toBe(expected);
  });

  it('keeps the 50M-b $10 budget regression case inside the AVM buy domain', () => {
    const safeShares = 17_915_899n;
    const expected = runPythonBuyCost({
      q: [0, 0],
      b: 50_000_000,
      outcome: 0,
      shares: Number(safeShares),
    });

    expect(isAvmBuySafe([0n, 0n], 50_000_000n, 0, safeShares)).toBe(true);
    expect(calculateAvmBuyCost([0n, 0n], 50_000_000n, 0, safeShares)).toBe(expected);
  });

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
