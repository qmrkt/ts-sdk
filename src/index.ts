export const sdkVersion = '0.2.0';

/** Fixed-point scale factor (10^6). All prices and quantities use this as the fractional base. */
export const SCALE = 1_000_000n;
/** Number of Taylor series terms for exp approximation (matches AVM contract). */
export const EXP_TAYLOR_TERMS = 20n;
/** Number of Taylor series terms for ln approximation (matches AVM contract). */
export const LN_TAYLOR_TERMS = 32n;
/** ln(2) in fixed-point at SCALE precision. */
export const LN2_FP = 693_147n;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const BUY_APPROXIMATION_MARGIN = 6n;
export const BUY_BUDGET_TOO_SMALL = 'budget_too_small';
export const AVM_SINGLE_TXN_TRADE_TOO_LARGE = 'trade_too_large_for_single_txn';
export const BUY_BUDGET_TOO_SMALL_MESSAGE = 'Budget is too small to buy any shares at the current price.';
export const BUY_SINGLE_TXN_TOO_LARGE_MESSAGE =
  'This trade is too large to execute safely in one transaction. Try a smaller amount or split it into smaller buys.';
/** Minimum share unit. Shares are denominated in multiples of SCALE (1 share = 10^6 units). */
export const SHARE_GRANULARITY = SCALE;

export class LMSRMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LMSRMathError';
  }
}

export interface LogSumExpResult {
  maxExponentFp: bigint;
  sumExpFp: bigint;
  logSumExpFp: bigint;
  shiftedExpFp: bigint[];
  exponentInputsFp: bigint[];
}

export interface LiquidityValueInput {
  poolBalance: bigint;
  lpSharesTotal: bigint;
  userLpShares: bigint;
  cumulativeFeePerShare?: bigint;
  userFeeSnapshot?: bigint;
  feePerShareScale?: bigint;
}

export interface LiquidityValue {
  poolClaim: bigint;
  accruedFees: bigint;
  totalValue: bigint;
}

export interface BuyQuoteState {
  quantities: bigint[];
  b: bigint;
  lpFeeBps: number;
  protocolFeeBps: number;
}

export interface BuyTradeQuote {
  shares: bigint;
  totalCost: bigint;
  beforePrices: bigint[];
  afterPrices: bigint[];
  errorCode: string | null;
  error: string;
}

export interface LiquidityScalingBaseInput {
  quantities: bigint[];
  b: bigint;
  poolBalance: bigint;
  lpSharesTotal: bigint;
}

export interface DepositLiquidityScalingInput extends LiquidityScalingBaseInput {
  type: 'deposit';
  depositAmount: bigint;
}

export interface WithdrawLiquidityScalingInput extends LiquidityScalingBaseInput {
  type: 'withdraw';
  withdrawShares: bigint;
}

export type LiquidityScalingInput = DepositLiquidityScalingInput | WithdrawLiquidityScalingInput;

export interface DepositLiquidityScalingResult {
  type: 'deposit';
  scaledQuantities: bigint[];
  scaledB: bigint;
  sharesMinted: bigint;
  usdcDelta: bigint;
}

export interface WithdrawLiquidityScalingResult {
  type: 'withdraw';
  scaledQuantities: bigint[];
  scaledB: bigint;
  sharesBurned: bigint;
  usdcReturned: bigint;
}

export type LiquidityScalingResult = DepositLiquidityScalingResult | WithdrawLiquidityScalingResult;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new LMSRMathError(message);
  }
}

function checkUint64(value: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint', `${name} must be bigint`);
  requireCondition(value >= 0n && value <= MAX_UINT64, `${name} out of uint64 range`);
  return value;
}

function checkUint128(value: bigint, name = 'intermediate'): bigint {
  requireCondition(value >= 0n && value <= MAX_UINT128, `${name} out of uint128 range`);
  return value;
}

function checkedAdd(a: bigint, b: bigint, name = 'addition'): bigint {
  return checkUint128(a + b, name);
}

function checkedAddU64(a: bigint, b: bigint, name = 'addition'): bigint {
  return checkUint64(a + b, name);
}

function checkedMul(a: bigint, b: bigint, name = 'multiplication'): bigint {
  requireCondition(a >= 0n && b >= 0n, `${name} expects unsigned operands`);
  return checkUint128(a * b, name);
}

function checkedMulU64(a: bigint, b: bigint, name = 'multiplication'): bigint {
  requireCondition(a >= 0n && b >= 0n, `${name} expects unsigned operands`);
  return checkUint64(a * b, name);
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(denominator > 0n, 'division by zero');
  requireCondition(numerator >= 0n, 'floor division expects unsigned numerator');
  return numerator / denominator;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(denominator > 0n, 'division by zero');
  requireCondition(numerator >= 0n, 'ceil division expects unsigned numerator');
  return (numerator + denominator - 1n) / denominator;
}

