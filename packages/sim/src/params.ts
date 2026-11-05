/** Documentation and valid range of one tunable parameter. */
interface ParamSpec {
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly meaning: string;
}

export type ParamSpecs<T> = { readonly [K in keyof T]: ParamSpec };

/** Throws if a parameter is not finite or lies outside its documented range. */
export function validateParams<T extends { readonly [K in keyof T]: number }>(
  params: T,
  specs: ParamSpecs<T>,
): void {
  for (const key of Object.keys(specs) as (keyof T & string)[]) {
    const value = params[key];
    const spec = specs[key];
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
      throw new RangeError(
        `参数 ${key} = ${String(value)} 超出范围 [${spec.min}, ${spec.max}]：${spec.meaning}`,
      );
    }
  }
}
