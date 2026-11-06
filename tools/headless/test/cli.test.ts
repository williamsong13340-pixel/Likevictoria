import { MACRO_SCENARIOS, runScenario, type MonthRecord } from '@likevictoria/sim';
import { describe, expect, it } from 'vitest';
import { parametersWith } from '../src/overrides.ts';
import { scenarioTable } from '../src/table.ts';

describe('macro sandbox: --set overrides', () => {
  it('applies a valid override to the parameter set that defines it', () => {
    const { macro, demand } = parametersWith(['phillipsSlope=0.2', 'fiscalMultiplier=1.5']);
    expect(macro.phillipsSlope).toBe(0.2);
    expect(demand.fiscalMultiplier).toBe(1.5);
  });

  it.each([
    ['toString=3', '未知参数'], // a name on the prototype chain is not a parameter
    ['noSuchParameter=1', '未知参数'],
    ['phillipsSlope=0.2=9', '不是一个数字'],
    ['phillipsSlope=', '不是一个数字'],
    ['phillipsSlope= ', '不是一个数字'],
    ['phillipsSlope=abc', '不是一个数字'],
    ['phillipsSlope=Infinity', '不是一个数字'],
    ['phillipsSlope=5', '超出范围'],
    ['fiscalMultiplier=5', '超出范围'], // demand stand-in parameters are checked too
  ])('rejects %s', (assignment, message) => {
    expect(() => parametersWith([assignment])).toThrow(message);
  });
});

describe('macro sandbox: table', () => {
  const baseline = MACRO_SCENARIOS.find((s) => s.id === 'baseline');
  if (baseline === undefined) throw new Error('missing baseline scenario');
  const records = runScenario(baseline);
  const columns = (line: string | undefined): string[] => line?.trim().split(/\s+/) ?? [];

  it('shows year-on-year inflation over twelve months, as an ordinary annual rate', () => {
    const lines = scenarioTable(records, false);
    expect(columns(lines[1])[1]).toBe('—'); // no year-ago record in the first year
    expect(columns(lines[2])[1]).toBe(`${(Math.expm1(0.03) * 100).toFixed(1)}%`); // 3.0%
  });

  it('converts continuously compounded rates and keeps extreme values readable', () => {
    const yearEnd = records[11];
    if (yearEnd === undefined) throw new Error('missing record');
    const crisis: MonthRecord = {
      ...yearEnd,
      inflation: Math.log(2),
      debt: 12345,
      logPriceLevel: 40,
    };
    const [header, line] = scenarioTable([crisis], true);
    const row = columns(line);
    const cell = (name: string): string | undefined => row[columns(header).indexOf(name)];
    expect(cell('当月(年化)')).toBe('100.0%'); // ln 2 a year doubles prices
    expect(cell('债务')).toBe('1.2e+6%');
    expect(cell('物价')).toBe('e^40');
  });

  it('shows the planned printing and what is actually printed in their own columns', () => {
    const yearEnd = records[11];
    if (yearEnd === undefined) throw new Error('missing record');
    const [header, line] = scenarioTable(
      [{ ...yearEnd, plannedPrinting: 0.05, monetizedDeficit: 0.02 }],
      true,
    );
    const row = columns(line);
    const cell = (name: string): string | undefined => row[columns(header).indexOf(name)];
    expect(cell('计划印钞')).toBe('5.0%');
    expect(cell('实际印钞')).toBe('2.0%');
  });

  it('marks events in the row of the period they fall in', () => {
    const withDefault = records.map((r) => (r.month === 30 ? { ...r, defaulted: true } : r));
    const lines = scenarioTable(withDefault, false);
    expect(lines[3]).toContain('← 违约');
    expect(lines.filter((line) => line.includes('违约'))).toHaveLength(1);
  });
});