function checkedSubU64(a: bigint, b: bigint, name = 'subtraction'): bigint {
  requireCondition(a >= b, `${name} underflow`);
  return a - b;
}

function truncDivSigned(numerator: bigint, denominator: bigint): bigint {
  requireCondition(denominator > 0n, 'division by zero');
  const sign = numerator < 0n ? -1n : 1n;
  return sign * (absBigInt(numerator) / denominator);
}

function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  return floorDiv(checkedMul(a, b), denominator);
}

function mulDivCeil(a: bigint, b: bigint, denominator: bigint): bigint {
  return ceilDiv(checkedMul(a, b), denominator);
}

function fpMulFloor(aFp: bigint, bFp: bigint): bigint {
  return mulDivFloor(aFp, bFp, SCALE);
}

function totalBuyCost(cost: bigint, lpFeeBps: number, protocolFeeBps: number): bigint {
  const lpFee = ceilDiv(cost * BigInt(lpFeeBps), 10_000n);
  const protocolFee = ceilDiv(cost * BigInt(protocolFeeBps), 10_000n);
  return cost + lpFee + protocolFee;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function validateState(quantities: bigint[], b: bigint): void {
  requireCondition(quantities.length >= 2, 'must have at least two outcomes');
  quantities.forEach((quantity, index) => {
    checkUint64(quantity, `q[${index}]`);
  });
  checkUint64(b, 'b');
  requireCondition(b > 0n, 'b must be positive');
}

function cloneBigIntArray(values: bigint[]): bigint[] {
  return values.map((value) => value);
}

function avmFloorDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(denominator > 0n, 'division by zero');
  return checkUint64(numerator / denominator, 'avm floorDiv result');
}

function avmCeilDiv(numerator: bigint, denominator: bigint): bigint {
  requireCondition(denominator > 0n, 'division by zero');
  return checkUint64((numerator + denominator - 1n) / denominator, 'avm ceilDiv result');
}

function avmMulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  return checkUint64(floorDiv(checkedMul(a, b), denominator), 'avm mulDivFloor result');
}

function avmMulDivCeil(a: bigint, b: bigint, denominator: bigint): bigint {
  return checkUint64(ceilDiv(checkedMul(a, b), denominator), 'avm mulDivCeil result');
}

function avmExpTaylorPositiveReduced(xFp: bigint): bigint {
  requireCondition(xFp >= 0n && xFp <= SCALE, 'reduced avm exp input out of range');

  let total = SCALE;
  let term = SCALE;

  for (let k = 1n; k < EXP_TAYLOR_TERMS; k += 1n) {
    term = avmFloorDiv(
      checkedMulU64(term, xFp, `avm exp term mul ${k.toString()}`),
      k * SCALE,
    );
    total = checkedAddU64(total, term, `avm exp total ${k.toString()}`);
  }

  return checkUint64(total, 'avm exp positive result');
}

function avmExpTaylorNegativeReduced(deltaFp: bigint): bigint {
  requireCondition(deltaFp >= 0n && deltaFp <= SCALE, 'reduced avm exp input out of range');

  let total = SCALE;
  let termAbs = SCALE;

  for (let k = 1n; k < EXP_TAYLOR_TERMS; k += 1n) {
    termAbs = avmFloorDiv(
      checkedMulU64(termAbs, deltaFp, `avm exp neg term mul ${k.toString()}`),
      k * SCALE,
    );
    if (termAbs === 0n) {
      continue;
    }
    if ((k % 2n) === 1n) {
      total = total >= termAbs ? total - termAbs : 0n;
    } else {
      total = checkedAddU64(total, termAbs, `avm exp neg total ${k.toString()}`);
    }
  }

  return checkUint64(total, 'avm exp negative result');
}

function avmExpPosFp(xFp: bigint): bigint {
  checkUint64(xFp, 'avm exp_pos input');
  if (xFp === 0n) {
    return SCALE;
  }

  let reduced = xFp;
  let halvings = 0n;
  while (reduced > SCALE) {
    reduced /= 2n;
    halvings += 1n;
  }

  let result = avmExpTaylorPositiveReduced(reduced);
  for (let i = 0n; i < halvings; i += 1n) {
    result = avmFloorDiv(
      checkedMulU64(result, result, `avm exp pos square ${i.toString()}`),
      SCALE,
    );
  }

  return checkUint64(result, 'avm exp_pos result');
}

