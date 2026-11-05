import { approach, bisectIncreasing, clamp, retention } from '../math.ts';
import type { MacroParams } from './params.ts';

// Rates (inflation, interest, depreciation) are continuously compounded annual rates, so price
// levels and exchange rates are kept as logs and never overflow. Debt, flows and balances are
// shares of GDP; reserves are months of imports.

/**
 * Policy settings. Laws map onto these numbers through data, so a new legal option (a crawling
 * peg, a currency board, a partly open capital account) needs no code change.
 */
export interface MacroPolicy {
  /** 0 = hard peg, 1 = free float; values in between are managed floats. */
  readonly exchangeRateFlexibility: number;
  /** Capital flow (share of GDP per year) per 1.00 of return differential; near 0 = closed. */
  readonly capitalMobility: number;
  /** True: the central bank follows its rule. False: the government sets the rate. */
  readonly independentCentralBank: boolean;
  /** Credibility a central bank of this legal standing reaches with a clean record (0—1). */
  readonly baseCredibility: number;
  readonly inflationTarget: number;
  /** Rate chosen by the government; used only when the central bank is not independent. */
  readonly governmentRate: number;
  /** Primary fiscal balance (surplus > 0). */
  readonly primaryBalance: number;
  /** Share of the fiscal deficit financed by the central bank. */
  readonly monetizedShare: number;
  /** Share of new borrowing raised in the anchor currency. */
  readonly foreignBorrowingShare: number;
}

/** Monthly inputs supplied by the real economy, politics and the anchor-currency economy. */
export interface MacroInputs {
  readonly outputGap: number;
  readonly potentialGrowth: number;
  /** Inflation impulse from relative import and energy prices. */
  readonly costPush: number;
  /** Current account at the current real exchange rate. */
  readonly currentAccount: number;
  /** Local response of the current account to the log real exchange rate (>= 0). */
  readonly currentAccountSensitivity: number;
  /** Imports as a share of GDP; must be positive. */
  readonly importShare: number;
  readonly politicalRiskPremium: number;
  readonly anchorRate: number;
  readonly anchorInflation: number;
}

/** Conditions a scenario or start date specifies; everything else is derived from them. */
export interface MacroStart {
  readonly inflation: number;
  readonly credibility: number;
  readonly reserves: number;
  readonly domesticDebt: number;
  readonly foreignDebt: number;
}

export interface MacroState {
  readonly inflation: number;
  readonly adaptiveExpectation: number;
  /** Inflation that people expect for the month; the policy rate passes it through at once. */
  readonly expectedInflation: number;
  /** Money printing as people perceive it: the monetized deficit averaged over recent months. */
  readonly perceivedMonetization: number;
  readonly credibility: number;
  readonly policyRate: number;
  /** Log of domestic currency per unit of anchor currency; rising means depreciation. */
  readonly logExchangeRate: number;
  /** Log real exchange rate relative to equilibrium; positive means undervalued. */
  readonly realExchangeRate: number;
  /** Real import-price change that has not yet reached consumer prices (log). */
  readonly pendingPassThrough: number;
  readonly reserves: number;
  /** Domestic-currency debt; never negative, since net assets are held abroad. */
  readonly domesticDebt: number;
  /** Anchor-currency debt valued at the current exchange rate; negative means net assets. */
  readonly foreignDebt: number;
  /** Average rate on domestic debt; it follows market rates as the debt is refinanced. */
  readonly effectiveDebtRate: number;
  readonly logPriceLevel: number;
  /** Months left during which a government that defaulted cannot borrow. */
  readonly marketExclusion: number;
  /** Extra risk premium left over from a default; it fades with a half-life. */
  readonly reputationPremium: number;
}

export interface MacroStep {
  readonly state: MacroState;
  readonly realRate: number;
  readonly riskPremium: number;
  readonly capitalFlow: number;
  /**
   * Pressure that reserves could not cover under a fixed rate, met by exceptional financing
   * (arrears, emergency loans): reserves change = (1 − flexibility)·(CA + capital flow + gap),
   * with the current account at the month's new real exchange rate.
   */
  readonly financingGap: number;
  readonly fiscalDeficit: number;
  readonly monetizedDeficit: number;
  /** Reserves ran out under a peg; the caller must move the country to a floating regime. */
  readonly pegCollapsed: boolean;
  /** Debt crossed the default threshold and was written down. */
  readonly defaulted: boolean;
}

