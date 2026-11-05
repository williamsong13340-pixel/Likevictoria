import { approach, bisectIncreasing, clamp } from '../math.ts';
import type { MacroParams } from './params.ts';

type ExchangeRegime = 'float' | 'managed' | 'peg';
type CapitalAccount = 'closed' | 'partial' | 'open';

export interface MacroPolicy {
  readonly exchangeRegime: ExchangeRegime;
  readonly capitalAccount: CapitalAccount;
  readonly independentCentralBank: boolean;
  readonly inflationTarget: number;
  /** Rate chosen by the government; used only when the central bank is not independent. */
  readonly governmentRate: number;
  /** Primary fiscal balance as a share of GDP (surplus > 0). */
  readonly primaryBalance: number;
  /** Share of the fiscal deficit financed by the central bank. */
  readonly monetizedShare: number;
}

/** Monthly inputs supplied by the real economy, politics and the anchor-currency economy. */
export interface MacroInputs {
  readonly outputGap: number;
  readonly potentialGrowth: number;
  /** Annualized inflation impulse from relative import and energy prices. */
  readonly costPush: number;
  readonly currentAccount: number;
  /** Imports as a share of GDP; must be positive. */
  readonly importShare: number;
  readonly politicalRiskPremium: number;
  readonly anchorRate: number;
  readonly anchorInflation: number;
}

export interface MacroState {
  readonly inflation: number;
  readonly adaptiveExpectation: number;
  readonly credibility: number;
  readonly policyRate: number;
  /** Log of domestic currency per unit of anchor currency; rising means depreciation. */
  readonly logExchangeRate: number;
  /** Log real exchange rate relative to equilibrium; positive means undervalued. */
  readonly realExchangeRate: number;
  /** Real depreciation during the previous month; only relative import prices pass through. */
  readonly lastRealDepreciation: number;
  /** Foreign-exchange reserves in months of imports. */
  readonly reserves: number;
  /** Government debt as a share of GDP. */
  readonly debt: number;
  readonly foreignCurrencyDebtShare: number;
  readonly effectiveDebtRate: number;
  readonly priceLevel: number;
}

export interface MacroStep {
  readonly state: MacroState;
  readonly expectedInflation: number;
  readonly realRate: number;
  readonly riskPremium: number;
  readonly capitalFlow: number;
  readonly fiscalDeficit: number;
  readonly monetizedDeficit: number;
  /** Reserves ran out under a peg; the caller must move the country to a floating regime. */
  readonly pegCollapsed: boolean;
}

/** Share of balance-of-payments pressure that moves the exchange rate rather than reserves. */
const EXCHANGE_RATE_ABSORPTION: Readonly<Record<ExchangeRegime, number>> = {
  float: 1,
  managed: 0.5,
  peg: 0,
};

/** How strongly a central bank defending its currency must follow the anchor rate. */
const CAPITAL_OPENNESS: Readonly<Record<CapitalAccount, number>> = {
  closed: 0,
  partial: 0.5,
  open: 1,
};

function capitalMobility(account: CapitalAccount, p: MacroParams): number {
  switch (account) {
    case 'closed':
      return p.capitalMobilityClosed;
    case 'partial':
      return p.capitalMobilityPartial;
    case 'open':
      return p.capitalMobilityOpen;
  }
}

