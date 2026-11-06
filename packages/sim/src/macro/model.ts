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
  /**
   * Money printing as people perceive it. They notice it as fast as they notice inflation: within
   * weeks in a hyperinflation, over months when inflation is low.
   */
  readonly perceivedMonetization: number;
  readonly credibility: number;
  readonly policyRate: number;
  /**
   * The government's interest bill averaged over recent months. The central bank prints its share
   * of the budgeted primary deficit plus this average, not of one month's interest.
   */
  readonly interestBill: number;
  /**
   * The part of the policy rate that does not move one for one with expected inflation, before
   * the floor: a floor that binds does not leave the central bank remembering a high real rate.
   */
  readonly policyStance: number;
  /** Log of domestic currency per unit of anchor currency; rising means depreciation. */
  readonly logExchangeRate: number;
  /** Log real exchange rate relative to equilibrium; positive means undervalued. */
  readonly realExchangeRate: number;
  /** Real import-price change that has not yet reached consumer prices (log). */
  readonly pendingPassThrough: number;
  readonly reserves: number;
  /** Domestic-currency debt; never negative, since net assets are held abroad. */
  readonly domesticDebt: number;
  /**
   * The part of the domestic debt left from a restructuring (never more than all of it). It is
   * indexed: it pays the anchor's real rate plus last month's inflation. Nothing is refinanced
   * during the exclusion; after it, the indexed debt is refinanced into market debt.
   */
  readonly indexedDebt: number;
  /** Anchor-currency debt valued at the current exchange rate; negative means net assets. */
  readonly foreignDebt: number;
  /**
   * Average rate on the domestic debt that is not indexed; it follows market rates as that debt
   * is refinanced.
   */
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
  /**
   * The deficit to be financed in cash: interest plus the primary deficit. During a market
   * exclusion interest is capitalized, so only the primary deficit counts.
   */
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