function avmExpNegFp(deltaFp: bigint): bigint {
  checkUint64(deltaFp, 'avm exp_neg input');
  if (deltaFp === 0n) {
    return SCALE;
  }

  let reduced = deltaFp;
  let halvings = 0n;
  while (reduced > SCALE) {
    reduced /= 2n;
    halvings += 1n;
  }

  let result = avmExpTaylorNegativeReduced(reduced);
  for (let i = 0n; i < halvings; i += 1n) {
    result = avmFloorDiv(
      checkedMulU64(result, result, `avm exp neg square ${i.toString()}`),
      SCALE,
    );
  }

  return checkUint64(result, 'avm exp_neg result');
}

function avmLnFp(xFp: bigint): bigint {
  checkUint64(xFp, 'avm ln input');
  requireCondition(xFp >= SCALE, 'avm ln input must be >= 1');
  if (xFp === SCALE) {
    return 0n;
  }

  let yFp = xFp;
  let powerOfTwo = 0n;
  while (yFp >= 2n * SCALE) {
    yFp = avmCeilDiv(yFp, 2n);
    powerOfTwo = checkedAddU64(powerOfTwo, 1n, 'avm ln powerOfTwo');
  }

  const zNum = checkedMulU64(yFp - SCALE, SCALE, 'avm ln z numerator');
  const zDen = checkedAddU64(yFp, SCALE, 'avm ln z denominator');
  const zFp = avmFloorDiv(zNum, zDen);
  const zSqFp = avmFloorDiv(checkedMulU64(zFp, zFp, 'avm ln zSq'), SCALE);

  let seriesFp = zFp;
  let oddPowerFp = zFp;
  for (let n = 1n; n < LN_TAYLOR_TERMS; n += 1n) {
    oddPowerFp = avmFloorDiv(
      checkedMulU64(oddPowerFp, zSqFp, `avm ln odd power ${n.toString()}`),
      SCALE,
    );
    seriesFp = checkedAddU64(
      seriesFp,
      avmFloorDiv(oddPowerFp, 2n * n + 1n),
      `avm ln series ${n.toString()}`,
    );
  }

  let result = checkedAddU64(
    checkedMulU64(seriesFp, 2n, 'avm ln series scale'),
    checkedMulU64(powerOfTwo, LN2_FP, 'avm ln power scale'),
    'avm ln initial result',
  );

  for (let i = 0n; i < 4n; i += 1n) {
    const estimate = avmExpPosFp(result);
    const ratioFp = avmFloorDiv(
      checkedMulU64(xFp, SCALE, `avm ln newton numerator ${i.toString()}`),
      estimate,
    );
    if (ratioFp === SCALE) {
      break;
    }
    if (ratioFp > SCALE) {
      result = checkedAddU64(result, ratioFp - SCALE, `avm ln newton add ${i.toString()}`);
    } else {
      result = checkedSubU64(result, SCALE - ratioFp, `avm ln newton sub ${i.toString()}`);
    }
  }

  return checkUint64(result, 'avm ln result');
}

function avmExponentFp(quantity: bigint, b: bigint): bigint {
  checkUint64(quantity, 'avm exponent quantity');
  checkUint64(b, 'avm exponent b');
  return avmFloorDiv(checkedMulU64(quantity, SCALE, 'avm exponent numerator'), b);
}

function avmMaxExponentFp(quantities: bigint[], b: bigint): bigint {
  let maxExponentFp = 0n;
  for (const quantity of quantities) {
    const exponent = avmExponentFp(quantity, b);
    if (exponent > maxExponentFp) {
      maxExponentFp = exponent;
    }
  }
  return maxExponentFp;
}

function avmSumShiftedExpFp(quantities: bigint[], b: bigint, sharedMaxFp: bigint): bigint {
  let total = 0n;
  for (const quantity of quantities) {
    const exponent = avmExponentFp(quantity, b);
    total = checkedAddU64(
      total,
      avmExpNegFp(sharedMaxFp - exponent),
      'avm sum shifted exp',
    );
  }
  return total;
}

/**
 * Calculate the cost of buying shares using AVM-matching fixed-point arithmetic.
 * @param quantities - current LMSR inventory state per outcome (fixed-point at SCALE)
 * @param b - liquidity depth parameter (fixed-point at SCALE)
 * @param outcomeIndex - which outcome to buy (0-based)
 * @param shares - number of shares to buy (fixed-point at SCALE)
 * @returns cost in micro-USDC (ceiling-rounded to match AVM contract behavior)
 */
