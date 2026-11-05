// Macro sandbox: runs the macro block against the demand stand-in and prints the result.
//   pnpm macro                              list scenarios
//   pnpm macro <id> [<id>...]               yearly table (add --monthly for every month)
//   pnpm macro <id> --set phillipsSlope=0.2 override parameters (repeatable)
//   pnpm macro --params                     parameter reference (value, unit, range, meaning)
import { parseArgs } from 'node:util';
import {
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEFAULT_MACRO_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  MACRO_PARAM_SPECS,
  MACRO_SCENARIOS,
  runScenario,
  type MonthRecord,
  type ParamSpecs,
} from '@likevictoria/sim';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    monthly: { type: 'boolean', default: false },
    params: { type: 'boolean', default: false },
    set: { type: 'string', multiple: true, default: [] },
  },
});

/** Applies `name=value` overrides to whichever parameter set defines `name`. */
function withOverrides<T extends { readonly [K in keyof T]: number }>(
  defaults: T,
  specs: ParamSpecs<T>,
  overrides: ReadonlyMap<string, number>,
): T {
  const result: Record<string, number> = { ...defaults };
  for (const [name, value] of overrides) {
    if (Object.hasOwn(specs, name)) result[name] = value;
  }
  return result as T;
}

const overrides = new Map<string, number>();
for (const assignment of values.set) {
  const [name = '', text = '', ...extra] = assignment.split('=');
  const value = Number(text);
  if (!Object.hasOwn(MACRO_PARAM_SPECS, name) && !Object.hasOwn(DEMAND_PROXY_PARAM_SPECS, name)) {
    throw new Error(`未知参数 ${name}；运行 pnpm macro --params 查看全部参数`);
  }
  if (text === '' || extra.length > 0 || !Number.isFinite(value)) {
    throw new Error(`参数 ${name} 的值不是一个数字：${assignment}`);
  }
  overrides.set(name, value);
}
const macroParams = withOverrides(DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, overrides);
const demandParams = withOverrides(
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  overrides,
);

/** Model rates are continuously compounded; show them as ordinary annual rates. */
function rate(logRate: number): string {
  const simple = Math.expm1(logRate);
  return Math.abs(simple) < 1e3
    ? `${(simple * 100).toFixed(1)}%`
    : `${(simple * 100).toExponential(1)}%`;
}
const share = (x: number): string => `${(x * 100).toFixed(1)}%`;
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
const WIDTH = 10;

function printParams<T extends { readonly [K in keyof T]: number }>(
  title: string,
  params: T,
  specs: ParamSpecs<T>,
): void {
  console.log(`\n## ${title}`);
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key];
    console.log(
      `${key.padEnd(32)} ${String(params[key]).padStart(7)}  ${spec.unit}  [${spec.min}, ${spec.max}]  ${spec.meaning}`,
    );
  }
}

function printScenario(id: string): void {
  const scenario = MACRO_SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) {
    throw new Error(`未知场景 ${id}；运行 pnpm macro 查看列表`);
  }
  const records = runScenario(scenario, macroParams, demandParams);
  console.log(`\n## ${scenario.title}（${scenario.id}）\n${scenario.lesson}\n`);
  console.log(['时间'.padEnd(8), ...COLUMNS.map(([name]) => name.padStart(WIDTH))].join(''));
  const events: string[] = [];
  for (const [index, record] of records.entries()) {
    if (record.pegCollapsed) events.push('钉住崩溃');
    if (record.defaulted) events.push('违约');
    const endOfPeriod = values.monthly || record.month % 12 === 11;
    if (!endOfPeriod) continue;
    const label = values.monthly
      ? `${Math.floor(record.month / 12) + 1}年${(record.month % 12) + 1}月`
      : `第${Math.floor(record.month / 12) + 1}年`;
    const yearAgo = records[index - 12];
    const cells = COLUMNS.map(([, format]) => format(record, yearAgo).padStart(WIDTH));
    const note = events.length > 0 ? `  ← ${events.join('、')}` : '';
    console.log([label.padEnd(8), ...cells, note].join(''));
    events.length = 0;
  }
}

if (values.params) {
  printParams('宏观参数', macroParams, MACRO_PARAM_SPECS);
  printParams('需求替身参数', demandParams, DEMAND_PROXY_PARAM_SPECS);
} else if (positionals.length === 0) {
  for (const scenario of MACRO_SCENARIOS) {
    console.log(`${scenario.id.padEnd(22)} ${scenario.title}`);
  }
} else {
  for (const id of positionals) printScenario(id);
}