function riskPremiumOf(
  debt: number,
  reserves: number,
  politicalRiskPremium: number,
  p: MacroParams,
): number {
  const raw =
    politicalRiskPremium +
    p.debtPremiumSlope * Math.max(0, debt - p.safeDebt) ** 2 +
    p.reservePremiumSlope * Math.max(0, 1 - reserves / p.safeReserveMonths);
  return p.maxRiskPremium * Math.tanh(raw / p.maxRiskPremium);
}

/**
 * How far a central bank that holds its currency must follow the anchor rate to defend its
 * reserves: the more fixed the currency and the more mobile capital is, the further (trinity).
 */
function anchorWeightOf(policy: MacroPolicy, p: MacroParams): number {
  const defense = p.reserveDefenseWeight * policy.capitalMobility;
  return ((1 - policy.exchangeRateFlexibility) * defense) / (1 + defense);
}

/**
 * The rule's policy stance: the part of the rate that does not move one for one with expected
 * inflation. Its own part is a real rate above neutral when expected inflation overshoots (Taylor
 * principle), with a bounded adjustment; the rest follows the anchor rate plus the premium.
 */
function ruleStanceOf(
  expectedInflation: number,
  riskPremium: number,
  anchorWeight: number,
  policy: MacroPolicy,
  inputs: MacroInputs,
  p: MacroParams,
): number {
  const adjustment =
    p.ruleInflationWeight * (expectedInflation - policy.inflationTarget) +
    p.ruleGapWeight * inputs.outputGap;
  const taylorStance =
    p.neutralRealRate + p.maxRuleAdjustment * Math.tanh(adjustment / p.maxRuleAdjustment);
  return (1 - anchorWeight) * taylorStance + anchorWeight * (inputs.anchorRate + riskPremium);
}

/** Derives a consistent first state from the conditions a scenario specifies. */
export function initialMacroState(
  start: MacroStart,
  policy: MacroPolicy,
  inputs: MacroInputs,
  p: MacroParams,
): MacroState {
  const riskPremium = riskPremiumOf(
    start.domesticDebt + start.foreignDebt,
    start.reserves,
    inputs.politicalRiskPremium,
    p,
  );
  const expectedInflation =
    start.credibility * policy.inflationTarget + (1 - start.credibility) * start.inflation;
  const anchorWeight = anchorWeightOf(policy, p);
  const policyRate = Math.max(
    p.policyRateFloor,
    policy.independentCentralBank
      ? (1 - anchorWeight) * expectedInflation +
          ruleStanceOf(expectedInflation, riskPremium, anchorWeight, policy, inputs, p)
      : policy.governmentRate,
  );
  return {
    inflation: start.inflation,
    adaptiveExpectation: start.inflation,
    expectedInflation,
    perceivedMonetization: 0,
    credibility: start.credibility,
    policyRate,
    logExchangeRate: 0,
    realExchangeRate: 0,
    pendingPassThrough: 0,
    reserves: start.reserves,
    domesticDebt: start.domesticDebt,
    foreignDebt: start.foreignDebt,
    effectiveDebtRate: policyRate + riskPremium + p.termPremium,
    logPriceLevel: 0,
    marketExclusion: 0,
    reputationPremium: 0,
  };
}