export function calculateAvmBuyCost(quantities: bigint[], b: bigint, outcomeIndex: number, shares: bigint): bigint {
  validateState(quantities, b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < quantities.length, 'outcome index out of range');
  checkUint64(shares, 'shares');

  const updatedQuantities = cloneBigIntArray(quantities);
  updatedQuantities[outcomeIndex] = checkedAddU64(
    updatedQuantities[outcomeIndex]!,
    shares,
    `q[${outcomeIndex}] after avm buy`,
  );

  const maxBefore = avmMaxExponentFp(quantities, b);
  const maxAfter = avmMaxExponentFp(updatedQuantities, b);
  const sharedMaxFp = maxAfter > maxBefore ? maxAfter : maxBefore;
  const sumBeforeFp = avmSumShiftedExpFp(quantities, b, sharedMaxFp);
  const sumAfterFp = avmSumShiftedExpFp(updatedQuantities, b, sharedMaxFp);
  const ratioFp = avmMulDivCeil(sumAfterFp, SCALE, sumBeforeFp);
  requireCondition(ratioFp >= SCALE, 'avm buy ratio must be >= 1');

  const deltaNumerator = checkedMulU64(b, avmLnFp(ratioFp), 'avm buy delta numerator');
  return checkUint64(avmCeilDiv(deltaNumerator, SCALE), 'avm lmsrCostDelta');
}

/** Returns true if the buy can execute within uint64 arithmetic bounds on AVM. */
export function isAvmBuySafe(quantities: bigint[], b: bigint, outcomeIndex: number, shares: bigint): boolean {
  try {
    calculateAvmBuyCost(quantities, b, outcomeIndex, shares);
    return true;
  } catch (error) {
    if (error instanceof LMSRMathError) {
      return false;
    }
    throw error;
  }
}

function expTaylor20Reduced(xFp: bigint): bigint {
  requireCondition(xFp >= -SCALE && xFp <= SCALE, 'reduced exp input out of range');

  let total = SCALE;
  let term = SCALE;

  for (let k = 1n; k < EXP_TAYLOR_TERMS; k += 1n) {
    const product = checkedMul(absBigInt(term), absBigInt(xFp), `exp term mul ${k.toString()}`);
    const nextAbs = product / (k * SCALE);
    if (term === 0n || xFp === 0n) {
      term = 0n;
    } else {
      const sameSign = (term > 0n && xFp > 0n) || (term < 0n && xFp < 0n);
      term = sameSign ? nextAbs : -nextAbs;
    }
    total += term;
  }

  requireCondition(total >= 0n, 'exp approximation underflowed below zero');
  return checkUint64(total, 'expFp result');
}

/** Compute exp(x) in fixed-point. Handles both positive and negative inputs via range reduction and squaring. */
export function expFp(xFp: bigint): bigint {
  requireCondition(typeof xFp === 'bigint', 'xFp must be bigint');
  if (xFp === 0n) {
    return SCALE;
  }

  let reduced = xFp;
  let halvings = 0n;
  while (reduced > SCALE || reduced < -SCALE) {
    reduced = truncDivSigned(reduced, 2n);
    halvings += 1n;
  }

  let result = expTaylor20Reduced(reduced);
  for (let i = 0n; i < halvings; i += 1n) {
    result = fpMulFloor(result, result);
  }

  return checkUint64(result, 'expFp result');
}

/** Compute ln(x) in fixed-point. Input must be >= SCALE (i.e., x >= 1.0). Uses argument reduction and Mercator series. */
export function lnFp(xFp: bigint): bigint {
  requireCondition(typeof xFp === 'bigint', 'xFp must be bigint');
  requireCondition(xFp > 0n, 'ln input must be positive');

  if (xFp === SCALE) {
    return 0n;
  }

  let yFp = xFp;
  let powerOfTwo = 0n;
  while (yFp >= 2n * SCALE) {
    yFp = (yFp + 1n) / 2n;
    powerOfTwo += 1n;
  }
  while (yFp < SCALE) {
    yFp = checkedMul(yFp, 2n, 'ln upscale');
    powerOfTwo -= 1n;
  }

  const numerator = checkedMul(yFp - SCALE, SCALE, 'ln z numerator');
  const denominator = yFp + SCALE;
  const zFp = numerator / denominator;
  const zSqFp = fpMulFloor(zFp, zFp);

  let seriesFp = zFp;
  let oddPowerFp = zFp;
  for (let n = 1n; n < LN_TAYLOR_TERMS; n += 1n) {
    oddPowerFp = fpMulFloor(oddPowerFp, zSqFp);
    seriesFp += oddPowerFp / (2n * n + 1n);
  }

  let result = 2n * seriesFp + powerOfTwo * LN2_FP;

  for (let i = 0n; i < 4n; i += 1n) {
    const expEstimateFp = expFp(result);
    if (expEstimateFp === 0n) {
      break;
    }
    const ratioFp = mulDivFloor(xFp, SCALE, expEstimateFp);
    const deltaFp = ratioFp - SCALE;
    if (deltaFp === 0n) {
      break;
    }
    result += deltaFp;
  }

  return result;
}

