// Tests for the macro block, in four groups:
//  1. regularities at the calibrated parameters: controlled comparisons where two runs differ in one
//     mechanism, and single-run checks where the regularity is a pattern within one run;
//  2. the same regularities across a calibrated neighbourhood (every parameter within ±20%);
//  3. mechanism-level checks, each of which fails if its mechanism is removed;
//  4. numerical safety over every documented range of parameters and policies.
// The documented ranges promise numerical safety; the economic regularities are promised for the
// calibrated neighbourhood, where they are tested.
import { describe, expect, it } from 'vitest';
import {
  currentAccountAt,
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  stepDemandProxy,
  type DemandProxyParams,
} from '../src/macro/demand-proxy.ts';
import {
  initialMacroState,
  stepMacro,
  type MacroInputs,
  type MacroPolicy,
  type MacroState,
  type MacroStep,
} from '../src/macro/model.ts';
import { DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, type MacroParams } from '../src/macro/params.ts';
import {
  POLICY_LIMITS,
  runScenario,
  type MacroScenario,
  type MonthRecord,
} from '../src/macro/sandbox.ts';
import { MACRO_SCENARIOS } from '../src/macro/scenarios.ts';
import { OSCILLATION_CORNERS } from './oscillation-corners.ts';
import type { ParamSpecs } from '../src/params.ts';

const P = DEFAULT_MACRO_PARAMS;
const D = DEFAULT_DEMAND_PROXY_PARAMS;

function scenario(id: string): MacroScenario {
  const found = MACRO_SCENARIOS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`missing scenario ${id}`);
  return found;
}

function withPolicy(base: MacroScenario, policy: Partial<MacroPolicy>): MacroScenario {
  return { ...base, policy: { ...base.policy, ...policy } };
}

function at(records: readonly MonthRecord[], month: number): MonthRecord {
  const record = records[month];
  if (record === undefined) throw new Error(`no record for month ${String(month)}`);
  return record;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Output lost to recessions from `from` onward, in GDP-years. */
const outputLoss = (records: readonly MonthRecord[], from: number): number =>
  -records.slice(from).reduce((sum, r) => sum + Math.min(0, r.outputGap), 0) / 12;

/** Months in which a run defaults. */
const defaultMonths = (records: readonly MonthRecord[]): number[] =>
  records.flatMap((r) => (r.defaulted ? [r.month] : []));

/** Deterministic generator for the property tests. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type Sampling = 'uniform' | 'endpoints' | 'mixed';

function sampleParams<T extends { readonly [K in keyof T]: number }>(
  specs: ParamSpecs<T>,
  random: () => number,
  sampling: Sampling,
): T {
  const sampled: Record<string, number> = {};
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key];
    const draw =
      sampling === 'uniform'
        ? 2
        : sampling === 'endpoints'
          ? Math.floor(random() * 2)
          : Math.floor(random() * 3);
    sampled[key] =
      draw === 0 ? spec.min : draw === 1 ? spec.max : spec.min + (spec.max - spec.min) * random();
  }
  return sampled as T;
}

/** Any policy the documented limits allow. */
const samplePolicy = (random: () => number): MacroPolicy => ({
  ...sampleParams(POLICY_LIMITS, random, 'uniform'),
  independentCentralBank: random() < 0.5,
});

/** Every parameter scaled by a random factor in [0.8, 1.2] around its default, kept in range. */
function nearDefaults<T extends { readonly [K in keyof T]: number }>(
  defaults: T,
  specs: ParamSpecs<T>,
  random: () => number,
): T {
  const sampled: Record<string, number> = {};
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key];
    sampled[key] = Math.min(spec.max, Math.max(spec.min, defaults[key] * (0.8 + 0.4 * random())));
  }
  return sampled as T;
}

/** A scenario that is an exact steady state for the given parameters. */
function steadyState(
  macro: MacroParams,
  target: number,
): { scenario: MacroScenario; macro: MacroParams } {
  const base = scenario('baseline');
  const rate = target + macro.neutralRealRate;
  return {
    macro: { ...macro, policyRateFloor: Math.min(macro.policyRateFloor, rate) },
    scenario: {
      ...base,
      start: {
        inflation: target,
        credibility: base.policy.baseCredibility,
        reserves: 12,
        domesticDebt: Math.min(0.4, macro.safeDebt),
        foreignDebt: 0,
      },
      policy: { ...base.policy, inflationTarget: target, primaryBalance: 0 },
      // Uncovered interest parity holds and the debt ratio is constant.
      anchorRate: rate - (target - base.anchorInflation),
      potentialGrowth: macro.neutralRealRate + macro.termPremium,
    },
  };
}

/**
 * The property test's sample for one seed: every scenario, with its own policy and with a random
 * policy changed once midway, for parameter sets drawn uniformly, at the endpoints and mixed.
 */
function* propertyCases(seed: number): Generator<{
  readonly where: string;
  readonly plan: MacroScenario;
  readonly macro: MacroParams;
  readonly demand: DemandProxyParams;
}> {
  const random = lcg(seed);
  for (const sampling of ['uniform', 'endpoints', 'mixed'] as const) {
    for (let i = 0; i < 15; i++) {
      const macro = sampleParams(MACRO_PARAM_SPECS, random, sampling);
      const demand = sampleParams(DEMAND_PROXY_PARAM_SPECS, random, sampling);
      for (const base of MACRO_SCENARIOS) {
        const plans: MacroScenario[] = [
          { ...base, months: 1200 },
          {
            ...base,
            months: 1200,
            policy: samplePolicy(random),
            policyChanges: [
              ...base.policyChanges,
              { month: 300 + Math.floor(random() * 600), policy: samplePolicy(random) },
            ],
          },
        ];
        for (const [k, plan] of plans.entries()) {
          const where = `${base.id}, ${sampling} parameter set ${String(i)}, plan ${String(k)}`;
          yield { where, plan, macro, demand };
        }
      }
    }
  }
}

/**
 * Every month finite and within its bounds, and at most one reversal every three months on
 * average, over a decade and over any three years, so a burst of oscillation cannot hide in an
 * otherwise calm decade.
 */
function expectSafe(
  records: readonly MonthRecord[],
  macro: MacroParams,
  demand: DemandProxyParams,
  where: string,
): void {
  const broken = records.find(
    (r) =>
      Object.values(r).some((v) => typeof v === 'number' && !Number.isFinite(v)) ||
      Math.abs(r.capitalFlow) > macro.maxCapitalFlow + 1e-9 ||
      Math.abs(r.outputGap) > demand.maxOutputGap + 1e-9 ||
      Math.abs(r.currentAccount) > demand.maxCurrentAccount + 1e-9 ||
      r.inflation < macro.minInflation - 1e-9 ||
      r.inflation > macro.maxInflation + 1e-9 ||
      r.reserves < 0 ||
      r.financingGap < 0 ||
      r.debt > macro.defaultDebtThreshold + 1e-9,
  );
  expect(broken, where).toBeUndefined();
  expect(maxReversals(records, 121), where).toBeLessThanOrEqual(40);
  expect(maxReversals(records, 37), where).toBeLessThanOrEqual(12);
}

/**
 * The largest number of month-to-month inflation reversals larger than one percentage point in
 * any window of the given length. A period-2 or period-3 cycle reverses almost every month.
 */
function maxReversals(records: readonly MonthRecord[], months: number): number {
  const reversal = records.map((r, k) => {
    const previous = records[k - 1];
    const older = records[k - 2];
    if (previous === undefined || older === undefined) return 0;
    const change = r.inflation - previous.inflation;
    const before = previous.inflation - older.inflation;
    return change * before < 0 && Math.abs(change) > 0.01 ? 1 : 0;
  });
  let inWindow = 0;
  let most = 0;
  for (const [k, flag] of reversal.entries()) {
    inWindow += flag - (reversal[k - months] ?? 0);
    most = Math.max(most, inWindow);
  }
  return most;
}

/** Inputs of a quiet month: no gap, no shocks, balanced external accounts. */
const QUIET_INPUTS: MacroInputs = {
  outputGap: 0,
  potentialGrowth: 0.03,
  costPush: 0,
  currentAccount: 0,
  currentAccountSensitivity: 0,
  importShare: 0.25,
  politicalRiskPremium: 0,
  anchorRate: 0.05,
  anchorInflation: 0.03,
};
const BASE_POLICY = scenario('baseline').policy;
const PEG: MacroPolicy = {
  ...BASE_POLICY,
  exchangeRateFlexibility: 0,
  independentCentralBank: false,
};
const QUIET_STATE: MacroState = initialMacroState(
  { inflation: 0.03, credibility: 0.8, reserves: 6, domesticDebt: 0.5, foreignDebt: 0 },
  BASE_POLICY,
  QUIET_INPUTS,
  P,
);

/**
 * A year's interest at this month's pace on foreign debt (or earnings on net assets), as a share
 * of the month's GDP: how the model measures interest, consistent with exact compounding.
 */
function foreignInterest(step: MacroStep, foreignDebt: number, rate: number): number {
  const growth = (step.state.inflation + QUIET_INPUTS.potentialGrowth) / 12;
  return 12 * foreignDebt * Math.expm1(rate / 12) * Math.exp(step.state.logExchangeRate - growth);
}
const RESTRUCTURED_DEBT = P.defaultDebtThreshold * (1 - P.defaultHaircut);

