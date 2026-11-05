// Macro sandbox: runs the macro block against the demand stand-in and prints the result.
//   pnpm macro                      list scenarios
//   pnpm macro <id> [<id>...]       yearly table (add --monthly for every month)
//   pnpm macro --params             parameter reference (value, unit, range, meaning)
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
  },
});

const pct = (x: number): string =>
  Math.abs(x) < 1e3 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toExponential(1)}%`;
const num = (x: number): string => (Math.abs(x) < 1e5 ? x.toFixed(2) : x.toExponential(1));

// Year-on-year inflation is computed from the price level; the monthly rate is annualized.
type Column = readonly [string, (r: MonthRecord, yearAgo: MonthRecord | undefined) => string];
const COLUMNS: readonly Column[] = [
  ['同比通胀', (r, yearAgo) => (yearAgo ? pct(r.priceLevel / yearAgo.priceLevel - 1) : '—')],
  ['月度年化', (r) => pct(r.inflation)],
  ['预期', (r) => pct(r.expectedInflation)],
  ['信誉', (r) => num(r.credibility)],
  ['利率', (r) => pct(r.policyRate)],
  ['实际利率', (r) => pct(r.realRate)],
  ['缺口', (r) => pct(r.outputGap)],
  ['经常账户', (r) => pct(r.currentAccount)],
  ['资本流动', (r) => pct(r.capitalFlow)],
  ['储备(月)', (r) => r.reserves.toFixed(1)],
  ['汇率', (r) => num(r.exchangeRate)],
  ['债务', (r) => pct(r.debt)],
  ['赤字', (r) => pct(r.fiscalDeficit)],
  ['印钞', (r) => pct(r.monetizedDeficit)],
  ['风险溢价', (r) => pct(r.riskPremium)],
  ['物价', (r) => num(r.priceLevel)],
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
  const records = runScenario(scenario);
  console.log(`\n## ${scenario.title}（${scenario.id}）\n${scenario.lesson}\n`);
  console.log(['时间'.padEnd(8), ...COLUMNS.map(([name]) => name.padStart(WIDTH))].join(''));
  let collapsedThisPeriod = false;
  for (const [index, record] of records.entries()) {
    collapsedThisPeriod ||= record.pegCollapsed;
    const endOfPeriod = values.monthly || record.month % 12 === 11;
    if (!endOfPeriod) continue;
    const label = values.monthly
      ? `${Math.floor(record.month / 12) + 1}年${(record.month % 12) + 1}月`
      : `第${Math.floor(record.month / 12) + 1}年`;
    const yearAgo = records[index - 12];
    const cells = COLUMNS.map(([, format]) => format(record, yearAgo).padStart(WIDTH));
    console.log([label.padEnd(8), ...cells, collapsedThisPeriod ? '  ← 钉住崩溃' : ''].join(''));
    collapsedThisPeriod = false;
  }
}

if (values.params) {
  printParams('宏观参数', DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS);
  printParams('需求替身参数', DEFAULT_DEMAND_PROXY_PARAMS, DEMAND_PROXY_PARAM_SPECS);
} else if (positionals.length === 0) {
  for (const scenario of MACRO_SCENARIOS) {
    console.log(`${scenario.id.padEnd(22)} ${scenario.title}`);
  }
} else {
  for (const id of positionals) printScenario(id);
}