/** Compute q_i / b for each outcome, yielding the exponent inputs for LMSR price calculation. */
export function exponentInputsFp(quantities: bigint[], b: bigint): bigint[] {
  validateState(quantities, b);
  return quantities.map((quantity) => mulDivFloor(quantity, SCALE, b));
}

/** Numerically stable log-sum-exp: subtract max exponent before summing, then add it back. */
export function logSumExpFp(exponentsFp: bigint[]): LogSumExpResult {
  requireCondition(exponentsFp.length >= 1, 'need at least one exponent');
  requireCondition(exponentsFp.every((value) => typeof value === 'bigint' && value >= 0n), 'exponents must be non-negative bigints');

  const maxExponentFp = exponentsFp.reduce((max, value) => (value > max ? value : max), exponentsFp[0] ?? 0n);
  const shiftedExpFp: bigint[] = [];
  let sumExpFp = 0n;

  for (const exponentFp of exponentsFp) {
    const shifted = exponentFp - maxExponentFp;
    const expValue = expFp(shifted);
    shiftedExpFp.push(expValue);
    sumExpFp = checkedAdd(sumExpFp, expValue, 'sumExp');
  }

  const logSumExpFpValue = maxExponentFp + lnFp(sumExpFp);
  return {
    maxExponentFp,
    sumExpFp,
    logSumExpFp: logSumExpFpValue,
    shiftedExpFp,
    exponentInputsFp: cloneBigIntArray(exponentsFp),
  };
}

/** Compute log-sum-exp over the LMSR state vector q/b. This is the core of LMSR price and cost calculations. */
export function lmsrLogSumExpFp(quantities: bigint[], b: bigint): LogSumExpResult {
  return logSumExpFp(exponentInputsFp(quantities, b));
}

function sumShiftedExpFp(exponentsFp: bigint[], sharedMaxFp: bigint): bigint {
  let total = 0n;
  for (const exponentFp of exponentsFp) {
    total = checkedAdd(total, expFp(exponentFp - sharedMaxFp), 'shared sumExp');
  }
  return total;
}

function lmsrCostNumerator(quantities: bigint[], b: bigint): bigint {
  const lse = lmsrLogSumExpFp(quantities, b);
  return checkedMul(b, lse.logSumExpFp, 'cost numerator');
}

/** Calculate the LMSR cost function C(q) = b * ln(sum(exp(q_i / b))). */
export function calculateCost(quantities: bigint[], b: bigint): bigint {
  return checkUint64(ceilDiv(lmsrCostNumerator(quantities, b), SCALE), 'lmsrCost');
}

/**
 * Calculate buy cost using high-precision (Decimal-equivalent) arithmetic.
 * Use {@link calculateAvmBuyCost} for AVM-matching fixed-point behavior.
 */
export function calculateBuyCost(quantities: bigint[], b: bigint, outcomeIndex: number, shares: bigint): bigint {
  validateState(quantities, b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < quantities.length, 'outcome index out of range');
  checkUint64(shares, 'shares');

  const updatedQuantities = cloneBigIntArray(quantities);
  updatedQuantities[outcomeIndex] = checkUint64(updatedQuantities[outcomeIndex]! + shares, `q[${outcomeIndex}] after buy`);

  const numeratorBefore = lmsrCostNumerator(quantities, b);
  const numeratorAfter = lmsrCostNumerator(updatedQuantities, b);
  const directDelta = numeratorAfter > numeratorBefore ? numeratorAfter - numeratorBefore : 0n;
  const directQuote = directDelta > 0n ? ceilDiv(directDelta, SCALE) : 0n;
  const paddedDirectQuote = shares > 0n
    ? checkUint64(directQuote + BUY_APPROXIMATION_MARGIN, 'buy padded quote')
    : directQuote;

  const exponentsBefore = exponentInputsFp(quantities, b);
  const exponentsAfter = exponentInputsFp(updatedQuantities, b);
  const maxBefore = exponentsBefore.reduce((max, value) => (value > max ? value : max), exponentsBefore[0] ?? 0n);
  const maxAfter = exponentsAfter.reduce((max, value) => (value > max ? value : max), exponentsAfter[0] ?? 0n);
  const sharedMaxFp = maxAfter > maxBefore ? maxAfter : maxBefore;
  const sumBeforeFp = sumShiftedExpFp(exponentsBefore, sharedMaxFp);
  const sumAfterFp = sumShiftedExpFp(exponentsAfter, sharedMaxFp);

  let ratioQuote: bigint;
  if (sumBeforeFp === 0n) {
    ratioQuote = ceilDiv(numeratorAfter, SCALE) - floorDiv(numeratorBefore, SCALE);
  } else {
    const ratioFp = mulDivCeil(sumAfterFp, SCALE, sumBeforeFp);
    requireCondition(ratioFp >= SCALE, 'buy ratio must be >= 1');
    const deltaNumerator = checkedMul(b, lnFp(ratioFp), 'buy delta numerator');
    ratioQuote = ceilDiv(deltaNumerator, SCALE);
  }

  const result = ratioQuote > paddedDirectQuote ? ratioQuote : paddedDirectQuote;
  return checkUint64(result, 'lmsrCostDelta');
}