/** The regularities, each as a predicate over parameter sets (used at defaults and nearby). */
const REGULARITIES: Readonly<Record<string, (m: MacroParams, d: DemandProxyParams) => boolean>> = {
  'Phillips curve and Taylor rule': (m, d) => {
    const base = at(runScenario(scenario('baseline'), m, d), 35);
    const boom = at(runScenario(scenario('demand-boom'), m, d), 35);
    return (
      boom.outputGap > 0 && boom.inflation > base.inflation && boom.policyRate > base.policyRate
    );
  },
  'twin deficits, through imports even when the exchange rate cannot move': (m, d) => {
    const base = at(runScenario(scenario('baseline'), m, d), 35);
    const boom = at(runScenario(scenario('demand-boom'), m, d), 35);
    const pegged = withPolicy(scenario('demand-boom'), {
      exchangeRateFlexibility: 0,
      capitalMobility: 0.2,
    });
    const noPriceEffect = { ...d, tradeElasticity: 0 };
    const withImports = at(runScenario(pegged, m, noPriceEffect), 35);
    const withoutImports = at(
      runScenario(pegged, m, { ...noPriceEffect, importPropensity: 0 }),
      35,
    );
    return (
      boom.currentAccount < base.currentAccount &&
      withImports.currentAccount < 0 &&
      Math.abs(withoutImports.currentAccount) < 1e-9
    );
  },
  stagflation: (m, d) =>
    runScenario(scenario('oil-shock-anchored'), m, d)
      .slice(6, 12)
      .every((r) => r.inflation > 0.03 && r.outputGap < 0),
  'credibility makes supply shocks transitory': (m, d) => {
    const shock = scenario('oil-shock-anchored');
    const doubted = {
      ...withPolicy(shock, { baseCredibility: 0.3 }),
      start: { ...shock.start, credibility: 0.3 },
    };
    return (
      at(runScenario(doubted, m, d), 47).inflation > at(runScenario(shock, m, d), 47).inflation
    );
  },
  'Taylor principle at equal credibility': (m, d) => {
    const fixed = scenario('oil-shock-unanchored');
    const fixedRate = at(runScenario(fixed, m, d), 95);
    const rule = at(runScenario(withPolicy(fixed, { independentCentralBank: true }), m, d), 95);
    return Math.abs(fixedRate.inflation - 0.03) > Math.abs(rule.inflation - 0.03);
  },
  'disinflation costs more per point when credibility is low': (m, d) => {
    const plan = {
      ...withPolicy(scenario('disinflation'), {
        independentCentralBank: true,
        baseCredibility: 0.8,
      }),
      policyChanges: [],
    };
    const costPerPoint = (credibility: number): number => {
      const r = runScenario({ ...plan, start: { ...plan.start, credibility } }, m, d);
      return outputLoss(r, 0) / (plan.start.inflation - at(r, 119).inflation);
    };
    return costPerPoint(0.05) > costPerPoint(0.6) && costPerPoint(0.6) > costPerPoint(0.8);
  },
  'quantity theory: more printing, a higher but stable plateau': (m, d) => {
    // A plateau neither climbs nor collapses: over five years inflation rises by less than a
    // point and stays above half the plateau (it settles slowly as the debt is eroded).
    const plateau = (primaryBalance: number): { level: number; stable: boolean } => {
      const r = runScenario(withPolicy(scenario('fiscal-dominance'), { primaryBalance }), m, d);
      const level = mean(r.slice(120, 180).map((x) => x.inflation));
      const end = at(r, 179).inflation;
      return { level, stable: end - at(r, 119).inflation < 0.01 && end > 0.5 * level };
    };
    const small = plateau(-0.005);
    const medium = plateau(-0.01);
    const large = plateau(-0.015);
    return (
      small.level < medium.level &&
      medium.level < large.level &&
      [small, medium, large].every((x) => x.stable)
    );
  },
  'seigniorage limit: runaway inflation and collapsing credibility': (m, d) => {
    const r = runScenario({ ...scenario('hyperinflation'), months: 120 }, m, d);
    // Inflation keeps accelerating until it nears its ceiling: the cap, or the rate at which
    // money demand has fallen to its floor.
    const ceiling = (month: number): number =>
      Math.min(
        m.maxInflation,
        (m.monetizationInflation * at(r, month).monetizedDeficit) / m.minMoneyDemand,
      );
    const accelerates = (from: number, to: number): boolean =>
      at(r, to).inflation > at(r, from).inflation || at(r, from).inflation > 0.9 * ceiling(from);
    return (
      accelerates(23, 47) &&
      accelerates(47, 71) &&
      accelerates(71, 95) &&
      at(r, 119).inflation > 1 &&
      at(r, 47).credibility < 0.2
    );
  },
  'stopping the printing ends a hyperinflation': (m, d) => {
    const plan = { ...scenario('hyperinflation'), months: 240 };
    const stop = runScenario(plan, m, d).findIndex((x) => x.inflation > 1.5); // ~350% a year
    if (stop < 0) return false;
    const reform = { primaryBalance: 0, monetizedShare: 0 };
    const length = { ...plan, months: stop + 25 };
    const r = runScenario(
      { ...length, policyChanges: [{ month: stop + 1, policy: reform }] },
      m,
      d,
    );
    const printing = runScenario(length, m, d);
    // Inflation peaks within a few months (money demand recovers with a lag), then falls every
    // month; two years on it is a small fraction of where printing would have taken it.
    const after = r.slice(stop, stop + 25).map((x) => x.inflation);
    const peak = Math.max(...after);
    const peakMonth = after.indexOf(peak);
    return (
      peakMonth <= 6 &&
      after.slice(peakMonth + 1).every((x, k) => x <= (after[peakMonth + k] ?? peak)) &&
      at(r, stop + 24).inflation < 0.5 * at(printing, stop + 24).inflation
    );
  },
  'inflation tax falls on domestic debt only': (m, d) => {
    const plan = scenario('hyperinflation');
    const end = at(runScenario(plan, m, d), 59);
    // Within five years inflation wipes out most of the domestic debt, while the foreign debt
    // grows.
    return (
      end.debt - end.foreignDebt < 0.5 * plan.start.domesticDebt &&
      end.foreignDebt > plan.start.foreignDebt
    );
  },
  'trinity: capital mobility drains a peg': (m, d) => {
    const reserves = (capitalMobility: number): number =>
      at(runScenario(withPolicy(scenario('peg-open-capital'), { capitalMobility }), m, d), 11)
        .reserves;
    return reserves(8) < reserves(2) && reserves(2) < reserves(0.2);
  },
  'trinity: flexibility moves the burden from reserves to the currency': (m, d) => {
    const [peg, managed, float] = [0, 0.5, 1].map((exchangeRateFlexibility) =>
      at(
        runScenario(withPolicy(scenario('peg-open-capital'), { exchangeRateFlexibility }), m, d),
        5,
      ),
    );
    if (peg === undefined || managed === undefined || float === undefined) return false;
    return (
      peg.reserves < managed.reserves &&
      managed.reserves < float.reserves &&
      peg.logExchangeRate < managed.logExchangeRate &&
      peg.logExchangeRate < float.logExchangeRate
    );
  },
  'trinity: a defended peg cannot cut rates in a recession': (m, d) => {
    const lowest = (r: readonly MonthRecord[]): number =>
      Math.min(...r.slice(6, 24).map((x) => x.policyRate));
    const recession = scenario('peg-defended');
    return (
      lowest(runScenario(withPolicy(recession, { exchangeRateFlexibility: 1 }), m, d)) <
      lowest(runScenario(recession, m, d))
    );
  },
  'currency mismatch': (m, d) => {
    const r = runScenario(scenario('peg-open-capital'), m, d);
    const collapse = r.findIndex((x) => x.pegCollapsed);
    return (
      collapse > 0 &&
      at(r, collapse).foreignDebt >
        at(r, collapse - 1).foreignDebt * Math.exp(0.9 * m.devaluationSize)
    );
  },
  'a debt spiral ends in default, and the next one waits until well after the market reopens': (
    m,
    d,
  ) => {
    const defaults = defaultMonths(runScenario({ ...scenario('debt-spiral'), months: 600 }, m, d));
    return (
      defaults.length > 0 &&
      defaults.every(
        (month, k) => k === 0 || month - (defaults[k - 1] ?? 0) > m.marketExclusionMonths + 12,
      )
    );
  },
  'sovereign risk spills into private borrowing': (m, d) => {
    // Two runs that differ only in political risk: before the default, the riskier economy is
    // deeper in recession, by at least a tenth of the premium.
    const plan = scenario('debt-spiral');
    const risky = runScenario(plan, m, d);
    const first = risky.findIndex((x) => x.defaulted);
    const safer = runScenario({ ...plan, politicalRiskPremium: 0 }, m, d);
    return (
      first > 0 &&
      at(safer, first - 1).outputGap - at(risky, first - 1).outputGap >
        0.1 * plan.politicalRiskPremium
    );
  },
  'inflation destroys output': (m, d) => {
    const plan = scenario('hyperinflation');
    const costly = at(runScenario(plan, m, d), 59).outputGap;
    const cheap = at(
      runScenario(plan, m, {
        ...d,
        inflationOutputCost: DEMAND_PROXY_PARAM_SPECS.inflationOutputCost.min,
      }),
      59,
    ).outputGap;
    return costly < cheap;
  },
};

