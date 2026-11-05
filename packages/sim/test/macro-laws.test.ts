// Tests for the macro block, in four groups:
//  1. regularities at the calibrated parameters, as controlled comparisons;
//  2. the same regularities across a calibrated neighbourhood (every parameter within ±20%);
//  3. mechanism-level checks, each of which fails if its mechanism is removed;
//  4. numerical safety over every documented parameter range, including the range endpoints.
// The full documented ranges promise numerical safety; the economic regularities are promised
// for the calibrated neighbourhood, where they are tested.
import { describe, expect, it } from 'vitest';
import {
  currentAccountAt,
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  type DemandProxyParams,
} from '../src/macro/demand-proxy.ts';
import {
  initialMacroState,
  stepMacro,
  type MacroInputs,
  type MacroPolicy,
  type MacroState,
} from '../src/macro/model.ts';
import { DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, type MacroParams } from '../src/macro/params.ts';
import { runScenario, type MacroScenario, type MonthRecord } from '../src/macro/sandbox.ts';
import { MACRO_SCENARIOS } from '../src/macro/scenarios.ts';
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

/** Counts reversals of month-to-month inflation changes larger than one percentage point. */
function reversals(records: readonly MonthRecord[]): number {
  let count = 0;
  for (let k = 2; k < records.length; k++) {
    const change = at(records, k).inflation - at(records, k - 1).inflation;
    const previous = at(records, k - 1).inflation - at(records, k - 2).inflation;
    if (change * previous < 0 && Math.abs(change) > 0.01) count++;
  }
  return count;
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
const QUIET_STATE: MacroState = initialMacroState(
  { inflation: 0.03, credibility: 0.8, reserves: 6, domesticDebt: 0.5, foreignDebt: 0 },
  BASE_POLICY,
  QUIET_INPUTS,
  P,
);

/** The regularities, each as a predicate over parameter sets (used at defaults and nearby). */
const REGULARITIES: Readonly<Record<string, (m: MacroParams, d: DemandProxyParams) => boolean>> = {
  'Phillips curve and Taylor rule': (m, d) => {
    const base = at(runScenario(scenario('baseline'), m, d), 35);
    const boom = at(runScenario(scenario('demand-boom'), m, d), 35);
    return (
      boom.outputGap > 0 && boom.inflation > base.inflation && boom.policyRate > base.policyRate
    );
  },
  'twin deficits': (m, d) => at(runScenario(scenario('demand-boom'), m, d), 35).currentAccount < 0,
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
  'quantity theory: more printing, higher plateau': (m, d) => {
    const plateau = (primaryBalance: number): number =>
      mean(
        runScenario(withPolicy(scenario('fiscal-dominance'), { primaryBalance }), m, d)
          .slice(120, 180)
          .map((r) => r.inflation),
      );
    return plateau(-0.005) < plateau(-0.01) && plateau(-0.01) < plateau(-0.015);
  },
  'seigniorage limit: runaway inflation': (m, d) => {
    const r = runScenario(scenario('hyperinflation'), m, d);
    return (
      at(r, 59).inflation > at(r, 47).inflation &&
      at(r, 47).inflation > at(r, 35).inflation &&
      at(r, 59).inflation > 1
    );
  },
  'inflation tax falls on domestic debt only': (m, d) => {
    const end = at(runScenario(scenario('hyperinflation'), m, d), 59);
    return (
      end.debt - end.foreignDebt < 0.01 &&
      end.foreignDebt > scenario('hyperinflation').start.foreignDebt
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
  'a debt spiral ends in default': (m, d) =>
    runScenario(scenario('debt-spiral'), m, d).some((r) => r.defaulted),
  'sovereign risk spills into private borrowing': (m, d) => {
    const r = runScenario(scenario('debt-spiral'), m, d);
    const first = r.findIndex((x) => x.defaulted);
    return first > 0 && at(r, first - 1).outputGap < 0;
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

  it('credibility is judged on the remembered record, not on one good month', () => {
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
  });

  it('printing money costs credibility', () => {
    const deficit = { ...BASE_POLICY, primaryBalance: -0.05 };
    const printed = stepMacro(QUIET_STATE, { ...deficit, monetizedShare: 1 }, QUIET_INPUTS, P);
    const borrowed = stepMacro(QUIET_STATE, deficit, QUIET_INPUTS, P);
    expect(printed.state.credibility).toBeLessThan(borrowed.state.credibility);
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
    expect(risky.fiscalDeficit - calm.fiscalDeficit).toBeCloseTo(risky.riskPremium * 0.5, 9);
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

  it('a floating currency never touches the reserves', () => {
    for (const id of ['demand-boom', 'oil-shock-anchored', 'disinflation', 'debt-spiral']) {
      for (const r of runScenario(scenario(id))) expect(r.reserves).toBe(6);
    }
  });

  it('when reserves run out, the gap is exceptional financing, not a fake capital inflow', () => {
    const peg = { ...BASE_POLICY, exchangeRateFlexibility: 0, independentCentralBank: false };
    const step = stepMacro(
      { ...QUIET_STATE, reserves: 0.5 },
      peg,
      { ...QUIET_INPUTS, currentAccount: -0.3 },
      P,
    );
    expect(step.state.reserves).toBe(0);
    // Thin reserves raise the risk premium, so capital leaves; it does not flow in.
    expect(step.capitalFlow).toBeLessThan(0);
    expect(step.capitalFlow).toBeGreaterThanOrEqual(-P.maxCapitalFlow);
    // Lost reserves = current account + capital flow + exceptional financing.
    expect(step.financingGap).toBeCloseTo(
      0.3 - step.capitalFlow - 0.5 * QUIET_INPUTS.importShare,
      9,
    );
    expect(step.pegCollapsed).toBe(true);
  });

  it('debt accounting is exact: nothing is created or lost between the two stocks', () => {
    const random = lcg(7);
    const between = (lo: number, hi: number): number => lo + (hi - lo) * random();
    for (let i = 0; i < 500; i++) {
      const state: MacroState = {
        ...QUIET_STATE,
        inflation: between(-0.1, 2),
        adaptiveExpectation: between(0, 1.5),
        credibility: between(0.05, 1),
        reserves: between(0, 12),
        domesticDebt: between(-0.2, 1.4),
        foreignDebt: between(0, 0.8),
        effectiveDebtRate: between(0, 0.4),
        marketExclusion: random() < 0.3 ? 10 : 0,
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
      const growth = (step.state.inflation + inputs.potentialGrowth) / 12;
      const depreciation = step.state.logExchangeRate - state.logExchangeRate;
      const expected =
        state.domesticDebt * Math.exp(step.state.effectiveDebtRate / 12 - growth) +
        state.foreignDebt *
          Math.exp((inputs.anchorRate + step.riskPremium) / 12 - growth + depreciation) -
        policy.primaryBalance / 12 -
        step.monetizedDeficit / 12;
      expect(step.state.domesticDebt + step.state.foreignDebt).toBeCloseTo(expected, 12);
      expect(step.state.foreignDebt).toBeGreaterThanOrEqual(0);
    }
  });

  it('balance of payments: under a peg, reserves move exactly with the external accounts', () => {
    for (const id of ['peg-open-capital', 'peg-closed-capital']) {
      const plan = scenario(id);
      let reserves = plan.start.reserves;
      for (const r of runScenario(plan)) {
        expect((r.reserves - reserves) * plan.importShare).toBeCloseTo(
          r.currentAccount + r.capitalFlow + r.financingGap,
          9,
        );
        reserves = r.reserves;
        if (r.pegCollapsed) break; // from here on the currency floats
      }
    }
  });

  it('in market exclusion only the primary deficit is printed and nothing is borrowed', () => {
    const excluded = {
      ...QUIET_STATE,
      marketExclusion: 12,
      domesticDebt: 1,
      effectiveDebtRate: 0.1,
    };
    // Interest on the defaulted debt is in arrears: it accrues but is not paid in cash.
    const balanced = stepMacro(excluded, BASE_POLICY, QUIET_INPUTS, P);
    expect(balanced.fiscalDeficit).toBeGreaterThan(0.05);
    expect(balanced.monetizedDeficit).toBe(0);
    expect(balanced.state.domesticDebt).toBeGreaterThan(1);
    // A primary deficit must be printed in full, even if the law says to borrow abroad.
    const deficit = stepMacro(
      excluded,
      { ...BASE_POLICY, primaryBalance: -0.02, foreignBorrowingShare: 1 },
      QUIET_INPUTS,
      P,
    );
    expect(deficit.monetizedDeficit).toBeCloseTo(0.02, 12);
    expect(deficit.state.foreignDebt).toBe(0);
  });

  it('the current account worsens when the economy overheats and improves after a real depreciation', () => {
    const balanced = currentAccountAt(0, 0, D).currentAccount;
    expect(currentAccountAt(0.03, 0, D).currentAccount).toBeLessThan(balanced);
    expect(currentAccountAt(0, 0.2, D).currentAccount).toBeGreaterThan(balanced);
  });

  it('after a default the market stays shut, and capital keeps leaving at first', () => {
    const r = runScenario({ ...scenario('debt-spiral'), months: 1200 });
    const defaults = r.flatMap((x) => (x.defaulted ? [x.month] : []));
    expect(defaults.length).toBeGreaterThan(1);
    for (let k = 1; k < defaults.length; k++) {
      expect((defaults[k] ?? 0) - (defaults[k - 1] ?? 0)).toBeGreaterThan(P.marketExclusionMonths);
    }
    const first = defaults[0] ?? 0;
    expect(at(r, first + 1).capitalFlow).toBeLessThan(0);
    expect(at(r, first + 3).logExchangeRate).toBeGreaterThan(at(r, first).logExchangeRate);
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
  it('rejects parameters and policies outside their documented ranges', () => {
    expect(() => runScenario(scenario('baseline'), { ...P, phillipsSlope: 5 })).toThrow(RangeError);
    expect(() =>
      runScenario(withPolicy(scenario('baseline'), { exchangeRateFlexibility: 1.5 })),
    ).toThrow(RangeError);
  });

  it('stays exactly at a consistent steady state for any parameters', () => {
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
    const random = lcg(2024);
    for (const sampling of ['uniform', 'endpoints', 'mixed'] as const) {
      for (let i = 0; i < 15; i++) {
        const macro = sampleParams(MACRO_PARAM_SPECS, random, sampling);
        const demand = sampleParams(DEMAND_PROXY_PARAM_SPECS, random, sampling);
        const exclusion = Math.ceil(macro.marketExclusionMonths);
        for (const base of MACRO_SCENARIOS) {
          const records = runScenario({ ...base, months: 1200 }, macro, demand);
          let lastDefault = -Infinity;
          const broken = records.find((r) => {
            const excluded = r.month - lastDefault <= exclusion;
            if (r.defaulted && excluded) return true; // defaults must be spaced by the exclusion
            if (r.defaulted) lastDefault = r.month;
            return (
              Object.values(r).some((v) => typeof v === 'number' && !Number.isFinite(v)) ||
              Math.abs(r.capitalFlow) > macro.maxCapitalFlow + 1e-9 ||
              Math.abs(r.outputGap) > demand.maxOutputGap + 1e-9 ||
              Math.abs(r.currentAccount) > demand.maxCurrentAccount + 1e-9 ||
              r.inflation < macro.minInflation - 1e-9 ||
              r.inflation > macro.maxInflation + 1e-9 ||
              r.reserves < 0 ||
              r.financingGap < 0 ||
              (!excluded && r.debt > macro.defaultDebtThreshold + 1e-9)
            );
          });
          const where = `${base.id}, ${sampling} parameter set ${String(i)}`;
          expect(broken, where).toBeUndefined();
          // A period-2 or period-3 cycle reverses almost every month; slower cycles are economics.
          expect(reversals(records.slice(-121)), where).toBeLessThanOrEqual(40);
        }
      }
    }
  });
});
