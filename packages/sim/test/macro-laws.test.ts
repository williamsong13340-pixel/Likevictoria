// Each test pins down one economic regularity the macro block must reproduce.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MACRO_PARAMS } from '../src/macro/params.ts';
import { runScenario, type MacroScenario, type MonthRecord } from '../src/macro/sandbox.ts';
import { MACRO_SCENARIOS } from '../src/macro/scenarios.ts';

function scenario(id: string): MacroScenario {
  const found = MACRO_SCENARIOS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`missing scenario ${id}`);
  return found;
}

function at(records: readonly MonthRecord[], month: number): MonthRecord {
  const record = records[month];
  if (record === undefined) throw new Error(`no record for month ${String(month)}`);
  return record;
}

function between(
  records: readonly MonthRecord[],
  from: number,
  until: number,
): readonly MonthRecord[] {
  return records.slice(from, until);
}

describe('macro block reproduces economic regularities', () => {
  it('stays exactly at its steady state without shocks', () => {
    for (const r of runScenario(scenario('baseline'))) {
      expect(r.inflation).toBeCloseTo(0.03, 9);
      expect(r.outputGap).toBeCloseTo(0, 9);
      expect(r.debt).toBeCloseTo(0.5, 9);
      expect(r.capitalFlow).toBeCloseTo(0, 9);
    }
  });

  it('Phillips curve and Taylor rule: a fiscal boom raises the gap, inflation and rates', () => {
    const records = runScenario(scenario('demand-boom'));
    const boom = between(records, 0, 36);
    expect(Math.max(...boom.map((r) => r.outputGap))).toBeGreaterThan(0.02);
    expect(at(records, 35).inflation).toBeGreaterThan(0.035);
    expect(at(records, 35).policyRate).toBeGreaterThan(0.065);
    expect(at(records, 35).currentAccount).toBeLessThan(-0.01); // twin deficits
    expect(Math.abs(at(records, 95).inflation - 0.03)).toBeLessThan(0.005);
  });

  it('stagflation: a cost shock raises inflation while output falls', () => {
    const shock = at(runScenario(scenario('oil-shock-anchored')), 11);
    expect(shock.inflation).toBeGreaterThan(0.06);
    expect(shock.outputGap).toBeLessThan(-0.02);
  });

  it('credibility decides whether a supply shock is transitory', () => {
    const anchored = runScenario(scenario('oil-shock-anchored'));
    const unanchored = runScenario(scenario('oil-shock-unanchored'));
    expect(at(anchored, 47).inflation).toBeLessThan(0.04);
    expect(at(unanchored, 47).inflation - at(anchored, 47).inflation).toBeGreaterThan(0.05);
    // With a fixed nominal rate the real rate falls as inflation rises (Taylor principle).
    expect(at(unanchored, 95).inflation).toBeGreaterThan(at(unanchored, 47).inflation);
    expect(at(unanchored, 95).realRate).toBeLessThan(-0.03);
  });

  it('disinflation costs a recession and rebuilds credibility', () => {
    const records = runScenario(scenario('disinflation'));
    const afterSwitch = between(records, 12, 60);
    expect(Math.min(...afterSwitch.map((r) => r.outputGap))).toBeLessThan(-0.005);
    expect(Math.max(...afterSwitch.map((r) => r.realRate))).toBeGreaterThan(0.03);
    expect(at(records, 71).inflation).toBeLessThan(0.05);
    expect(at(records, 119).credibility).toBeGreaterThan(at(records, 11).credibility + 0.3);
  });

  it('quantity theory: monetized deficits settle inflation on a higher plateau', () => {
    const records = runScenario(scenario('fiscal-dominance'));
    for (const r of between(records, 48, 180)) {
      expect(r.inflation).toBeGreaterThan(0.08);
      expect(r.inflation).toBeLessThan(0.2);
    }
    expect(at(records, 179).debt).toBeLessThan(0.02); // inflation tax erodes the debt
  });

  it('seigniorage limit: a large monetized deficit turns into hyperinflation', () => {
    const records = runScenario(scenario('hyperinflation'));
    expect(at(records, 47).inflation).toBeGreaterThan(10);
    expect(at(records, 47).credibility).toBeLessThan(0.15);
  });

  it('impossible trinity: cutting rates under a peg works only with capital controls', () => {
    const open = runScenario(scenario('peg-open-capital'));
    const collapse = open.findIndex((r) => r.pegCollapsed);
    expect(collapse).toBeGreaterThanOrEqual(0);
    expect(collapse).toBeLessThan(24);
    // Currency mismatch: the devaluation inflates foreign-currency debt at once.
    expect(at(open, collapse).debt - at(open, collapse - 1).debt).toBeGreaterThan(0.05);

    const closed = runScenario(scenario('peg-closed-capital'));
    expect(closed.some((r) => r.pegCollapsed)).toBe(false);
    expect(at(closed, 59).reserves).toBeGreaterThan(1);
  });

  it('debt spiral: risk premium and debt feed each other', () => {
    const records = runScenario(scenario('debt-spiral'));
    const firstHalf = at(records, 59).debt - at(records, 0).debt;
    const secondHalf = at(records, 119).debt - at(records, 59).debt;
    expect(secondHalf).toBeGreaterThan(2 * firstHalf);
    expect(at(records, 119).riskPremium).toBeGreaterThan(4 * at(records, 11).riskPremium);
  });

  it('Fisher effect and relative PPP: higher target inflation means higher rates and drift', () => {
    const base = scenario('baseline');
    const records = runScenario({
      ...base,
      policy: { ...base.policy, inflationTarget: 0.08 },
      initial: {
        ...base.initial,
        inflation: 0.08,
        adaptiveExpectation: 0.08,
        policyRate: 0.1,
        effectiveDebtRate: 0.11,
      },
    });
    const end = at(records, 119);
    expect(end.inflation).toBeCloseTo(0.08, 6);
    expect(end.policyRate).toBeCloseTo(0.1, 6);
    expect(end.capitalFlow).toBeCloseTo(0, 6);
    expect(Math.log(end.exchangeRate)).toBeCloseTo(10 * 0.05, 6);
  });
});

describe('numerical safety', () => {
  it('rejects parameters outside their documented range', () => {
    expect(() =>
      runScenario(scenario('baseline'), { ...DEFAULT_MACRO_PARAMS, phillipsSlope: 5 }),
    ).toThrow(RangeError);
  });

  it('stays finite and bounded at the extremes of every exchange-rate parameter', () => {
    const extreme = {
      ...DEFAULT_MACRO_PARAMS,
      capitalMobilityOpen: 50,
      floatSensitivity: 50,
      maxCapitalFlow: 0.5,
      realExchangeRateReversion: 2,
    };
    for (const id of ['demand-boom', 'oil-shock-anchored', 'debt-spiral']) {
      for (const r of runScenario(scenario(id), extreme)) {
        expect(Number.isFinite(r.exchangeRate)).toBe(true);
        expect(Math.abs(r.capitalFlow)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(r.currentAccount)).toBeLessThan(0.5);
      }
    }
  });
});