describe('macro block: regularities at the calibrated parameters', () => {
  for (const [name, holds] of Object.entries(REGULARITIES)) {
    it(name, () => {
      expect(holds(P, D)).toBe(true);
    });
  }

  it('magnitudes: a fiscal boom and a credible central bank move inflation by plausible amounts', () => {
    const boom = at(runScenario(scenario('demand-boom')), 35);
    expect(boom.outputGap).toBeGreaterThan(0.01);
    expect(boom.inflation).toBeGreaterThan(0.035);
    const credible = at(runScenario(scenario('oil-shock-anchored')), 47);
    expect(Math.abs(credible.inflation - 0.03)).toBeLessThan(0.005);
  });

  it('Fisher effect and relative PPP: a higher target means higher rates and steady depreciation', () => {
    const steady = steadyState(P, 0.08);
    const end = at(runScenario(steady.scenario, steady.macro), 119);
    expect(end.inflation).toBeCloseTo(0.08, 9);
    expect(end.policyRate).toBeCloseTo(0.08 + P.neutralRealRate, 9);
    expect(end.logExchangeRate).toBeCloseTo(10 * (0.08 - 0.03), 6);
  });
});

describe('macro block: regularities across the calibrated neighbourhood', () => {
  it('every regularity holds for parameters within ±20% of the calibration', () => {
    const random = lcg(31);
    for (let i = 0; i < 25; i++) {
      const macro = nearDefaults(P, MACRO_PARAM_SPECS, random);
      const demand = nearDefaults(D, DEMAND_PROXY_PARAM_SPECS, random);
      for (const [name, holds] of Object.entries(REGULARITIES)) {
        expect(holds(macro, demand), `${name}, parameter set ${String(i)}`).toBe(true);
      }
    }
  });
});

