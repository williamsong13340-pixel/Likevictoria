// Each regularity is pinned down by a controlled comparison: runs that differ in exactly one
// mechanism. Property tests cover every documented parameter range over a hundred years.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  type DemandProxyParams,
} from '../src/macro/demand-proxy.ts';
import {
  initialMacroState,
  stepMacro,
  type MacroInputs,
  type MacroPolicy,
} from '../src/macro/model.ts';
import { DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, type MacroParams } from '../src/macro/params.ts';
import { runScenario, type MacroScenario, type MonthRecord } from '../src/macro/sandbox.ts';
import { MACRO_SCENARIOS } from '../src/macro/scenarios.ts';
import type { ParamSpecs } from '../src/params.ts';

const P = DEFAULT_MACRO_PARAMS;

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

function sampleParams<T extends { readonly [K in keyof T]: number }>(
  specs: ParamSpecs<T>,
  random: () => number,
): T {
  const sampled: Record<string, number> = {};
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key];
    sampled[key] = spec.min + (spec.max - spec.min) * random();
  }
  return sampled as T;
}

/** A scenario that is an exact steady state for the given parameters. */
function steadyState(
  macro: MacroParams,
  demand: DemandProxyParams,
  target: number,
): { scenario: MacroScenario; macro: MacroParams; demand: DemandProxyParams } {
  const base = scenario('baseline');
  const rate = target + macro.neutralRealRate;
  return {
    macro: { ...macro, policyRateFloor: Math.min(macro.policyRateFloor, rate) },
    demand: { ...demand, inflationOutputCost: 0 },
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

describe('macro block: regularities as controlled comparisons', () => {
  it('Phillips curve and Taylor rule: a fiscal boom raises the gap, inflation and rates', () => {
    const base = at(runScenario(scenario('baseline')), 35);
    const boom = at(runScenario(scenario('demand-boom')), 35);
    expect(boom.outputGap).toBeGreaterThan(0.01);
    expect(boom.inflation - base.inflation).toBeGreaterThan(0.003);
    expect(boom.policyRate - base.policyRate).toBeGreaterThan(0.005);
    expect(boom.currentAccount).toBeLessThan(base.currentAccount - 0.005); // twin deficits
  });

  it('twin deficits also run through imports when the exchange rate cannot move', () => {
    const boom = withPolicy(scenario('demand-boom'), {
      exchangeRateFlexibility: 0,
      capitalMobility: 0.2,
    });
    const noPriceEffect = { ...DEFAULT_DEMAND_PROXY_PARAMS, tradeElasticity: 0 };
    const withImports = at(runScenario(boom, P, noPriceEffect), 35);
    const withoutImports = at(runScenario(boom, P, { ...noPriceEffect, importPropensity: 0 }), 35);
    expect(withImports.currentAccount).toBeLessThan(-0.005);
    expect(Math.abs(withoutImports.currentAccount)).toBeLessThan(1e-9);
  });

  it('stagflation: a cost shock raises inflation while output falls', () => {
    for (const r of runScenario(scenario('oil-shock-anchored')).slice(6, 12)) {
      expect(r.inflation).toBeGreaterThan(0.035);
      expect(r.outputGap).toBeLessThan(-0.005);
    }
  });

  it('credibility decides whether a supply shock is transitory', () => {
    const shock = scenario('oil-shock-anchored');
    const credible = at(runScenario(shock), 47);
    const doubted = at(
      runScenario({
        ...withPolicy(shock, { baseCredibility: 0.3 }),
        start: { ...shock.start, credibility: 0.3 },
      }),
      47,
    );
    expect(Math.abs(credible.inflation - 0.03)).toBeLessThan(0.005);
    expect(doubted.inflation - credible.inflation).toBeGreaterThan(0.01);
  });

  it('Taylor principle: at equal credibility, a fixed nominal rate lets inflation persist', () => {
    const fixed = scenario('oil-shock-unanchored');
    const fixedRate = at(runScenario(fixed), 95);
    const rule = at(runScenario(withPolicy(fixed, { independentCentralBank: true })), 95);
    expect(fixedRate.inflation - rule.inflation).toBeGreaterThan(0.03);
    expect(fixedRate.realRate).toBeLessThan(0);
    expect(rule.realRate).toBeGreaterThan(0);
  });

  it('disinflation costs more output when credibility is low', () => {
    const plan = scenario('disinflation');
    const doubted = runScenario(plan);
    const trusted = runScenario({ ...plan, start: { ...plan.start, credibility: 0.6 } });
    expect(outputLoss(doubted, 12)).toBeGreaterThan(1.5 * outputLoss(trusted, 12));
    expect(at(doubted, 119).inflation).toBeLessThan(0.04);
  });

  it('credibility is judged on the remembered record, not on one good month', () => {
    const policy = scenario('baseline').policy;
    const inputs = QUIET_INPUTS;
    const start = initialMacroState(
      { inflation: 0.03, credibility: 0.5, reserves: 6, domesticDebt: 0.5, foreignDebt: 0 },
      policy,
      inputs,
      P,
    );
    const goodMonthBadRecord = stepMacro(
      { ...start, adaptiveExpectation: 0.15 },
      policy,
      inputs,
      P,
    );
    const badMonthGoodRecord = stepMacro({ ...start, inflation: 0.15 }, policy, inputs, P);
    expect(goodMonthBadRecord.state.credibility).toBeLessThan(0.5);
    expect(badMonthGoodRecord.state.credibility).toBeGreaterThan(0.5);
  });

  it('quantity theory: inflation settles on a plateau that rises with the printed deficit', () => {
    const base = scenario('fiscal-dominance');
    const plateau = (primaryBalance: number): { level: number; drift: number } => {
      const r = runScenario(withPolicy(base, { primaryBalance }));
      return {
        level: mean(r.slice(120, 180).map((x) => x.inflation)),
        drift: Math.abs(at(r, 179).inflation - at(r, 119).inflation),
      };
    };
    const small = plateau(-0.005);
    const medium = plateau(-0.01);
    const large = plateau(-0.015);
    expect(small.level).toBeGreaterThan(0.05);
    expect(medium.level).toBeGreaterThan(small.level + 0.02);
    expect(large.level).toBeGreaterThan(medium.level + 0.02);
    for (const p of [small, medium, large]) expect(p.drift).toBeLessThan(0.03);
  });

  it('seigniorage limit: beyond it, inflation accelerates without bound and credibility collapses', () => {
    const r = runScenario(scenario('hyperinflation'));
    expect(at(r, 35).inflation).toBeGreaterThan(at(r, 23).inflation);
    expect(at(r, 47).inflation).toBeGreaterThan(at(r, 35).inflation);
    expect(at(r, 47).inflation).toBeGreaterThan(1);
    expect(at(r, 47).credibility).toBeLessThan(0.2);
  });

  it('the inflation tax falls on domestic debt only', () => {
    const plan = scenario('hyperinflation');
    const end = at(runScenario(plan), 59);
    expect(end.debt - end.foreignDebt).toBeLessThan(0.01);
    expect(end.foreignDebt).toBeGreaterThan(plan.start.foreignDebt);
  });

  it('impossible trinity: under a peg, more capital mobility drains reserves faster', () => {
    const cut = scenario('peg-open-capital');
    const reservesAfterAYear = (capitalMobility: number): number =>
      at(runScenario(withPolicy(cut, { capitalMobility })), 11).reserves;
    expect(reservesAfterAYear(8)).toBeLessThan(reservesAfterAYear(2));
    expect(reservesAfterAYear(2)).toBeLessThan(reservesAfterAYear(0.2));
    expect(runScenario(cut).findIndex((r) => r.pegCollapsed)).toBeLessThan(24);
    expect(runScenario(scenario('peg-closed-capital')).some((r) => r.pegCollapsed)).toBe(false);
  });

  it('impossible trinity: with open capital, flexibility shifts the burden from reserves to the currency', () => {
    const cut = scenario('peg-open-capital');
    const [peg, managed, float] = [0, 0.5, 1].map((exchangeRateFlexibility) =>
      at(runScenario(withPolicy(cut, { exchangeRateFlexibility })), 5),
    );
    if (peg === undefined || managed === undefined || float === undefined) throw new Error();
    expect(peg.reserves).toBeLessThan(managed.reserves);
    expect(managed.reserves).toBeLessThan(float.reserves);
    expect(peg.logExchangeRate).toBeLessThan(managed.logExchangeRate);
    expect(managed.logExchangeRate).toBeLessThan(float.logExchangeRate);
  });

  it('impossible trinity: defending a peg means giving up rate cuts in a recession', () => {
    const recession = scenario('peg-defended');
    const lowestRate = (r: readonly MonthRecord[]): number =>
      Math.min(...r.slice(6, 24).map((x) => x.policyRate));
    const peg = lowestRate(runScenario(recession));
    const float = lowestRate(runScenario(withPolicy(recession, { exchangeRateFlexibility: 1 })));
    expect(float).toBeLessThan(peg - 0.008);
    expect(Math.abs(peg - recession.anchorRate)).toBeLessThan(0.01);
  });

  it('currency mismatch: a devaluation inflates foreign-currency debt at once', () => {
    const r = runScenario(scenario('peg-open-capital'));
    const collapse = r.findIndex((x) => x.pegCollapsed);
    const before = at(r, collapse - 1);
    const after = at(r, collapse);
    expect(after.foreignDebt / before.foreignDebt).toBeGreaterThan(
      Math.exp(0.9 * P.devaluationSize),
    );
    expect(
      Math.abs(after.debt - after.foreignDebt - (before.debt - before.foreignDebt)),
    ).toBeLessThan(0.01);
  });

  it('balance of payments: under a peg, reserves move exactly with the external accounts', () => {
    for (const id of ['peg-open-capital', 'peg-closed-capital']) {
      const plan = scenario(id);
      let reserves = plan.start.reserves;
      for (const r of runScenario(plan)) {
        expect((r.reserves - reserves) * plan.importShare).toBeCloseTo(
          r.currentAccount + r.capitalFlow,
          9,
        );
        reserves = r.reserves;
        if (r.pegCollapsed) break; // from here on the currency floats
      }
    }
  });

  it('falling reserves raise the risk premium', () => {
    const r = runScenario(scenario('peg-open-capital'));
    expect(at(r, 0).riskPremium).toBeLessThan(1e-9);
    expect(
      at(
        r,
        r.findIndex((x) => x.pegCollapsed),
      ).riskPremium,
    ).toBeGreaterThan(0.005);
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

  it('a debt spiral ends in default, and the write-down keeps debt bounded', () => {
    const r = runScenario(scenario('debt-spiral'));
    const first = r.findIndex((x) => x.defaulted);
    expect(first).toBeGreaterThan(0);
    expect(at(r, first - 1).riskPremium).toBeGreaterThan(0.1);
    for (const x of r) expect(x.debt).toBeLessThanOrEqual(P.defaultDebtThreshold);
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
    const realExchangeRate = (r: MonthRecord): number =>
      r.logExchangeRate - r.logPriceLevel + (plan.anchorInflation * (r.month + 1)) / 12;
    for (const r of runScenario(plan)) {
      expect(Math.abs(realExchangeRate(r))).toBeLessThanOrEqual(
        P.maxRealExchangeRateDeviation + 1e-9,
      );
    }
  });

  it('the exchange-rate solve stays stable however strongly trade responds', () => {
    const policy = scenario('baseline').policy;
    const params = { ...P, floatSensitivity: MACRO_PARAM_SPECS.floatSensitivity.max };
    const strongTrade = 5; // ten times the stand-in's limit, as a richer real economy might report
    const inputsAt = (realExchangeRate: number): MacroInputs => ({
      ...QUIET_INPUTS,
      currentAccount: strongTrade * realExchangeRate,
      currentAccountSensitivity: strongTrade,
    });
    const start = initialMacroState(
      { inflation: 0.03, credibility: 0.8, reserves: 6, domesticDebt: 0.5, foreignDebt: 0 },
      policy,
      inputsAt(0),
      params,
    );
    let state = { ...start, realExchangeRate: 0.5 };
    const path: number[] = [];
    for (let month = 0; month < 24; month++) {
      state = stepMacro(state, policy, inputsAt(state.realExchangeRate), params).state;
      path.push(state.realExchangeRate);
    }
    // The misalignment closes almost at once and never swings back out.
    expect(Math.max(...path.slice(1).map(Math.abs))).toBeLessThan(0.05);
  });

  it('sovereign risk spills into private borrowing: a debt spiral is a recession', () => {
    const r = runScenario(scenario('debt-spiral'));
    expect(at(r, r.findIndex((x) => x.defaulted) - 1).outputGap).toBeLessThan(-0.01);
  });

  it('very high inflation destroys output', () => {
    expect(at(runScenario(scenario('hyperinflation')), 59).outputGap).toBeLessThan(-0.02);
  });

  it('Fisher effect and relative PPP: a higher target means higher rates and steady depreciation', () => {
    const steady = steadyState(P, DEFAULT_DEMAND_PROXY_PARAMS, 0.08);
    const end = at(runScenario(steady.scenario, steady.macro, steady.demand), 119);
    expect(end.inflation).toBeCloseTo(0.08, 9);
    expect(end.policyRate).toBeCloseTo(0.08 + P.neutralRealRate, 9);
    expect(end.logExchangeRate).toBeCloseTo(10 * (0.08 - 0.03), 6);
  });
});

describe('macro block: numerical safety over every documented range', () => {
  it('rejects parameters outside their documented range', () => {
    expect(() => runScenario(scenario('baseline'), { ...P, phillipsSlope: 5 })).toThrow(RangeError);
  });

  it('stays exactly at a consistent steady state for any parameters', () => {
    const random = lcg(11);
    for (let i = 0; i < 25; i++) {
      const steady = steadyState(
        sampleParams(MACRO_PARAM_SPECS, random),
        sampleParams(DEMAND_PROXY_PARAM_SPECS, random),
        0.03,
      );
      for (const r of runScenario(
        { ...steady.scenario, months: 240 },
        steady.macro,
        steady.demand,
      )) {
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
    for (let i = 0; i < 40; i++) {
      const macro = sampleParams(MACRO_PARAM_SPECS, random);
      const demand = sampleParams(DEMAND_PROXY_PARAM_SPECS, random);
      for (const base of MACRO_SCENARIOS) {
        const records = runScenario({ ...base, months: 1200 }, macro, demand);
        const broken = records.find(
          (r) =>
            Object.values(r).some((v) => typeof v === 'number' && !Number.isFinite(v)) ||
            Math.abs(r.capitalFlow) > macro.maxCapitalFlow + 1e-9 ||
            Math.abs(r.outputGap) > demand.maxOutputGap + 1e-9 ||
            Math.abs(r.currentAccount - base.baselineCurrentAccount) >
              demand.maxCurrentAccount + 1e-9 ||
            r.inflation < macro.minInflation - 1e-9 ||
            r.inflation > macro.maxInflation + 1e-9 ||
            r.reserves < 0 ||
            r.debt > macro.defaultDebtThreshold,
        );
        expect(broken, `${base.id} with parameter set ${String(i)}`).toBeUndefined();
        // A period-2 or period-3 cycle reverses almost every month; slower cycles are economics.
        expect(reversals(records.slice(-121)), base.id).toBeLessThanOrEqual(40);
      }
    }
  });
});