/** Foreign debt pays the anchor rate plus the premium; net assets, held abroad, earn the anchor rate. */
function foreignDebtRateOf(foreignDebt: number, riskPremium: number, anchorRate: number): number {
  return anchorRate + (foreignDebt < 0 ? 0 : riskPremium);
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
  const policyStance = policy.independentCentralBank
    ? ruleStanceOf(expectedInflation, riskPremium, anchorWeight, policy, inputs, p)
    : policy.governmentRate - (1 - anchorWeight) * expectedInflation;
  const policyRate = Math.max(
    p.policyRateFloor,
    (1 - anchorWeight) * expectedInflation + policyStance,
  );
  const effectiveDebtRate = policyRate + riskPremium + p.termPremium;
  return {
    inflation: start.inflation,
    adaptiveExpectation: start.inflation,
    expectedInflation,
    perceivedMonetization: 0,
    credibility: start.credibility,
    policyRate,
    interestBill:
      effectiveDebtRate * start.domesticDebt +
      foreignDebtRateOf(start.foreignDebt, riskPremium, inputs.anchorRate) * start.foreignDebt,
    policyStance,
    logExchangeRate: 0,
    realExchangeRate: 0,
    pendingPassThrough: 0,
    reserves: start.reserves,
    domesticDebt: start.domesticDebt,
    indexedDebt: 0,
    foreignDebt: start.foreignDebt,
    effectiveDebtRate,
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
  // High inflation shortens every horizon: people take in news faster, and lenders lend only short.
  const horizon = 1 / (1 + p.expectationAttention * Math.max(0, state.adaptiveExpectation));
  const riskPremium = riskPremiumOf(
    state.domesticDebt + state.foreignDebt,
    state.reserves,
    inputs.politicalRiskPremium + state.reputationPremium,
    p,
  );

  // The central bank prints its share of the government's financing need: the primary deficit the
  // budget sets, plus the interest bill, which swings with rates and the exchange rate month by
  // month and so is taken at its recent average. During an exclusion the government cannot
  // borrow, and interest is capitalized, so a primary deficit must be printed in full.
  const monetizedDeficit = excluded
    ? Math.max(0, -policy.primaryBalance)
    : Math.max(0, state.interestBill - policy.primaryBalance) * policy.monetizedShare;

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
  // take in printing at the speed at which they take in inflation, so once printing stops in a
  // hyperinflation, the anchor returns to the target within weeks.
  const memoryHalfLife = p.expectationHalfLifeMonths * horizon;
  const perceivedMonetization = approach(
    state.perceivedMonetization,
    monetizedDeficit,
    memoryHalfLife,
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
  const policyStance = policy.independentCentralBank
    ? approach(
        state.policyStance,
        ruleStanceOf(expectedInflation, riskPremium, anchorWeight, policy, inputs, p),
        p.policyRateHalfLifeMonths,
      )
    : policy.governmentRate - (1 - anchorWeight) * expectedInflation;
  const policyRate = Math.max(
    p.policyRateFloor,
    (1 - anchorWeight) * expectedInflation + policyStance,
  );

  // Balance of payments. Capital chases the return differential net of expected depreciation;
  // where the currency floats, investors also expect the real exchange rate to revert to
  // equilibrium, which is what stops the flows (Dornbusch overshooting). Flows saturate.
  // The fixed part of a held currency does not follow inflation, so its real rate drifts; the
  // further it has drifted out of line, the more of the inflation differential investors expect
  // a realignment to pass on (at the edge of the band, all of it). Both depend on the real rate
  // the market settles at, so they enter the implicit solve below.
  const q = state.realExchangeRate;
  const band = p.maxRealExchangeRateDeviation;
  const drift = expectedInflation - inputs.anchorInflation;
  const baseDifferential = policyRate - inputs.anchorRate - riskPremium;
  const reversion = (flexibility * Math.LN2) / p.realExchangeRateHalfLifeYears;
  // Foreign capital stays away from a country in default: during the exclusion it can only leave.
  const flowAt = (realRate: number): number => {
    const outOfLine = Math.min(1, Math.max(0, -realRate * Math.sign(drift)) / band);
    const expectedDepreciation = (flexibility + (1 - flexibility) * outOfLine) * drift;
    const flow =
      p.maxCapitalFlow *
      Math.tanh(
        (policy.capitalMobility *
          (baseDifferential - expectedDepreciation + reversion * realRate)) /
          p.maxCapitalFlow,
      );
    return excluded ? Math.min(0, flow) : flow;
  };
  // The market move solves q' − q = −gain·(CA(q') + flow(q')) with CA linearized around q, so
  // the feedback through trade and through capital flows is implicit and cannot oscillate.
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
  const adaptiveExpectation = approach(state.adaptiveExpectation, inflation, memoryHalfLife);
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

  // Interest at this month's rates. Nothing is refinanced during an exclusion. Market debt reprices
  // toward the market rate at the repricing half-life, which shortens with inflation, since new
  // debt is issued short. Indexed debt left from a restructuring pays the anchor's real rate plus
  // inflation and matures at the repricing half-life of normal times, as its terms were set then;
  // what matures becomes market debt at this month's market rate, so a reopening market reprices
  // it gradually, not all at once. Foreign debt pays the anchor rate plus the premium (none during
  // an exclusion). During an exclusion interest is capitalized rather than paid in cash.
  const marketRate = policyRate + riskPremium + p.termPremium;
  const repricingHalfLife = p.debtRepricingHalfLifeMonths * horizon;
  const matured = excluded ? 0 : 1 - retention(p.debtRepricingHalfLifeMonths);
  const indexedDebt = state.indexedDebt * (1 - matured);
  const marketDebt = state.domesticDebt - indexedDebt;
  const repricedRate = excluded
    ? state.effectiveDebtRate
    : approach(state.effectiveDebtRate, marketRate, repricingHalfLife);
  const marketDebtRate =
    marketDebt > 0
      ? ((state.domesticDebt - state.indexedDebt) * repricedRate +
          (state.indexedDebt - indexedDebt) * marketRate) /
        marketDebt
      : repricedRate;
  const indexedRate = inflation + inputs.anchorRate - inputs.anchorInflation;
  const domesticDebtRate =
    state.domesticDebt > 0
      ? (indexedDebt * indexedRate + marketDebt * marketDebtRate) / state.domesticDebt
      : marketDebtRate;
  const foreignDebtRate = foreignDebtRateOf(
    state.foreignDebt,
    excluded ? 0 : riskPremium,
    inputs.anchorRate,
  );
  const interest = excluded
    ? 0
    : domesticDebtRate * state.domesticDebt + foreignDebtRate * state.foreignDebt;

  // Debt ratios with exact compounding: domestic debt is eroded by inflation, foreign debt is
  // revalued by depreciation instead. Printed money retires domestic debt first. A negative stock
  // repays the other one, and net assets are held abroad, so domestic debt is never negative.
  // Nothing is lost.
  const growth = (inflation + inputs.potentialGrowth) / 12;
  const primaryDeficit = -policy.primaryBalance / 12;
  const foreignShare = excluded ? 0 : policy.foreignBorrowingShare;
  const accruedDomestic =
    state.domesticDebt * Math.exp(domesticDebtRate / 12 - growth) +
    (1 - foreignShare) * primaryDeficit -
    monetizedDeficit / 12;
  const accruedForeign =
    state.foreignDebt * Math.exp(foreignDebtRate / 12 - growth + depreciation) +
    foreignShare * primaryDeficit;
  const totalDebt = accruedDomestic + accruedForeign;
  const foreignDebt =
    totalDebt < 0 || accruedDomestic < 0 ? totalDebt : Math.max(0, accruedForeign);
  const domesticDebt = totalDebt - foreignDebt;
  // Repayments retire market debt first.
  const remainingIndexed = Math.min(
    domesticDebt,
    indexedDebt * Math.exp(indexedRate / 12 - growth),
  );
  // A restructuring writes the debt down below the threshold and shuts the market for a while;
  // the restructured domestic debt is indexed.
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
      interestBill: approach(state.interestBill, interest, p.financingHalfLifeMonths),
      policyStance,
      logExchangeRate: state.logExchangeRate + depreciation,
      realExchangeRate,
      pendingPassThrough: state.pendingPassThrough - passedThrough + realDepreciation,
      reserves: state.reserves + reserveChange,
      domesticDebt: domesticDebt * kept,
      indexedDebt: (defaulted ? domesticDebt : remainingIndexed) * kept,
      foreignDebt: foreignDebt * kept,
      effectiveDebtRate: marketDebtRate,
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
    fiscalDeficit: interest - policy.primaryBalance,
    monetizedDeficit,
    pegCollapsed,
    defaulted,
  };
}