/** Advances the macro block of one country by one month. Pure function. */
export function stepMacro(
  state: MacroState,
  policy: MacroPolicy,
  inputs: MacroInputs,
  p: MacroParams,
): MacroStep {
  const riskPremium =
    inputs.politicalRiskPremium +
    p.debtPremiumSlope * Math.max(0, state.debt - p.safeDebt) ** 2 +
    p.reservePremiumSlope * Math.max(0, 1 - state.reserves / p.safeReserveMonths);

  // Fiscal position: the average rate on the debt follows market rates with the debt maturity.
  const effectiveDebtRate = approach(
    state.effectiveDebtRate,
    state.policyRate + riskPremium + p.termPremium,
    p.debtMaturityMonths,
  );
  const fiscalDeficit = effectiveDebtRate * state.debt - policy.primaryBalance;
  const monetizedDeficit = Math.max(0, fiscalDeficit) * policy.monetizedShare;

  // Credibility and expectations. Money-financed deficits move the nominal anchor itself
  // (quantity theory), and money demand shrinks as inflation rises (Cagan).
  const baseCredibility = policy.independentCentralBank
    ? p.credibilityIndependent
    : p.credibilityGovernment;
  // Credibility is earned by track record: it is judged on remembered inflation, not this month's.
  const inflationMiss = Math.abs(state.adaptiveExpectation - policy.inflationTarget);
  const credibilityTarget = clamp(
    baseCredibility -
      p.inflationMissPenalty * Math.max(0, inflationMiss - p.inflationMissTolerance) -
      p.monetizationCredibilityPenalty * monetizedDeficit,
    p.minCredibility,
    1,
  );
  const credibility = approach(state.credibility, credibilityTarget, p.credibilityHalfLifeMonths);
  const monetaryInflation = Math.min(
    p.maxInflation,
    p.monetizationInflation *
      monetizedDeficit *
      Math.exp(p.moneyFlightSemiElasticity * Math.max(0, state.adaptiveExpectation)),
  );
  const nominalAnchor = policy.inflationTarget + monetaryInflation;
  const expectedInflation =
    credibility * nominalAnchor + (1 - credibility) * state.adaptiveExpectation;

  // Expectations-augmented Phillips curve with cost-push and exchange-rate pass-through.
  const passThrough =
    p.exchangeRatePassThrough * inputs.importShare * state.lastRealDepreciation * 12;
  const inflation = Math.min(
    p.maxInflation,
    expectedInflation + p.phillipsSlope * inputs.outputGap + inputs.costPush + passThrough,
  );
  const adaptiveExpectation = approach(
    state.adaptiveExpectation,
    inflation,
    p.expectationHalfLifeMonths /
      (1 + p.expectationAttention * Math.max(0, state.adaptiveExpectation)),
  );

  // Policy rate. A central bank that holds its currency with an open capital account has to
  // follow the anchor rate: the impossible trinity.
  const absorption = EXCHANGE_RATE_ABSORPTION[policy.exchangeRegime];
  const anchorWeight = (1 - absorption) * CAPITAL_OPENNESS[policy.capitalAccount];
  // The rule sets the real rate: above neutral whenever inflation overshoots (Taylor principle).
  const taylorRate =
    p.neutralRealRate +
    expectedInflation +
    p.ruleInflationWeight * (inflation - policy.inflationTarget) +
    p.ruleGapWeight * inputs.outputGap;
  const ruleRate =
    (1 - anchorWeight) * taylorRate + anchorWeight * (inputs.anchorRate + riskPremium);
  const policyRate = Math.max(
    p.policyRateFloor,
    policy.independentCentralBank
      ? approach(state.policyRate, ruleRate, p.policyRateHalfLifeMonths)
      : policy.governmentRate,
  );

  // Balance of payments. Capital chases the rate differential net of expected depreciation;
  // where the currency floats, investors also expect the real exchange rate to revert to
  // equilibrium, which is what stops the flows (Dornbusch overshooting).
  const mobility = capitalMobility(policy.capitalAccount, p);
  const baseDifferential =
    policyRate -
    inputs.anchorRate -
    riskPremium -
    absorption * (expectedInflation - inputs.anchorInflation);
  const reversion = absorption * p.realExchangeRateReversion;
  // Flows saturate: no country can move more than a bounded share of GDP in a year.
  const flowAt = (realRate: number): number =>
    p.maxCapitalFlow *
    Math.tanh((mobility * (baseDifferential + reversion * realRate)) / p.maxCapitalFlow);
  // Implicit market move r' = r − gain·(CA + flow(r')). The residual is increasing in r',
  // so bisection on the bounded bracket converges for every parameter in range.
  const gain = (absorption * p.floatSensitivity) / 12;
  const marketRealRate = bisectIncreasing(
    (r) => r - state.realExchangeRate + gain * (inputs.currentAccount + flowAt(r)),
    state.realExchangeRate - gain * (inputs.currentAccount + p.maxCapitalFlow),
    state.realExchangeRate - gain * (inputs.currentAccount - p.maxCapitalFlow),
  );
  const capitalFlow = flowAt(marketRealRate);
  const pressure = inputs.currentAccount + capitalFlow;
  const reserves = Math.max(0, state.reserves + ((1 - absorption) * pressure) / inputs.importShare);
  const pegCollapsed = absorption < 1 && reserves < p.pegCrisisReserveMonths;
  const inflationDifferential = (inflation - inputs.anchorInflation) / 12;
  const depreciation =
    marketRealRate -
    state.realExchangeRate +
    absorption * inflationDifferential +
    (pegCollapsed ? p.devaluationSize : 0);

  // Debt ratio: new borrowing, erosion by nominal growth, revaluation of foreign-currency debt.
  const debt = Math.max(
    0,
    state.debt +
      (fiscalDeficit - monetizedDeficit) / 12 -
      (state.debt * (inflation + inputs.potentialGrowth)) / 12 +
      state.foreignCurrencyDebtShare * state.debt * depreciation,
  );

  return {
    state: {
      inflation,
      adaptiveExpectation,
      credibility,
      policyRate,
      logExchangeRate: state.logExchangeRate + depreciation,
      realExchangeRate: state.realExchangeRate + depreciation - inflationDifferential,
      lastRealDepreciation: depreciation - inflationDifferential,
      reserves,
      debt,
      foreignCurrencyDebtShare: state.foreignCurrencyDebtShare,
      effectiveDebtRate,
      priceLevel: state.priceLevel * Math.exp(inflation / 12),
    },
    expectedInflation,
    realRate: policyRate - expectedInflation,
    riskPremium,
    capitalFlow,
    fiscalDeficit,
    monetizedDeficit,
    pegCollapsed,
  };
}