function tryTotalBuyCost(state: BuyQuoteState, outcomeIndex: number, shares: bigint): bigint | null {
  try {
    return totalBuyCost(
      calculateBuyCost(state.quantities, state.b, outcomeIndex, shares),
      state.lpFeeBps,
      state.protocolFeeBps,
    );
  } catch (error) {
    if (error instanceof LMSRMathError) {
      return null;
    }
    throw error;
  }
}

/**
 * Binary-search for the maximum whole shares purchasable within a micro-USDC budget.
 * Returns shares in fixed-point units (1 share = SCALE = 10^6).
 */
export function quoteSharesForBudgetFromState(
  state: BuyQuoteState,
  outcomeIndex: number,
  maxCostMicroUsdc: bigint,
): bigint {
  validateState(state.quantities, state.b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < state.quantities.length, 'outcome index out of range');
  checkUint64(maxCostMicroUsdc, 'maxCostMicroUsdc');

  if (maxCostMicroUsdc <= 0n) {
    return 0n;
  }

  const canExecuteWithinBudget = (shares: bigint) => {
    if (shares <= 0n) {
      return true;
    }
    const quotedCost = tryTotalBuyCost(state, outcomeIndex, shares);
    if (quotedCost === null || quotedCost > maxCostMicroUsdc) {
      return false;
    }
    return isAvmBuySafe(state.quantities, state.b, outcomeIndex, shares);
  };

  let lowUnits = 0n;
  let highUnits = 1n;
  while (canExecuteWithinBudget(highUnits * SHARE_GRANULARITY)) {
    lowUnits = highUnits;
    highUnits *= 2n;
    if (highUnits > (1n << 62n)) break;
  }

  while (lowUnits + 1n < highUnits) {
    const midUnits = (lowUnits + highUnits) / 2n;
    if (canExecuteWithinBudget(midUnits * SHARE_GRANULARITY)) {
      lowUnits = midUnits;
    } else {
      highUnits = midUnits;
    }
  }

  return lowUnits * SHARE_GRANULARITY;
}

function zeroQuote(beforePrices: bigint[], errorCode: string, error: string): BuyTradeQuote {
  return {
    shares: 0n,
    totalCost: 0n,
    beforePrices,
    afterPrices: beforePrices,
    errorCode,
    error,
  };
}

/**
 * Quote a buy trade for a specific number of shares. Returns total cost, before/after prices, and error status.
 * @param state - current market state (quantities, b, fee rates)
 * @param outcomeIndex - which outcome to buy
 * @param shares - exact shares to buy (fixed-point at SCALE)
 */