/** Advances the macro block of one country by one month. Pure function. */
export function stepMacro(
  state: MacroState,
  policy: MacroPolicy,
  inputs: MacroInputs,
  p: MacroParams,
): MacroStep {
  const flexibility = policy.exchangeRateFlexibility;
  // After a default the government cannot borrow for a while (market exclusion).
  const excluded = state.marketExclusion > 0;
  const riskPremium = riskPremiumOf(
    state.domesticDebt + state.foreignDebt,
    state.reserves,
    inputs.politicalRiskPremium + state.reputationPremium,
    p,
  );

  // Fiscal position. Domestic debt reprices toward market rates as it is refinanced; foreign
  // debt pays the anchor rate plus the premium. During an exclusion nothing is refinanced: the
  // restructured debt pays no premium and its interest is capitalized rather than paid in cash,
  // so only a primary deficit needs financing, and it must be printed.
  const marketDebtRate = approach(
    state.effectiveDebtRate,
    state.policyRate + riskPremium + p.termPremium,
    p.debtRepricingHalfLifeMonths,
  );
  // Net assets are held abroad and earn the anchor rate.
  const foreignDebtRate = inputs.anchorRate + (excluded || state.foreignDebt < 0 ? 0 : riskPremium);
  const monetizedDeficit = excluded
    ? Math.max(0, -policy.primaryBalance)
    : Math.max(
        0,
        marketDebtRate * state.domesticDebt +
          foreignDebtRate * state.foreignDebt -
          policy.primaryBalance,
      ) * policy.monetizedShare;

  // Credibility is earned by track record: it is judged on remembered inflation.
  const inflationMiss = Math.abs(state.adaptiveExpectation - policy.inflationTarget);
  const credibilityTarget = clamp(
    policy.baseCredibility -
      p.inflationMissPenalty * Math.max(0, inflationMiss - p.inflationMissTolerance) -
      p.monetizationCredibilityPenalty * monetizedDeficit,
    p.minCredibility,
    1,
  );
  const credibility = approach(state.credibility, credibilityTarget, p.credibilityHalfLifeMonths);

  // Money-financed deficits move the nominal anchor itself (quantity theory), and money demand
  // shrinks as inflation rises (Cagan), so beyond the seigniorage limit inflation runs away. Money
  // demand never falls below a floor, so only heavy printing can sustain a hyperinflation. People
  // judge printing by its recent average, not by one month's figure.
  const perceivedMonetization = approach(
    state.perceivedMonetization,
    monetizedDeficit,
    p.expectationHalfLifeMonths,
  );
  const moneyDemand = Math.max(
    p.minMoneyDemand,
    Math.exp(-p.moneyFlightSemiElasticity * Math.max(0, state.adaptiveExpectation)),
  );
  const monetaryInflation = Math.min(
    p.maxInflation,
    (p.monetizationInflation * perceivedMonetization) / moneyDemand,
  );
  const expectedInflation =
    credibility * (policy.inflationTarget + monetaryInflation) +
    (1 - credibility) * state.adaptiveExpectation;

  // Expected inflation passes into the rate at once (Fisher effect); only the stance is smoothed,
  // so the real rate never lags far behind a surge or a collapse of inflation.
  const anchorWeight = anchorWeightOf(policy, p);
  const previousStance = state.policyRate - (1 - anchorWeight) * state.expectedInflation;
  const policyRate = Math.max(
    p.policyRateFloor,
    policy.independentCentralBank
      ? (1 - anchorWeight) * expectedInflation +
          approach(
            previousStance,
            ruleStanceOf(expectedInflation, riskPremium, anchorWeight, policy, inputs, p),
            p.policyRateHalfLifeMonths,
          )
      : policy.governmentRate,
  );

  // Balance of payments. Capital chases the return differential net of expected depreciation;
  // where the currency floats, investors also expect the real exchange rate to revert to
  // equilibrium, which is what stops the flows (Dornbusch overshooting). Flows saturate.
  const baseDifferential =
    policyRate -
    inputs.anchorRate -
    riskPremium -
    flexibility * (expectedInflation - inputs.anchorInflation);
  const reversion = (flexibility * Math.LN2) / p.realExchangeRateHalfLifeYears;
  // Foreign capital stays away from a country in default: during the exclusion it can only leave.
  const flowAt = (realRate: number): number => {
    const flow =
      p.maxCapitalFlow *
      Math.tanh(
        (policy.capitalMobility * (baseDifferential + reversion * realRate)) / p.maxCapitalFlow,
      );
    return excluded ? Math.min(0, flow) : flow;
  };
  // The market move solves q' − q = −gain·(CA(q') + flow(q')) with CA linearized around q, so
  // the feedback through trade and through capital flows is implicit and cannot oscillate.
  const q = state.realExchangeRate;
  const sensitivity = Math.max(0, inputs.currentAccountSensitivity);
  const gain = (flexibility * p.floatSensitivity) / 12;
  const scale = gain / (1 + gain * sensitivity);
  const solvedRealRate = bisectIncreasing(
    (r) => r - q + gain * (inputs.currentAccount + sensitivity * (r - q) + flowAt(r)),
    q - scale * (inputs.currentAccount + p.maxCapitalFlow),
    q - scale * (inputs.currentAccount - p.maxCapitalFlow),
  );
  // Real misalignment is bounded (in hyperinflation people dollarize instead); the band only
  // stops further divergence and never forces a jump back into it.
  const band = p.maxRealExchangeRateDeviation;
  const marketRealRate = clamp(solvedRealRate, Math.min(q, -band), Math.max(q, band));
  const capitalFlow = flowAt(marketRealRate);
  const pressure = inputs.currentAccount + sensitivity * (marketRealRate - q) + capitalFlow;
  const desiredReserveChange = ((1 - flexibility) * pressure) / inputs.importShare;
  const pegCollapsed =
    flexibility < 1 && state.reserves + desiredReserveChange <= p.pegCrisisReserveMonths;
  // Reserves cannot go negative; what they cannot cover is met by exceptional financing.
  const reserveChange = Math.max(-state.reserves, desiredReserveChange);
  const financingGap =
    flexibility < 1
      ? ((reserveChange - desiredReserveChange) * inputs.importShare) / (1 - flexibility)
      : 0;

  // Expectations-augmented Phillips curve; real import-price changes reach consumer prices
  // gradually rather than all in one month.
  const passedThrough = state.pendingPassThrough * (1 - retention(p.passThroughHalfLifeMonths));
  const inflation = clamp(
    expectedInflation +
      p.phillipsSlope * inputs.outputGap +
      inputs.costPush +
      p.exchangeRatePassThrough * inputs.importShare * passedThrough * 12,
    p.minInflation,
    p.maxInflation,
  );
  const adaptiveExpectation = approach(
    state.adaptiveExpectation,
    inflation,
    p.expectationHalfLifeMonths /
      (1 + p.expectationAttention * Math.max(0, state.adaptiveExpectation)),
  );
  // The fixed part of the exchange rate does not follow inflation, so the real exchange rate
  // drifts with the inflation differential; a held currency that drifts to the edge of the band
  // is realigned rather than left to drift further.
  const inflationDifferential = (inflation - inputs.anchorInflation) / 12;
  const devalued = marketRealRate + (pegCollapsed ? p.devaluationSize : 0);
  const realExchangeRate = clamp(
    devalued - (1 - flexibility) * inflationDifferential,
    Math.min(devalued, -band),
    Math.max(devalued, band),
  );
  const realDepreciation = realExchangeRate - q;
  const depreciation = realDepreciation + inflationDifferential;

  // Restructured domestic debt is indexed during an exclusion: it accrues inflation plus the
  // anchor's real rate, so neither inflation nor market rates move its real value much.
  const effectiveDebtRate = excluded
    ? inflation + inputs.anchorRate - inputs.anchorInflation
    : marketDebtRate;
  const fiscalDeficit =
    effectiveDebtRate * state.domesticDebt +
    foreignDebtRate * state.foreignDebt -
    policy.primaryBalance;

  // Debt ratios with exact compounding: domestic debt is eroded by inflation, foreign debt is
  // revalued by depreciation instead. Printed money retires domestic debt first. A negative stock
  // repays the other one, and net assets are held abroad, so domestic debt is never negative.
  // Nothing is lost.
  const growth = (inflation + inputs.potentialGrowth) / 12;
  const primaryDeficit = -policy.primaryBalance / 12;
  const foreignShare = excluded ? 0 : policy.foreignBorrowingShare;
  const accruedDomestic =
    state.domesticDebt * Math.exp(effectiveDebtRate / 12 - growth) +
    (1 - foreignShare) * primaryDeficit -
    monetizedDeficit / 12;
  const accruedForeign =
    state.foreignDebt * Math.exp(foreignDebtRate / 12 - growth + depreciation) +
    foreignShare * primaryDeficit;
  const totalDebt = accruedDomestic + accruedForeign;
  const foreignDebt =
    totalDebt < 0 || accruedDomestic < 0 ? totalDebt : Math.max(0, accruedForeign);
  const domesticDebt = totalDebt - foreignDebt;
  // A restructuring writes the debt down below the threshold and shuts the market for a while.
  // Until the market reopens the restructuring is still being settled, so whatever pushes the
  // debt back above its restructured level (a falling currency, say) is written off as well.
  const restructured = p.defaultDebtThreshold * (1 - p.defaultHaircut);
  const defaulted = !excluded && totalDebt > p.defaultDebtThreshold;
  const kept = defaulted || (excluded && totalDebt > restructured) ? restructured / totalDebt : 1;

  return {
    state: {
      inflation,
      adaptiveExpectation,
      expectedInflation,
      perceivedMonetization,
      credibility,
      policyRate,
      logExchangeRate: state.logExchangeRate + depreciation,
      realExchangeRate,
      pendingPassThrough: state.pendingPassThrough - passedThrough + realDepreciation,
      reserves: state.reserves + reserveChange,
      domesticDebt: domesticDebt * kept,
      foreignDebt: foreignDebt * kept,
      effectiveDebtRate,
      logPriceLevel: state.logPriceLevel + inflation / 12,
      marketExclusion: defaulted ? p.marketExclusionMonths : Math.max(0, state.marketExclusion - 1),
      reputationPremium: defaulted
        ? p.defaultReputationPremium
        : state.reputationPremium * retention(p.reputationHalfLifeMonths),
    },
    realRate: policyRate - expectedInflation,
    riskPremium,
    capitalFlow,
    financingGap,
    fiscalDeficit,
    monetizedDeficit,
    pegCollapsed,
    defaulted,
  };
}
