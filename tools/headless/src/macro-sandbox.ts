// Macro sandbox: runs the macro block against the demand stand-in and prints the result.
//   pnpm macro                              list scenarios
//   pnpm macro <id> [<id>...]               yearly table (add --monthly for every month)
//   pnpm macro <id> --set phillipsSlope=0.2 override parameters (repeatable)
//   pnpm macro --params                     parameter reference (value, unit, range, meaning)
import { parseArgs } from 'node:util';
import {
  DEMAND_PROXY_PARAM_SPECS,
  MACRO_PARAM_SPECS,
  MACRO_SCENARIOS,
  POLICY_LIMITS,
  runScenario,
  type ParamSpecs,
} from '@likevictoria/sim';
import { parametersWith } from './overrides.ts';
import { scenarioTable } from './table.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    monthly: { type: 'boolean', default: false },
    params: { type: 'boolean', default: false },
    set: { type: 'string', multiple: true, default: [] },
  },
});
const params = parametersWith(values.set);

function printParams<T>(
  title: string,
  specs: ParamSpecs<T>,
  current?: { readonly [K in keyof T]: number },
): void {
  console.log(`\n## ${title}`);
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const spec = specs[key];
    const value = current === undefined ? '' : String(current[key]);
    console.log(
      `${key.padEnd(32)} ${value.padStart(7)}  ${spec.unit}  [${spec.min}, ${spec.max}]  ${spec.meaning}`,
    );
  }
}

function printScenario(id: string): void {
  const scenario = MACRO_SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) {
    throw new Error(`未知场景 ${id}；运行 pnpm macro 查看列表`);
  }
  const records = runScenario(scenario, params.macro, params.demand);
  console.log(`\n## ${scenario.title}（${scenario.id}）\n${scenario.lesson}\n`);
  for (const line of scenarioTable(records, values.monthly)) console.log(line);
}

if (values.params) {
  printParams('宏观参数', MACRO_PARAM_SPECS, params.macro);
  printParams('需求替身参数', DEMAND_PROXY_PARAM_SPECS, params.demand);
  printParams('政策数值的范围（由法律决定）', POLICY_LIMITS);
} else if (positionals.length === 0) {
  for (const scenario of MACRO_SCENARIOS) {
    console.log(`${scenario.id.padEnd(22)} ${scenario.title}`);
  }
} else {
  for (const id of positionals) printScenario(id);
}
