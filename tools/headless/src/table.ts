import type { MonthRecord } from '@likevictoria/sim';

/** Model rates are continuously compounded; show them as ordinary annual rates. */
function rate(logRate: number): string {
  return share(Math.expm1(logRate));
}
/** A ratio as a percentage; crisis values switch to scientific notation so columns stay aligned. */
function share(x: number): string {
  return Math.abs(x) < 1e3 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toExponential(1)}%`;
}
/** A level stored as a log, printed without overflowing. */
function level(log: number): string {
  return log < 11.5 ? Math.exp(log).toFixed(2) : `e^${log.toFixed(0)}`;
}

type Column = readonly [string, (r: MonthRecord, yearAgo: MonthRecord | undefined) => string];
const COLUMNS: readonly Column[] = [
  ['同比通胀', (r, yearAgo) => (yearAgo ? rate(r.logPriceLevel - yearAgo.logPriceLevel) : '—')],
  ['当月(年化)', (r) => rate(r.inflation)],
  ['预期', (r) => rate(r.expectedInflation)],
  ['信誉', (r) => r.credibility.toFixed(2)],
  ['利率', (r) => rate(r.policyRate)],
  ['实际利率', (r) => rate(r.realRate)],
  ['缺口', (r) => share(r.outputGap)],
  ['经常账户', (r) => share(r.currentAccount)],
  ['资本流动', (r) => share(r.capitalFlow)],
  ['融资缺口', (r) => share(r.financingGap)],
  ['储备(月)', (r) => r.reserves.toFixed(1)],
  ['汇率', (r) => level(r.logExchangeRate)],
  ['债务', (r) => share(r.debt)],
  ['其中外债', (r) => share(r.foreignDebt)],
  ['赤字', (r) => share(r.fiscalDeficit)],
  ['印钞', (r) => share(r.monetizedDeficit)],
  ['风险溢价', (r) => rate(r.riskPremium)],
  ['物价', (r) => level(r.logPriceLevel)],
];
const WIDTH = 11;

/** The table of a scenario run: one row per year, or per month when `monthly` is set. */
export function scenarioTable(records: readonly MonthRecord[], monthly: boolean): string[] {
  const lines = [['时间'.padEnd(8), ...COLUMNS.map(([name]) => name.padStart(WIDTH))].join('')];
  const events: string[] = [];
  for (const [index, record] of records.entries()) {
    if (record.pegCollapsed) events.push('钉住崩溃');
    if (record.defaulted) events.push('违约');
    if (!monthly && record.month % 12 !== 11) continue;
    const label = monthly
      ? `${Math.floor(record.month / 12) + 1}年${(record.month % 12) + 1}月`
      : `第${Math.floor(record.month / 12) + 1}年`;
    const yearAgo = records[index - 12];
    const cells = COLUMNS.map(([, format]) => format(record, yearAgo).padStart(WIDTH));
    const note = events.length > 0 ? `  ← ${events.join('、')}` : '';
    lines.push([label.padEnd(8), ...cells, note].join(''));
    events.length = 0;
  }
  return lines;
}