export function quoteBuyForSharesFromState(
  state: BuyQuoteState,
  outcomeIndex: number,
  shares: bigint,
): BuyTradeQuote {
  validateState(state.quantities, state.b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < state.quantities.length, 'outcome index out of range');
  checkUint64(shares, 'shares');

  const beforePrices = calculatePrices(state.quantities, state.b);
  if (shares <= 0n) {
    return zeroQuote(beforePrices, BUY_BUDGET_TOO_SMALL, BUY_BUDGET_TOO_SMALL_MESSAGE);
  }

  if (!isAvmBuySafe(state.quantities, state.b, outcomeIndex, shares)) {
    return zeroQuote(beforePrices, AVM_SINGLE_TXN_TRADE_TOO_LARGE, BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
  }

  const quotedTotalCost = tryTotalBuyCost(state, outcomeIndex, shares);
  if (quotedTotalCost === null) {
    return zeroQuote(beforePrices, AVM_SINGLE_TXN_TRADE_TOO_LARGE, BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
  }

  const updatedQuantities = cloneBigIntArray(state.quantities);
  updatedQuantities[outcomeIndex] = checkUint64(updatedQuantities[outcomeIndex]! + shares, `q[${outcomeIndex}] after buy`);

  return {
    shares,
    totalCost: quotedTotalCost,
    beforePrices,
    afterPrices: calculatePrices(updatedQuantities, state.b),
    errorCode: null,
    error: '',
  };
}

/**
 * Quote a buy trade for a maximum micro-USDC budget. Finds the largest share amount that fits.
 * @param state - current market state (quantities, b, fee rates)
 * @param outcomeIndex - which outcome to buy
 * @param maxCostMicroUsdc - maximum spend in micro-USDC (1 USDC = 10^6)
 */
export function quoteBuyForBudgetFromState(
  state: BuyQuoteState,
  outcomeIndex: number,
  maxCostMicroUsdc: bigint,
): BuyTradeQuote {
  validateState(state.quantities, state.b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < state.quantities.length, 'outcome index out of range');
  checkUint64(maxCostMicroUsdc, 'maxCostMicroUsdc');

  const beforePrices = calculatePrices(state.quantities, state.b);
  const shares = quoteSharesForBudgetFromState(state, outcomeIndex, maxCostMicroUsdc);

  if (shares <= 0n) {
    const oneShareCost = tryTotalBuyCost(state, outcomeIndex, SHARE_GRANULARITY);
    if (
      oneShareCost === null ||
      (!isAvmBuySafe(state.quantities, state.b, outcomeIndex, SHARE_GRANULARITY) && oneShareCost <= maxCostMicroUsdc)
    ) {
      return zeroQuote(beforePrices, AVM_SINGLE_TXN_TRADE_TOO_LARGE, BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
    }
    return zeroQuote(beforePrices, BUY_BUDGET_TOO_SMALL, BUY_BUDGET_TOO_SMALL_MESSAGE);
  }

  const nextSharesQuote = quoteBuyForSharesFromState(state, outcomeIndex, shares + SHARE_GRANULARITY);
  if (nextSharesQuote.errorCode === AVM_SINGLE_TXN_TRADE_TOO_LARGE) {
    const nextCost = tryTotalBuyCost(state, outcomeIndex, shares + SHARE_GRANULARITY);
    if (nextCost === null || nextCost <= maxCostMicroUsdc) {
      return zeroQuote(beforePrices, AVM_SINGLE_TXN_TRADE_TOO_LARGE, BUY_SINGLE_TXN_TOO_LARGE_MESSAGE);
    }
  }

  return quoteBuyForSharesFromState(state, outcomeIndex, shares);
}

/**
 * Calculate the USDC returned when selling shares back to the market maker.
 * @returns micro-USDC returned (floor-rounded)
 */
export function calculateSellReturn(quantities: bigint[], b: bigint, outcomeIndex: number, shares: bigint): bigint {
  validateState(quantities, b);
  requireCondition(outcomeIndex >= 0 && outcomeIndex < quantities.length, 'outcome index out of range');
  checkUint64(shares, 'shares');
  requireCondition(quantities[outcomeIndex]! >= shares, 'cannot sell more shares than outstanding');

  const updatedQuantities = cloneBigIntArray(quantities);
  updatedQuantities[outcomeIndex] -= shares;
  const numeratorBefore = lmsrCostNumerator(quantities, b);
  const numeratorAfter = lmsrCostNumerator(updatedQuantities, b);
  const result = numeratorBefore > numeratorAfter
    ? floorDiv(numeratorBefore - numeratorAfter, SCALE)
    : 0n;
  return checkUint64(result, 'lmsrSellReturn');
}

/**
 * Calculate the current price vector from LMSR state. Prices sum to SCALE (1.0).
 * @returns array of prices in fixed-point at SCALE, one per outcome
 */
export function calculatePrices(quantities: bigint[], b: bigint): bigint[] {
  validateState(quantities, b);
  const lse = lmsrLogSumExpFp(quantities, b);

  const prices: bigint[] = [];
  let allocated = 0n;
  for (let index = 0; index < lse.shiftedExpFp.length; index += 1) {
    const weightFp = lse.shiftedExpFp[index]!;
    let price: bigint;
    if (index === lse.shiftedExpFp.length - 1) {
      price = SCALE - allocated;
    } else {
      price = mulDivFloor(weightFp, SCALE, lse.sumExpFp);
      allocated += price;
    }
    prices.push(checkUint64(price, `price[${index}]`));
  }

  return prices;
}

/**
 * Scale LMSR state for LP deposit or withdrawal. Adjusts quantities and b proportionally.
 * Deposit: new depth = old depth * (pool + deposit) / pool.
 * Withdraw: new depth = old depth * (total - withdrawn) / total.
 */
export function calculateLiquidityScaling(input: LiquidityScalingInput): LiquidityScalingResult {
  validateState(input.quantities, input.b);
  checkUint64(input.poolBalance, 'poolBalance');
  checkUint64(input.lpSharesTotal, 'lpSharesTotal');

  if (input.type === 'deposit') {
    checkUint64(input.depositAmount, 'depositAmount');
    requireCondition(input.poolBalance > 0n, 'poolBalance must be positive');
    const factorNumerator = checkUint64(input.poolBalance + input.depositAmount, 'poolBalance + depositAmount');
    const scaledQuantities = input.quantities.map((quantity, index) =>
      checkUint64(mulDivFloor(quantity, factorNumerator, input.poolBalance), `scaled q[${index}]`),
    );
    const scaledB = checkUint64(mulDivFloor(input.b, factorNumerator, input.poolBalance), 'scaledB');
    const sharesMinted = input.lpSharesTotal === 0n ? input.depositAmount : mulDivFloor(input.lpSharesTotal, input.depositAmount, input.poolBalance);
    return {
      type: 'deposit',
      scaledQuantities,
      scaledB,
      sharesMinted: checkUint64(sharesMinted, 'sharesMinted'),
      usdcDelta: input.depositAmount,
    };
  }

  checkUint64(input.withdrawShares, 'withdrawShares');
  requireCondition(input.lpSharesTotal > 0n, 'lpSharesTotal must be positive');
  requireCondition(input.withdrawShares <= input.lpSharesTotal, 'cannot withdraw more shares than total');
  const remainingShares = input.lpSharesTotal - input.withdrawShares;
  const scaledQuantities = input.quantities.map((quantity, index) =>
    checkUint64(mulDivFloor(quantity, remainingShares, input.lpSharesTotal), `scaled q[${index}]`),
  );
  const scaledB = checkUint64(mulDivFloor(input.b, remainingShares, input.lpSharesTotal), 'scaledB');
  const usdcReturned = mulDivFloor(input.poolBalance, input.withdrawShares, input.lpSharesTotal);
  return {
    type: 'withdraw',
    scaledQuantities,
    scaledB,
    sharesBurned: input.withdrawShares,
    usdcReturned: checkUint64(usdcReturned, 'usdcReturned'),
  };
}

/**
 * Calculate an LP's current value: pro-rata pool claim plus accrued fees from the cumulative fee index.
 * @param input.poolBalance - total non-fee pool balance in micro-USDC
 * @param input.lpSharesTotal - total LP shares outstanding
 * @param input.userLpShares - this LP's share count
 * @param input.cumulativeFeePerShare - current cumulative fee index
 * @param input.userFeeSnapshot - LP's fee index snapshot at entry time
 */
export function calculateLiquidityValue(input: LiquidityValueInput): LiquidityValue {
  checkUint64(input.poolBalance, 'poolBalance');
  checkUint64(input.lpSharesTotal, 'lpSharesTotal');
  checkUint64(input.userLpShares, 'userLpShares');

  const cumulativeFeePerShare = input.cumulativeFeePerShare ?? 0n;
  const userFeeSnapshot = input.userFeeSnapshot ?? 0n;
  const feePerShareScale = input.feePerShareScale ?? SCALE;

  checkUint64(cumulativeFeePerShare, 'cumulativeFeePerShare');
  checkUint64(userFeeSnapshot, 'userFeeSnapshot');
  checkUint64(feePerShareScale, 'feePerShareScale');
  requireCondition(feePerShareScale > 0n, 'feePerShareScale must be positive');
  requireCondition(input.userLpShares <= input.lpSharesTotal || input.lpSharesTotal === 0n, 'userLpShares cannot exceed lpSharesTotal');

  if (input.userLpShares === 0n || input.lpSharesTotal === 0n) {
    return {
      poolClaim: 0n,
      accruedFees: 0n,
      totalValue: 0n,
    };
  }

  requireCondition(cumulativeFeePerShare >= userFeeSnapshot, 'cumulativeFeePerShare cannot be less than userFeeSnapshot');
  const poolClaim = mulDivFloor(input.poolBalance, input.userLpShares, input.lpSharesTotal);
  const accruedFees = mulDivFloor(cumulativeFeePerShare - userFeeSnapshot, input.userLpShares, feePerShareScale);
  return {
    poolClaim: checkUint64(poolClaim, 'poolClaim'),
    accruedFees: checkUint64(accruedFees, 'accruedFees'),
    totalValue: checkUint64(poolClaim + accruedFees, 'totalValue'),
  };
}