describe('macro block: mechanisms', () => {
  it('the rule reacts to expected inflation, not to a one-month import-price spike', () => {
    const spike = stepMacro(
      { ...QUIET_STATE, pendingPassThrough: 0.3 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    const calm = stepMacro(QUIET_STATE, BASE_POLICY, QUIET_INPUTS, P);
    expect(spike.state.inflation - calm.state.inflation).toBeGreaterThan(0.05);
    expect(Math.abs(spike.state.policyRate - calm.state.policyRate)).toBeLessThan(0.005);
    // Nor to last month's realized inflation, when expectations stay put.
    const hotLastMonth = stepMacro(
      { ...QUIET_STATE, inflation: 0.15 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(hotLastMonth.state.policyRate).toBeCloseTo(calm.state.policyRate, 12);
  });

  it('expected inflation passes into the policy rate at once; only the stance is smoothed', () => {
    const calm = stepMacro(QUIET_STATE, BASE_POLICY, QUIET_INPUTS, P);
    const worried = stepMacro(
      { ...QUIET_STATE, adaptiveExpectation: 0.13 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    const moreExpected = worried.state.expectedInflation - calm.state.expectedInflation;
    const higherRate = worried.state.policyRate - calm.state.policyRate;
    expect(moreExpected).toBeGreaterThan(0.01);
    expect(higherRate).toBeGreaterThanOrEqual(moreExpected);
    expect(higherRate).toBeLessThan(moreExpected + P.maxRuleAdjustment);
  });

  it('the rule moves the real rate at most maxRuleAdjustment away from neutral', () => {
    // 100% inflation at minimal credibility, held there by a cost push that exactly sustains it,
    // so expectations stay put and the rate settles at the rule's own target. Capital is closed,
    // so the exchange rate stays put and import prices add nothing.
    const closed = { ...BASE_POLICY, capitalMobility: 0 };
    const runaway: MacroInputs = {
      ...QUIET_INPUTS,
      costPush: P.minCredibility * (1 - BASE_POLICY.inflationTarget),
    };
    let state: MacroState = {
      ...QUIET_STATE,
      credibility: P.minCredibility,
      adaptiveExpectation: 1,
    };
    for (let month = 0; month < 60; month++) {
      state = stepMacro(state, closed, runaway, P).state;
    }
    const step = stepMacro(state, closed, runaway, P);
    expect(step.state.inflation).toBeCloseTo(1, 9);
    expect(step.realRate).toBeLessThanOrEqual(P.neutralRealRate + P.maxRuleAdjustment);
    expect(step.realRate).toBeGreaterThan(P.neutralRealRate + 0.9 * P.maxRuleAdjustment);
  });

  it('the policy rate never goes below its floor, even in a deflation', () => {
    let state: MacroState = { ...QUIET_STATE, credibility: P.minCredibility };
    const deflation = { ...QUIET_INPUTS, costPush: -0.1 };
    const rates: number[] = [];
    for (let month = 0; month < 36; month++) {
      state = stepMacro(state, BASE_POLICY, deflation, P).state;
      rates.push(state.policyRate);
    }
    expect(state.expectedInflation + P.neutralRealRate).toBeLessThan(P.policyRateFloor - 0.02);
    expect(Math.min(...rates)).toBe(P.policyRateFloor);
  });

  it('credibility is judged on the remembered record, and small misses are tolerated', () => {
    const half = { ...QUIET_STATE, credibility: 0.5 };
    const goodMonthBadRecord = stepMacro(
      { ...half, adaptiveExpectation: 0.15 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    const badMonthGoodRecord = stepMacro(
      { ...half, inflation: 0.15 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(goodMonthBadRecord.state.credibility).toBeLessThan(0.5);
    expect(badMonthGoodRecord.state.credibility).toBeGreaterThan(0.5);
    // QUIET_STATE sits at its base credibility; a miss inside the tolerance leaves it there.
    const nearMiss = stepMacro(
      { ...QUIET_STATE, adaptiveExpectation: 0.03 + 0.5 * P.inflationMissTolerance },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(nearMiss.state.credibility).toBe(BASE_POLICY.baseCredibility);
  });

  it('printing money costs credibility', () => {
    const deficit = { ...BASE_POLICY, primaryBalance: -0.05 };
    const printed = stepMacro(QUIET_STATE, { ...deficit, monetizedShare: 1 }, QUIET_INPUTS, P);
    const borrowed = stepMacro(QUIET_STATE, deficit, QUIET_INPUTS, P);
    expect(printed.state.credibility).toBeLessThan(borrowed.state.credibility);
    // Printing for interest alone costs it too.
    const indebted = { ...QUIET_STATE, interestBill: 0.05 };
    const balanced = { ...BASE_POLICY, primaryBalance: 0 };
    const forInterest = stepMacro(indebted, { ...balanced, monetizedShare: 1 }, QUIET_INPUTS, P);
    const paid = stepMacro(indebted, balanced, QUIET_INPUTS, P);
    expect(forInterest.state.credibility).toBeLessThan(paid.state.credibility);
  });

  it('a central bank that prints gains no credibility from inflation that happens to sit at its target', () => {
    // Printing itself costs no credibility here, and remembered inflation sits at the target: only
    // the inflation that believers expect from the printing holds credibility back.
    const params = { ...P, monetizationCredibilityPenalty: 0 };
    const deficit = { ...BASE_POLICY, primaryBalance: -0.3 };
    const printed = stepMacro(QUIET_STATE, { ...deficit, monetizedShare: 1 }, QUIET_INPUTS, params);
    const borrowed = stepMacro(QUIET_STATE, deficit, QUIET_INPUTS, params);
    expect(borrowed.state.credibility).toBe(BASE_POLICY.baseCredibility);
    expect(printed.state.credibility).toBeLessThan(BASE_POLICY.baseCredibility);
    // Nor from inflation that matches what its printing implies but misses the target. Money
    // demand does not fall here, and the printing people perceive is already the plan.
    const steady = { ...params, moneyFlightSemiElasticity: 0 };
    const matched = {
      ...QUIET_STATE,
      interestBill: 0,
      perceivedMonetization: 0.05,
      adaptiveExpectation: BASE_POLICY.inflationTarget + steady.monetizationInflation * 0.05,
    };
    const printer = { ...BASE_POLICY, primaryBalance: -0.05, monetizedShare: 1 };
    expect(stepMacro(matched, printer, QUIET_INPUTS, steady).state.credibility).toBeLessThan(
      BASE_POLICY.baseCredibility,
    );
  });

  it('only heavy printing sustains a hyperinflation: money demand has a floor', () => {
    // Remembered inflation of 500% a year: money demand has fallen to its floor. Money demand
    // follows remembered inflation, not this month's expectation.
    const flight: MacroState = { ...QUIET_STATE, adaptiveExpectation: 5, expectedInflation: 0.1 };
    const params = { ...P, monetizationCredibilityPenalty: 0 };
    const government = { ...BASE_POLICY, independentCentralBank: false, primaryBalance: -0.01 };
    const printing = stepMacro(flight, { ...government, monetizedShare: 1 }, QUIET_INPUTS, params);
    const borrowing = stepMacro(flight, { ...government, monetizedShare: 0 }, QUIET_INPUTS, params);
    expect(printing.monetizedDeficit).toBeGreaterThan(0.01);
    // People take in printing as fast as they take in inflation: with high remembered inflation
    // they pay close attention.
    const memory = params.expectationHalfLifeMonths / (1 + params.expectationAttention * 5);
    const plan = flight.interestBill + 0.01;
    const perceived = plan * (1 - 2 ** (-1 / memory));
    expect(printing.state.perceivedMonetization).toBeCloseTo(perceived, 12);
    expect(printing.state.expectedInflation - borrowing.state.expectedInflation).toBeCloseTo(
      (printing.state.credibility * params.monetizationInflation * perceived) /
        params.minMoneyDemand,
      9,
    );
  });

  it('the central bank prints its share of the budget deficit at once and of interest on average', () => {
    const printer = { ...BASE_POLICY, primaryBalance: -0.02, monetizedShare: 0.5 };
    const steady = { ...QUIET_STATE, interestBill: 0.04 };
    const usual = stepMacro(steady, printer, QUIET_INPUTS, P);
    expect(usual.plannedPrinting).toBeCloseTo(0.5 * (0.04 + 0.02), 12);
    // What is printed never exceeds the legal share of the month's actual cash deficit.
    expect(usual.monetizedDeficit).toBeCloseTo(
      Math.min(usual.plannedPrinting, 0.5 * usual.fiscalDeficit),
      12,
    );
    // A bigger deficit in the budget is printed in the same month.
    const spending = stepMacro(steady, { ...printer, primaryBalance: -0.1 }, QUIET_INPUTS, P);
    expect(spending.plannedPrinting - usual.plannedPrinting).toBeCloseTo(0.5 * 0.08, 12);
    expect(spending.monetizedDeficit - usual.monetizedDeficit).toBeCloseTo(0.5 * 0.08, 3);
    // A jump in the interest bill reaches printing only through its average.
    const costly = stepMacro({ ...steady, effectiveDebtRate: 0.5 }, printer, QUIET_INPUTS, P);
    expect(costly.fiscalDeficit).toBeGreaterThan(usual.fiscalDeficit + 0.1);
    expect(costly.plannedPrinting).toBe(usual.plannedPrinting);
    // The bill is planned on the debt owed when the month begins, at the month's rates.
    const moved = 1 - 2 ** (-1 / P.financingHalfLifeMonths);
    const planned = (step: MacroStep): number =>
      12 * steady.domesticDebt * Math.expm1(step.state.effectiveDebtRate / 12);
    expect(costly.state.interestBill - usual.state.interestBill).toBeCloseTo(
      (planned(costly) - planned(usual)) * moved,
      12,
    );
  });

  it("a government without market debt borrows at this month's market rate, not a stale one", () => {
    const debtFree = { ...QUIET_STATE, domesticDebt: 0, indexedDebt: 0, effectiveDebtRate: 0.9 };
    const step = stepMacro(debtFree, BASE_POLICY, QUIET_INPUTS, P);
    expect(step.state.effectiveDebtRate).toBeCloseTo(
      step.state.policyRate + step.riskPremium + P.termPremium,
      12,
    );
    const horizon = 1 + P.expectationAttention * debtFree.adaptiveExpectation;
    expect(step.state.marketRefinancing).toBeCloseTo(
      1 - 2 ** (-horizon / P.debtRepricingHalfLifeMonths),
      12,
    );
  });

  it("the central bank never prints more than the month's cash deficit", () => {
    // A stale interest bill: the debt it was owed on is gone.
    const printer = { ...BASE_POLICY, primaryBalance: -0.02, monetizedShare: 1 };
    const stale = { ...QUIET_STATE, interestBill: 0.5, domesticDebt: 0, indexedDebt: 0 };
    const step = stepMacro(stale, printer, QUIET_INPUTS, P);
    expect(step.fiscalDeficit).toBeCloseTo(0.02, 12);
    expect(step.monetizedDeficit).toBeCloseTo(0.02, 12);
    expect(step.state.foreignDebt).toBe(0);
  });

  it('the monetized share covers interest on foreign debt too', () => {
    const owing = { ...QUIET_STATE, domesticDebt: 0, indexedDebt: 0, foreignDebt: 1 };
    const bill = QUIET_INPUTS.anchorRate; // about the interest on a foreign debt of one GDP
    const printed = (monetizedShare: number): number =>
      stepMacro(
        { ...owing, interestBill: bill },
        { ...BASE_POLICY, primaryBalance: -0.02, monetizedShare },
        QUIET_INPUTS,
        P,
      ).monetizedDeficit;
    expect(printed(1)).toBeGreaterThan(0.02 + 0.8 * bill);
    expect(printed(0.5) / printed(1)).toBeGreaterThan(0.49);
    expect(printed(0.5) / printed(1)).toBeLessThan(0.51);
  });

  it('printed money pays the interest due abroad first', () => {
    // Fully monetized, no foreign borrowing: the foreign debt changes only by revaluation.
    const owing = { ...QUIET_STATE, domesticDebt: 0.5, foreignDebt: 0.3, interestBill: 0.1 };
    const policy = { ...BASE_POLICY, monetizedShare: 1, foreignBorrowingShare: 0 };
    const step = stepMacro(owing, policy, QUIET_INPUTS, P);
    const growth = (step.state.inflation + QUIET_INPUTS.potentialGrowth) / 12;
    expect(step.state.foreignDebt).toBeCloseTo(
      0.3 * Math.exp(step.state.logExchangeRate - growth),
      12,
    );
  });

  it('the interest bill is planned on the debt owed when the month begins, foreign debt included', () => {
    const moved = 1 - 2 ** (-1 / P.financingHalfLifeMonths);
    const owing = {
      ...QUIET_STATE,
      domesticDebt: 0,
      indexedDebt: 0,
      foreignDebt: 1,
      interestBill: 0,
    };
    const abroad = stepMacro(owing, BASE_POLICY, QUIET_INPUTS, P);
    expect(abroad.state.interestBill).toBeCloseTo(
      moved * 12 * Math.expm1((QUIET_INPUTS.anchorRate + abroad.riskPremium) / 12),
      12,
    );
    // Restructured debt: the real coupon on what has not matured, the market rate on what has.
    const reopened = { ...QUIET_STATE, domesticDebt: 0.8, indexedDebt: 0.8, interestBill: 0 };
    const step = stepMacro(reopened, BASE_POLICY, QUIET_INPUTS, P);
    const stays = 2 ** (-1 / P.debtRepricingHalfLifeMonths);
    const worldRealRate = QUIET_INPUTS.anchorRate - QUIET_INPUTS.anchorInflation;
    expect(step.state.interestBill).toBeCloseTo(
      moved *
        12 *
        (0.8 * (1 - stays) * Math.expm1(step.state.effectiveDebtRate / 12) +
          0.8 * stays * Math.expm1(worldRealRate / 12)),
      12,
    );
    // During an exclusion nothing is paid in cash, so the bill fades.
    const excluded = { ...reopened, marketExclusion: 12, interestBill: 0.1 };
    expect(stepMacro(excluded, BASE_POLICY, QUIET_INPUTS, P).state.interestBill).toBeCloseTo(
      0.1 * (1 - moved),
      12,
    );
  });

  it('printing never makes a government a net creditor, even when inflation wipes its debt out', () => {
    const plan = scenario('fiscal-dominance');
    const heavy = { ...plan, months: 240, start: { ...plan.start, domesticDebt: 1.5 } };
    const r = runScenario(heavy);
    expect(Math.max(...r.map((x) => x.inflation))).toBeGreaterThan(5);
    expect(Math.min(...r.map((x) => x.debt))).toBeGreaterThan(-1e-12);
  });

  it('a government that prints after the market reopens does not end up a net creditor', () => {
    const plan = { ...scenario('debt-spiral'), months: 300 };
    const first = defaultMonths(runScenario(plan))[0] ?? -1;
    expect(first).toBeGreaterThan(0);
    const reopening = first + 1 + P.marketExclusionMonths;
    const printing = runScenario({
      ...plan,
      policyChanges: [...plan.policyChanges, { month: reopening, policy: { monetizedShare: 1 } }],
    });
    expect(Math.max(...printing.map((x) => x.monetizedDeficit))).toBeGreaterThan(0.05);
    expect(Math.min(...printing.map((x) => x.debt))).toBeGreaterThan(-1e-12);
  });

  it('the risk premium saturates', () => {
    const step = stepMacro(
      { ...QUIET_STATE, domesticDebt: 1.4 },
      BASE_POLICY,
      { ...QUIET_INPUTS, politicalRiskPremium: 0.3 },
      P,
    );
    expect(step.riskPremium).toBeLessThanOrEqual(P.maxRiskPremium);
    expect(step.riskPremium).toBeGreaterThan(0.8 * P.maxRiskPremium);
  });

  it('foreign-currency debt pays the risk premium too', () => {
    const owing = { ...QUIET_STATE, domesticDebt: 0, foreignDebt: 0.5 };
    const calm = stepMacro(owing, BASE_POLICY, QUIET_INPUTS, P);
    const risky = stepMacro(owing, BASE_POLICY, { ...QUIET_INPUTS, politicalRiskPremium: 0.05 }, P);
    expect(risky.riskPremium).toBeGreaterThan(calm.riskPremium);
    for (const step of [calm, risky]) {
      expect(step.fiscalDeficit).toBeCloseTo(
        foreignInterest(step, 0.5, QUIET_INPUTS.anchorRate + step.riskPremium) -
          BASE_POLICY.primaryBalance,
        12,
      );
    }
  });

  it('new borrowing goes into foreign currency only as the policy says', () => {
    const deficit = { ...BASE_POLICY, primaryBalance: -0.05 };
    const home = stepMacro(QUIET_STATE, { ...deficit, foreignBorrowingShare: 0 }, QUIET_INPUTS, P);
    const abroad = stepMacro(
      QUIET_STATE,
      { ...deficit, foreignBorrowingShare: 1 },
      QUIET_INPUTS,
      P,
    );
    expect(home.state.foreignDebt).toBe(0);
    expect(abroad.state.foreignDebt).toBeCloseTo(0.05 / 12, 9);
  });

  it('net assets are held abroad and earn the anchor rate, without a premium', () => {
    const saver = stepMacro(
      { ...QUIET_STATE, domesticDebt: 0.01 },
      { ...BASE_POLICY, primaryBalance: 0.24 },
      { ...QUIET_INPUTS, politicalRiskPremium: 0.1 },
      P,
    );
    expect(saver.state.domesticDebt).toBe(0);
    expect(saver.state.foreignDebt).toBeLessThan(0);
    const rich = stepMacro(
      { ...QUIET_STATE, domesticDebt: 0, foreignDebt: -1 },
      { ...BASE_POLICY, primaryBalance: 0 },
      { ...QUIET_INPUTS, politicalRiskPremium: 0.1 },
      P,
    );
    expect(rich.fiscalDeficit).toBeCloseTo(foreignInterest(rich, -1, QUIET_INPUTS.anchorRate), 12);
  });

  it('a floating currency never touches the reserves', () => {
    for (const id of ['demand-boom', 'oil-shock-anchored', 'disinflation', 'debt-spiral']) {
      for (const r of runScenario(scenario(id))) expect(r.reserves).toBe(6);
    }
  });

  it('under a hard peg capital chases the interest differential alone', () => {
    const step = stepMacro(
      {
        ...QUIET_STATE,
        realExchangeRate: 0.4,
        adaptiveExpectation: 0.12,
        expectedInflation: 0.12,
      },
      { ...PEG, governmentRate: 0.06 },
      QUIET_INPUTS,
      P,
    );
    const differential = 0.06 - QUIET_INPUTS.anchorRate - step.riskPremium;
    expect(step.capitalFlow).toBeCloseTo(
      P.maxCapitalFlow * Math.tanh((PEG.capitalMobility * differential) / P.maxCapitalFlow),
      12,
    );
  });

  it('when reserves run out, the gap is exceptional financing, not a fake capital inflow', () => {
    const drained = { ...QUIET_STATE, reserves: 0.5 };
    const deficit = { ...QUIET_INPUTS, currentAccount: -0.3 };
    for (const exchangeRateFlexibility of [0, 0.5]) {
      const step = stepMacro(drained, { ...PEG, exchangeRateFlexibility }, deficit, P);
      expect(step.state.reserves).toBe(0);
      expect(step.pegCollapsed).toBe(true);
      // Thin reserves raise the risk premium, so capital leaves; it does not flow in.
      expect(step.capitalFlow).toBeLessThan(0);
      expect(step.capitalFlow).toBeGreaterThanOrEqual(-P.maxCapitalFlow);
      // Lost reserves = held share × (current account + capital flow + exceptional financing).
      expect(-drained.reserves * QUIET_INPUTS.importShare).toBeCloseTo(
        (1 - exchangeRateFlexibility) * (-0.3 + step.capitalFlow + step.financingGap),
        9,
      );
    }
  });

  it('balance of payments: under a peg, reserves move exactly with the external accounts', () => {
    // The last plan loses all its reserves in the first month.
    const drained = {
      ...withPolicy(scenario('peg-open-capital'), { governmentRate: 0 }),
      anchorRate: 0.3,
      start: { ...scenario('peg-open-capital').start, reserves: 0.5 },
    };
    let financed = 0;
    for (const plan of [scenario('peg-open-capital'), scenario('peg-closed-capital'), drained]) {
      let reserves = plan.start.reserves;
      for (const r of runScenario(plan)) {
        expect((r.reserves - reserves) * plan.importShare).toBeCloseTo(
          r.currentAccount + r.capitalFlow + r.financingGap,
          9,
        );
        financed += r.financingGap;
        reserves = r.reserves;
        if (r.pegCollapsed) break; // from here on the currency floats
      }
    }
    expect(financed).toBeGreaterThan(0);
  });

  it('a held currency that drifts to the edge of the band is realigned', () => {
    // An undervalued peg in a deflation: the real exchange rate would drift further out.
    const step = stepMacro(
      { ...QUIET_STATE, realExchangeRate: P.maxRealExchangeRateDeviation },
      PEG,
      { ...QUIET_INPUTS, costPush: -0.2 },
      P,
    );
    expect(step.state.inflation).toBeLessThan(QUIET_INPUTS.anchorInflation);
    expect(step.state.realExchangeRate).toBe(P.maxRealExchangeRateDeviation);
    expect(step.state.logExchangeRate).toBeLessThan(0); // revalued
  });

  it('debt accounting is exact: nothing is created or lost between the two stocks', () => {
    const random = lcg(7);
    const between = (lo: number, hi: number): number => lo + (hi - lo) * random();
    const matured = 1 - 2 ** (-1 / P.debtRepricingHalfLifeMonths);
    for (let i = 0; i < 500; i++) {
      const excluded = random() < 0.3;
      const domesticDebt = between(0, 1.4);
      const state: MacroState = {
        ...QUIET_STATE,
        inflation: between(-0.1, 2),
        adaptiveExpectation: between(0, 1.5),
        credibility: between(0.05, 1),
        reserves: between(0, 12),
        domesticDebt,
        // During an exclusion all domestic debt is restructured, indexed debt.
        indexedDebt: excluded ? domesticDebt : domesticDebt * between(0, 1),
        foreignDebt: between(-0.5, 0.8),
        effectiveDebtRate: between(0, 0.4),
        marketExclusion: excluded ? 10 : 0,
      };
      const policy: MacroPolicy = {
        ...BASE_POLICY,
        exchangeRateFlexibility: between(0, 1),
        independentCentralBank: random() < 0.5,
        governmentRate: between(0, 0.3),
        primaryBalance: between(-0.1, 0.1),
        monetizedShare: between(0, 1),
        foreignBorrowingShare: between(0, 1),
      };
      const inputs = {
        ...QUIET_INPUTS,
        currentAccount: between(-0.1, 0.1),
        politicalRiskPremium: between(0, 0.05),
      };
      const step = stepMacro(state, policy, inputs, P);
      if (step.defaulted) continue;
      const total = step.state.domesticDebt + step.state.foreignDebt;
      const growth = (step.state.inflation + inputs.potentialGrowth) / 12;
      const depreciation = step.state.logExchangeRate - state.logExchangeRate;
      const premium = excluded || state.foreignDebt < 0 ? 0 : step.riskPremium;
      // Indexed debt that has not matured grows with this month's inflation and the anchor's real
      // rate; the rest of the domestic debt pays the market-debt rate. Each part compounds on its own.
      const indexedRate = step.state.inflation + inputs.anchorRate - inputs.anchorInflation;
      const indexed = state.indexedDebt * (excluded ? 1 : 1 - matured);
      const expected =
        (state.domesticDebt - indexed) * Math.exp(step.state.effectiveDebtRate / 12 - growth) +
        indexed * Math.exp(indexedRate / 12 - growth) +
        state.foreignDebt * Math.exp((inputs.anchorRate + premium) / 12 - growth + depreciation) -
        policy.primaryBalance / 12 -
        step.monetizedDeficit / 12;
      // In an exclusion, anything above the restructured level is written off as well.
      const capped = excluded ? Math.min(expected, RESTRUCTURED_DEBT) : expected;
      expect(total).toBeCloseTo(capped, 12);
      expect(step.state.domesticDebt).toBeGreaterThanOrEqual(0);
      // Repayments retire market debt first.
      if (!excluded) {
        expect(step.state.indexedDebt).toBeCloseTo(
          Math.min(step.state.domesticDebt, indexed * Math.exp(step.state.inflation / 12 - growth)),
          12,
        );
      }
      // Printing never exceeds the month's need, so it never turns debt into net assets.
      if (state.foreignDebt >= 0 && policy.primaryBalance <= 0)
        expect(total).toBeGreaterThan(-1e-12);
      expect(step.state.indexedDebt).toBeLessThanOrEqual(step.state.domesticDebt + 1e-12);
    }
  });

  it('a default writes the debt down to the threshold less the haircut and shuts the market', () => {
    const step = stepMacro(
      { ...QUIET_STATE, domesticDebt: P.defaultDebtThreshold, foreignDebt: 0.2 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(step.defaulted).toBe(true);
    expect(step.state.domesticDebt + step.state.foreignDebt).toBeCloseTo(RESTRUCTURED_DEBT, 12);
    // From the default on, the restructured domestic debt is indexed.
    expect(step.state.indexedDebt).toBe(step.state.domesticDebt);
    expect(step.state.marketExclusion).toBe(P.marketExclusionMonths);
    expect(step.state.reputationPremium).toBe(P.defaultReputationPremium);
  });

  it('in market exclusion nothing is refinanced, a deficit is printed, and capital only leaves', () => {
    // Inflation well above the anchor's, so indexation and market rates are told apart.
    const excluded: MacroState = {
      ...QUIET_STATE,
      marketExclusion: 12,
      adaptiveExpectation: 0.25,
      credibility: 0.2,
      domesticDebt: 0.8,
      indexedDebt: 0.8,
      foreignDebt: 0.1,
      effectiveDebtRate: 0.4,
      policyRate: 0.3,
    };
    const risky = { ...QUIET_INPUTS, politicalRiskPremium: 0.2 };
    const balanced = stepMacro(excluded, BASE_POLICY, risky, P);
    expect(balanced.state.inflation).toBeGreaterThan(0.1);
    // The restructured debt is indexed, foreign debt pays the anchor rate, and interest is
    // capitalized rather than paid, so nothing needs financing.
    const worldRealRate = QUIET_INPUTS.anchorRate - QUIET_INPUTS.anchorInflation;
    const growth = (balanced.state.inflation + QUIET_INPUTS.potentialGrowth) / 12;
    expect(balanced.state.domesticDebt).toBeCloseTo(
      0.8 * Math.exp((worldRealRate - QUIET_INPUTS.potentialGrowth) / 12),
      12,
    );
    expect(balanced.state.foreignDebt).toBeCloseTo(
      0.1 * Math.exp(QUIET_INPUTS.anchorRate / 12 - growth + balanced.state.logExchangeRate),
      12,
    );
    expect(balanced.fiscalDeficit).toBeCloseTo(0, 12);
    expect(balanced.monetizedDeficit).toBe(0);
    expect(balanced.capitalFlow).toBeLessThanOrEqual(0);
    // A primary deficit must be printed in full, even if the law says to borrow abroad.
    const printing = (foreignBorrowingShare: number) =>
      stepMacro(
        excluded,
        { ...BASE_POLICY, primaryBalance: -0.02, foreignBorrowingShare },
        risky,
        P,
      );
    expect(printing(1).monetizedDeficit).toBeCloseTo(0.02, 12);
    expect(printing(1).state.foreignDebt).toBe(printing(0).state.foreignDebt);
  });

  it('after the market reopens, restructured debt matures at the usual pace into market debt', () => {
    // Just reopened: all domestic debt is restructured and indexed. Remembered inflation is high,
    // so new debt is issued short, but the restructured debt keeps its own maturity.
    const reopened: MacroState = {
      ...QUIET_STATE,
      inflation: 0.6,
      adaptiveExpectation: 0.5,
      expectedInflation: 0.5,
      credibility: 0.3,
      policyRate: 0.9,
      domesticDebt: 0.8,
      indexedDebt: 0.8,
      effectiveDebtRate: 0.05,
    };
    const step = stepMacro(reopened, BASE_POLICY, QUIET_INPUTS, P);
    const stays = 2 ** (-1 / P.debtRepricingHalfLifeMonths);
    const growth = (step.state.inflation + QUIET_INPUTS.potentialGrowth) / 12;
    const principal = 0.8 * stays * Math.exp(step.state.inflation / 12 - growth);
    expect(step.state.indexedDebt).toBeCloseTo(principal, 12);
    // What matured was refinanced at this month's market rate, whatever the old coupons were.
    const marketRate = step.state.policyRate + step.riskPremium + P.termPremium;
    expect(step.state.effectiveDebtRate).toBeCloseTo(marketRate, 12);
    // In cash, indexed debt pays only the anchor's real rate; inflation is added to its principal.
    const worldRealRate = QUIET_INPUTS.anchorRate - QUIET_INPUTS.anchorInflation;
    const interest =
      12 *
      (0.8 * (1 - stays) * Math.expm1(marketRate / 12) * Math.exp(-growth) +
        principal * Math.expm1(worldRealRate / 12));
    expect(step.fiscalDeficit).toBeCloseTo(interest - BASE_POLICY.primaryBalance, 12);
    // What matured is issued at the maturity of new debt, short while inflation is high.
    const horizon = 1 + P.expectationAttention * reopened.adaptiveExpectation;
    expect(step.state.marketRefinancing).toBeCloseTo(
      1 - 2 ** (-horizon / P.debtRepricingHalfLifeMonths),
      12,
    );
  });

  it('new debt is issued shorter when inflation is high, and the stock follows as old debt matures', () => {
    const usual = 1 - 2 ** (-1 / P.debtRepricingHalfLifeMonths);
    const step = (adaptiveExpectation: number): MacroStep =>
      stepMacro(
        { ...QUIET_STATE, adaptiveExpectation, effectiveDebtRate: 0.5, marketRefinancing: usual },
        BASE_POLICY,
        QUIET_INPUTS,
        P,
      );
    // The stock reprices at the pace of the debt outstanding, whatever inflation is now.
    for (const remembered of [0, 1]) {
      const s = step(remembered);
      const marketRate = s.state.policyRate + s.riskPremium + P.termPremium;
      expect(s.state.effectiveDebtRate).toBeCloseTo(0.5 + usual * (marketRate - 0.5), 12);
    }
    // What is refinanced is issued at the maturity of new debt, shorter when inflation is high.
    const short = 1 - 2 ** (-(1 + P.expectationAttention) / P.debtRepricingHalfLifeMonths);
    expect(step(1).state.marketRefinancing).toBeCloseTo((1 - usual) * usual + usual * short, 12);
    expect(step(0).state.marketRefinancing).toBeCloseTo(usual, 12);
  });

  it('the debt does not jump when the market reopens after an exclusion financed by printing', () => {
    // An 8% primary deficit drives the debt over the threshold at once; the exclusion that
    // follows is financed by printing, inflation hits its ceiling, and the government balances
    // its budget when the market reopens.
    const policy = { ...BASE_POLICY, primaryBalance: -0.08, monetizedShare: 0 };
    let state = initialMacroState(
      { inflation: 0.03, credibility: 0.8, reserves: 6, domesticDebt: 2.1, foreignDebt: 0 },
      policy,
      QUIET_INPUTS,
      P,
    );
    const reopening = 1 + P.marketExclusionMonths;
    for (let month = 0; month < reopening; month++) {
      state = stepMacro(state, policy, QUIET_INPUTS, P).state;
    }
    expect(state.inflation).toBeGreaterThan(0.9 * P.maxInflation);
    expect(state.marketExclusion).toBe(0);
    const step = stepMacro(state, { ...policy, primaryBalance: 0 }, QUIET_INPUTS, P);
    expect(step.state.inflation).toBeLessThan(0.75 * state.inflation);
    expect(step.state.domesticDebt / state.domesticDebt).toBeLessThan(1.005);
  });

  it('a government that balances its budget when the market reopens stays solvent for years', () => {
    const plan = { ...scenario('debt-spiral'), months: 300 };
    const first = defaultMonths(runScenario(plan))[0] ?? -1;
    expect(first).toBeGreaterThan(0);
    const reopening = first + 1 + P.marketExclusionMonths;
    const consolidated = runScenario({
      ...plan,
      policyChanges: [...plan.policyChanges, { month: reopening, policy: { primaryBalance: 0 } }],
    });
    const next = defaultMonths(consolidated).find((month) => month > first) ?? plan.months;
    expect(next - reopening).toBeGreaterThan(120);
  });

  it('during an exclusion all domestic debt is restructured debt, to the last bit', () => {
    // A rounding residual of market debt, with a stale coupon that would compound it.
    const excluded: MacroState = {
      ...QUIET_STATE,
      marketExclusion: 12,
      domesticDebt: 0.8,
      indexedDebt: 0.8 - 1e-16,
      effectiveDebtRate: 18,
    };
    const step = stepMacro(excluded, BASE_POLICY, QUIET_INPUTS, P);
    expect(step.state.indexedDebt).toBe(step.state.domesticDebt);
  });

  it("the first state keeps starting inflation within the model's bounds", () => {
    const start = {
      inflation: 20,
      credibility: 0.5,
      reserves: 6,
      domesticDebt: 0.5,
      foreignDebt: 0,
    };
    const tight = { ...P, maxInflation: 1 };
    const first = initialMacroState(start, BASE_POLICY, QUIET_INPUTS, tight);
    expect(first).toEqual(
      initialMacroState({ ...start, inflation: 1 }, BASE_POLICY, QUIET_INPUTS, tight),
    );
    expect(first.inflation).toBe(1);
  });

  it('until the market reopens, debt cannot climb back above its restructured level', () => {
    // A falling currency pushes the debt even past the default threshold during the exclusion:
    // the restructuring absorbs it, with no new default and no fresh start of the exclusion.
    const step = stepMacro(
      {
        ...QUIET_STATE,
        marketExclusion: 12,
        reputationPremium: P.defaultReputationPremium / 2,
        domesticDebt: P.defaultDebtThreshold + 0.3,
      },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(step.defaulted).toBe(false);
    expect(step.state.marketExclusion).toBe(11);
    expect(step.state.reputationPremium).toBeLessThan(P.defaultReputationPremium / 2);
    expect(step.state.domesticDebt + step.state.foreignDebt).toBeCloseTo(RESTRUCTURED_DEBT, 12);
  });

  it('the reputation cost of a default outlasts the exclusion, halving every half-life', () => {
    let state: MacroState = { ...QUIET_STATE, reputationPremium: P.defaultReputationPremium };
    const fresh = stepMacro(state, BASE_POLICY, QUIET_INPUTS, P);
    const clean = stepMacro(QUIET_STATE, BASE_POLICY, QUIET_INPUTS, P);
    expect(fresh.riskPremium).toBeGreaterThan(clean.riskPremium + 0.5 * P.defaultReputationPremium);
    const params = { ...P, reputationHalfLifeMonths: 50 }; // unlike every other half-life
    for (let month = 0; month < params.reputationHalfLifeMonths; month++) {
      state = stepMacro(state, BASE_POLICY, QUIET_INPUTS, params).state;
    }
    expect(state.reputationPremium).toBeCloseTo(P.defaultReputationPremium / 2, 12);
  });

  it('after a default foreign capital stays away for the whole exclusion', () => {
    const r = runScenario({ ...scenario('debt-spiral'), months: 1200 });
    const defaults = defaultMonths(r);
    expect(defaults.length).toBeGreaterThan(1);
    for (const month of defaults) {
      for (const x of r.slice(month + 1, month + 1 + P.marketExclusionMonths)) {
        expect(x.capitalFlow).toBeLessThanOrEqual(0);
      }
    }
  });

  it('under a held currency the rate follows only its own share of expected inflation', () => {
    const held = { ...BASE_POLICY, exchangeRateFlexibility: 0 }; // independent, open capital
    const defense = P.reserveDefenseWeight * held.capitalMobility;
    const ownShare = 1 - defense / (1 + defense);
    const calm = stepMacro(QUIET_STATE, held, QUIET_INPUTS, P);
    const worried = stepMacro({ ...QUIET_STATE, adaptiveExpectation: 0.13 }, held, QUIET_INPUTS, P);
    const moreExpected = worried.state.expectedInflation - calm.state.expectedInflation;
    const higherRate = worried.state.policyRate - calm.state.policyRate;
    expect(higherRate).toBeGreaterThanOrEqual(ownShare * moreExpected - 1e-12);
    expect(higherRate).toBeLessThan(ownShare * moreExpected + P.maxRuleAdjustment * ownShare);
  });

  it('a floor that binds is not remembered as a tight stance once it stops binding', () => {
    // Two years of deflation pressure, a calm year, then two years of inflation pressure. A slow
    // stance and a deep deflation make the difference visible: a stance read back from the floored
    // rate would carry the deflation's high real rate out of the floor for months.
    const macro = { ...P, policyRateHalfLifeMonths: 12, policyRateFloor: 0.02, minInflation: -0.5 };
    const plan = {
      ...scenario('baseline'),
      months: 120,
      start: { ...scenario('baseline').start, credibility: 0.3 },
      policy: { ...scenario('baseline').policy, baseCredibility: 0.3 },
      shocks: [
        { fromMonth: 0, untilMonth: 24, costPush: -0.3 },
        { fromMonth: 36, untilMonth: 60, costPush: 0.3 },
      ],
    };
    const r = runScenario(plan, macro);
    expect(r.filter((x) => x.policyRate === macro.policyRateFloor).length).toBeGreaterThan(12);
    const ruleBound = macro.neutralRealRate + macro.maxRuleAdjustment;
    for (const x of r) {
      if (x.policyRate > macro.policyRateFloor) {
        expect(x.realRate).toBeLessThanOrEqual(ruleBound + 1e-9);
      }
    }
  });

  it('investors expect a held currency that has drifted out of line to be realigned', () => {
    const peg = { ...PEG, governmentRate: 0.06 };
    const inflating = { ...QUIET_STATE, adaptiveExpectation: 0.13, expectedInflation: 0.13 };
    const halfOut = stepMacro(
      { ...inflating, realExchangeRate: -0.5 * P.maxRealExchangeRateDeviation },
      peg,
      QUIET_INPUTS,
      P,
    );
    const drift = halfOut.state.expectedInflation - QUIET_INPUTS.anchorInflation;
    const differential = 0.06 - QUIET_INPUTS.anchorRate - halfOut.riskPremium - 0.5 * drift;
    expect(halfOut.capitalFlow).toBeCloseTo(
      P.maxCapitalFlow * Math.tanh((peg.capitalMobility * differential) / P.maxCapitalFlow),
      12,
    );
    // The other way round: inflation below the anchor's leaves the currency undervalued, and
    // investors expect a revaluation.
    const deflating = { ...QUIET_STATE, adaptiveExpectation: -0.05, expectedInflation: -0.05 };
    const halfUnder = stepMacro(
      { ...deflating, realExchangeRate: 0.5 * P.maxRealExchangeRateDeviation },
      peg,
      QUIET_INPUTS,
      P,
    );
    const fall = halfUnder.state.expectedInflation - QUIET_INPUTS.anchorInflation;
    expect(fall).toBeLessThan(0);
    const gain = 0.06 - QUIET_INPUTS.anchorRate - halfUnder.riskPremium - 0.5 * fall;
    expect(halfUnder.capitalFlow).toBeCloseTo(
      P.maxCapitalFlow * Math.tanh((peg.capitalMobility * gain) / P.maxCapitalFlow),
      12,
    );
  });

  it('an overvalued peg loses its reserves and breaks instead of attracting capital', () => {
    // A peg whose government prints a deficit: inflation outruns the anchor's. Its rate is well
    // above the anchor's, so only the expected realignment keeps capital from flowing in.
    const printingPeg = withPolicy(scenario('peg-closed-capital'), {
      capitalMobility: 8,
      governmentRate: 0.09,
      primaryBalance: -0.03,
      monetizedShare: 1,
    });
    const r = runScenario({ ...printingPeg, months: 240 });
    const collapse = r.findIndex((x) => x.pegCollapsed);
    expect(collapse).toBeGreaterThan(0);
    expect(at(r, collapse - 1).reserves).toBeLessThan(printingPeg.start.reserves);
  });

  it('beyond the band a real misalignment is not forced back', () => {
    const band = P.maxRealExchangeRateDeviation;
    const step = stepMacro(
      { ...QUIET_STATE, realExchangeRate: band + 0.5 },
      BASE_POLICY,
      QUIET_INPUTS,
      P,
    );
    expect(step.state.realExchangeRate).toBeGreaterThan(band);
  });

  it('the reputation premium sits inside the risk-premium ceiling', () => {
    const step = stepMacro(
      { ...QUIET_STATE, reputationPremium: 0.3 },
      BASE_POLICY,
      { ...QUIET_INPUTS, politicalRiskPremium: 0.3 },
      P,
    );
    expect(step.riskPremium).toBeLessThanOrEqual(P.maxRiskPremium);
  });

  it('the first state charges no premium on net assets and dates its debt at the starting inflation', () => {
    const start = {
      inflation: 1,
      credibility: 0.8,
      reserves: 6,
      domesticDebt: 0.5,
      foreignDebt: -1,
    };
    const risky = { ...QUIET_INPUTS, politicalRiskPremium: 0.1 };
    const first = initialMacroState(start, BASE_POLICY, risky, P);
    expect(first.interestBill).toBeCloseTo(
      12 *
        (0.5 * Math.expm1(first.effectiveDebtRate / 12) - Math.expm1(QUIET_INPUTS.anchorRate / 12)),
      12,
    );
    expect(first.marketRefinancing).toBeCloseTo(
      1 - 2 ** (-(1 + P.expectationAttention) / P.debtRepricingHalfLifeMonths),
      12,
    );
  });

  it('the first state expects a credibility-weighted mix of the target and current inflation', () => {
    const start = {
      inflation: 0.1,
      credibility: 0.6,
      reserves: 6,
      domesticDebt: 0.5,
      foreignDebt: 0,
    };
    const first = initialMacroState(start, BASE_POLICY, QUIET_INPUTS, P);
    expect(first.expectedInflation).toBeCloseTo(0.6 * BASE_POLICY.inflationTarget + 0.4 * 0.1, 12);
  });

  it('beyond its saturation, a lower real rate stimulates demand no further', () => {
    const gapAfterOneMonth = (realRate: number): number =>
      stepDemandProxy(
        currentAccountAt(0, 0, D),
        {
          realRate,
          riskPremium: 0,
          neutralRealRate: P.neutralRealRate,
          primaryBalance: 0,
          costPush: 0,
          demandShock: 0,
          inflation: 0.03,
          inflationTarget: 0.03,
          realExchangeRate: 0,
        },
        D,
      ).outputGap;
    // The real rate's push on demand never exceeds realRateSensitivity × realRateSaturation, so a
    // real rate of −1000% (a fixed rate in a hyperinflation) is no stronger a stimulus than −100%.
    const largestPush = D.realRateSensitivity * D.realRateSaturation;
    const largestGap =
      D.maxOutputGap *
      Math.tanh(largestPush / D.maxOutputGap) *
      (1 - 2 ** (-1 / D.gapHalfLifeMonths));
    expect(gapAfterOneMonth(-10)).toBeGreaterThan(0);
    expect(gapAfterOneMonth(-10)).toBeLessThanOrEqual(largestGap + 1e-12);
    expect(gapAfterOneMonth(-10)).toBeCloseTo(gapAfterOneMonth(-1), 9);
  });

  it('private borrowers pay the sovereign premium, as if the real rate were that much higher', () => {
    const gapAfterOneMonth = (realRate: number, riskPremium: number): number =>
      stepDemandProxy(
        currentAccountAt(0, 0, D),
        {
          realRate,
          riskPremium,
          neutralRealRate: P.neutralRealRate,
          primaryBalance: 0,
          costPush: 0,
          demandShock: 0,
          inflation: 0.03,
          inflationTarget: 0.03,
          realExchangeRate: 0,
        },
        D,
      ).outputGap;
    expect(gapAfterOneMonth(0.02, 0.04)).toBeCloseTo(gapAfterOneMonth(0.06, 0), 15);
    expect(gapAfterOneMonth(0.02, 0.04)).toBeLessThan(gapAfterOneMonth(0.02, 0));
  });

  it('a small inflation miss costs little output, and each point of a large one costs about the same', () => {
    // Measured against a demand shock, which moves demand one for one.
    const gapAfterOneMonth = (inflationMiss: number, demandShock: number): number =>
      stepDemandProxy(
        currentAccountAt(0, 0, D),
        {
          realRate: P.neutralRealRate,
          riskPremium: 0,
          neutralRealRate: P.neutralRealRate,
          primaryBalance: 0,
          costPush: 0,
          demandShock,
          inflation: 0.03 + inflationMiss,
          inflationTarget: 0.03,
          realExchangeRate: 0,
        },
        D,
      ).outputGap;
    const k = D.inflationOutputCost;
    // A miss of 2 points costs about k × 0.02² / 2.
    const small = gapAfterOneMonth(0.02, 0);
    expect(small).toBeLessThan(gapAfterOneMonth(0, -k * 0.0002 * 0.99));
    expect(small).toBeGreaterThan(gapAfterOneMonth(0, -k * 0.0002 * 1.01));
    // Beyond 200 points, each further 100 points cost about k, not ever more.
    const large = gapAfterOneMonth(3, 0);
    expect(large).toBeLessThan(gapAfterOneMonth(2, -k * 0.98));
    expect(large).toBeGreaterThan(gapAfterOneMonth(2, -k));
  });

  it('the current account worsens when the economy overheats and improves after a real depreciation', () => {
    const balanced = currentAccountAt(0, 0, D);
    expect(currentAccountAt(0.03, 0, D).currentAccount).toBeLessThan(balanced.currentAccount);
    expect(currentAccountAt(0, 0.2, D).currentAccount).toBeGreaterThan(balanced.currentAccount);
    // Near its limit the current account responds less to the exchange rate.
    expect(currentAccountAt(0, 0.6, D).currentAccountSensitivity).toBeLessThan(
      balanced.currentAccountSensitivity,
    );
  });

  it('shocks and policy changes take effect exactly in the months the scenario names', () => {
    const plan = { ...scenario('baseline'), months: 30 };
    const firstDifference = (
      a: readonly MonthRecord[],
      b: readonly MonthRecord[],
      field: 'inflation' | 'debt',
    ): number => a.findIndex((x, k) => x[field] !== b[k]?.[field]);
    const shocked = (untilMonth: number): MonthRecord[] =>
      runScenario({ ...plan, shocks: [{ fromMonth: 12, untilMonth, costPush: 0.05 }] });
    expect(firstDifference(runScenario(plan), shocked(24), 'inflation')).toBe(12);
    expect(firstDifference(shocked(24), shocked(25), 'inflation')).toBe(24);
    const changed = runScenario({
      ...plan,
      policyChanges: [{ month: 12, policy: { primaryBalance: -0.05 } }],
    });
    expect(firstDifference(runScenario(plan), changed, 'debt')).toBe(12);
  });

  it('the exchange-rate solve stays stable however strongly trade responds', () => {
    const params = { ...P, floatSensitivity: MACRO_PARAM_SPECS.floatSensitivity.max };
    const strongTrade = 5; // ten times the stand-in's limit, as a richer real economy might report
    const inputsAt = (realExchangeRate: number): MacroInputs => ({
      ...QUIET_INPUTS,
      currentAccount: strongTrade * realExchangeRate,
      currentAccountSensitivity: strongTrade,
    });
    let state: MacroState = { ...QUIET_STATE, realExchangeRate: 0.5 };
    const path: number[] = [];
    for (let month = 0; month < 24; month++) {
      state = stepMacro(state, BASE_POLICY, inputsAt(state.realExchangeRate), params).state;
      path.push(state.realExchangeRate);
    }
    // The misalignment closes almost at once and never swings back out.
    expect(Math.max(...path.slice(1).map(Math.abs))).toBeLessThan(0.05);
  });

  it('a devaluation reaches consumer prices over several months, not in one jump', () => {
    const r = runScenario(scenario('peg-open-capital'));
    const collapse = r.findIndex((x) => x.pegCollapsed);
    const first = at(r, collapse + 1).inflation;
    const second = at(r, collapse + 2).inflation;
    expect(first).toBeGreaterThan(0.08);
    expect(second).toBeGreaterThan(0.06);
    expect(second).toBeLessThan(first);
  });

  it('real misalignment stays within its band even under hyperinflation', () => {
    const plan = { ...scenario('hyperinflation'), months: 1200 };
    for (const r of runScenario(plan)) {
      const realExchangeRate =
        r.logExchangeRate - r.logPriceLevel + (plan.anchorInflation * (r.month + 1)) / 12;
      expect(Math.abs(realExchangeRate)).toBeLessThanOrEqual(P.maxRealExchangeRateDeviation + 1e-9);
    }
  });

  it('capital flows saturate instead of growing without bound', () => {
    const run = {
      ...withPolicy(scenario('peg-open-capital'), { governmentRate: 0 }),
      anchorRate: 0.3,
    };
    const first = at(runScenario(run), 0);
    expect(first.capitalFlow).toBeLessThan(-0.9 * P.maxCapitalFlow);
    expect(first.capitalFlow).toBeGreaterThanOrEqual(-P.maxCapitalFlow - 1e-12);
  });
});

describe('macro block: numerical safety over every documented range', () => {
  it('rejects parameters, policies and scenario inputs outside their documented ranges', () => {
    const base = scenario('baseline');
    const invalid: readonly MacroScenario[] = [
      withPolicy(base, { exchangeRateFlexibility: 1.5 }),
      { ...base, policyChanges: [{ month: 12, policy: { monetizedShare: 2 } }] },
      { ...base, start: { ...base.start, credibility: 1.5 } },
      { ...base, start: { ...base.start, reserves: -1 } },
      { ...base, importShare: 0 },
      { ...base, anchorRate: Number.NaN },
      { ...base, shocks: [{ fromMonth: 0, untilMonth: 12, costPush: 0.5 }] },
      { ...base, policyChanges: [{ month: 12.5, policy: { primaryBalance: -0.01 } }] },
    ];
    expect(() => runScenario(base, { ...P, phillipsSlope: 5 })).toThrow(RangeError);
    expect(() => runScenario(base, P, { ...D, fiscalMultiplier: 5 })).toThrow(RangeError);
    for (const plan of invalid) expect(() => runScenario(plan)).toThrow(RangeError);
  });

  it('stays exactly at a consistent steady state for parameters drawn across their ranges', () => {
    const random = lcg(11);
    for (let i = 0; i < 25; i++) {
      const steady = steadyState(sampleParams(MACRO_PARAM_SPECS, random, 'uniform'), 0.03);
      const demand = sampleParams(DEMAND_PROXY_PARAM_SPECS, random, 'uniform');
      for (const r of runScenario({ ...steady.scenario, months: 240 }, steady.macro, demand)) {
        expect(r.inflation).toBeCloseTo(0.03, 9);
        expect(r.outputGap).toBeCloseTo(0, 9);
        expect(r.capitalFlow).toBeCloseTo(0, 9);
        expect(r.debt).toBeCloseTo(steady.scenario.start.domesticDebt, 9);
        expect(r.credibility).toBeCloseTo(steady.scenario.start.credibility, 9);
      }
    }
  });

  it('stays finite, bounded and free of high-frequency oscillation for a hundred years', () => {
    for (const { where, plan, macro, demand } of propertyCases(2024)) {
      expectSafe(runScenario(plan, macro, demand), macro, demand, where);
    }
  }, 60_000);

  it('loops stay damped where they once oscillated', () => {
    // Corners from earlier reviews: net foreign assets revalued every month swung the deficit,
    // and with it the printing, when the central bank planned on this month's exchange rate; and
    // credibility judged on the target alone rose whenever inflation neared it, lifting
    // expectations toward the printing anchor.
    for (const corner of OSCILLATION_CORNERS) {
      const base = scenario(corner.scenario);
      const plan = {
        ...base,
        months: 1200,
        policy: corner.policy,
        policyChanges: [...base.policyChanges, corner.change],
      };
      expectSafe(
        runScenario(plan, corner.macro, corner.demand),
        corner.macro,
        corner.demand,
        corner.name,
      );
    }
  });
});
