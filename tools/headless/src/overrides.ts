import {
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEFAULT_MACRO_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  MACRO_PARAM_SPECS,
  validateParams,
  type ParamSpecs,
} from '@likevictoria/sim';

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

/**
 * Both parameter sets after `--set name=value` overrides. Throws on an unknown name, on a value
 * that is not a number, and on a value outside the parameter's documented range.
 */
export function parametersWith(assignments: readonly string[]): {
  readonly macro: typeof DEFAULT_MACRO_PARAMS;
  readonly demand: typeof DEFAULT_DEMAND_PROXY_PARAMS;
} {
  const overrides = new Map<string, number>();
  for (const assignment of assignments) {
    const [name = '', text = '', ...extra] = assignment.split('=');
    if (!Object.hasOwn(MACRO_PARAM_SPECS, name) && !Object.hasOwn(DEMAND_PROXY_PARAM_SPECS, name)) {
      throw new Error(`未知参数 ${name}；运行 pnpm macro --params 查看全部参数`);
    }
    const value = Number(text);
    if (text.trim() === '' || extra.length > 0 || !Number.isFinite(value)) {
      throw new Error(`参数 ${name} 的值不是一个数字：${assignment}`);
    }
    overrides.set(name, value);
  }
  const macro = withOverrides(DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, overrides);
  const demand = withOverrides(DEFAULT_DEMAND_PROXY_PARAMS, DEMAND_PROXY_PARAM_SPECS, overrides);
  validateParams(macro, MACRO_PARAM_SPECS);
  validateParams(demand, DEMAND_PROXY_PARAM_SPECS);
  return { macro, demand };
}
