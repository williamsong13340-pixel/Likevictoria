import { approach, logCosh } from '../math.ts';
import type { ParamSpecs } from '../params.ts';

/**
 * Reduced-form stand-in for the real economy: an IS curve for the output gap and a
 * current-account equation. In the full game these come from buildings, pops and trade;
 * the stand-in drives the macro sandbox and, later, the advisors' quick forecasts.
 */
export interface DemandProxyParams {
  readonly gapHalfLifeMonths: number;
  readonly maxOutputGap: number;
  readonly realRateSensitivity: number;
  readonly realRateSaturation: number;
  readonly fiscalMultiplier: number;
  readonly supplyShockOutputLoss: number;
  readonly inflationOutputCost: number;
  readonly importPropensity: number;
  readonly tradeElasticity: number;
  readonly maxCurrentAccount: number;
}

export const DEFAULT_DEMAND_PROXY_PARAMS: DemandProxyParams = {
  gapHalfLifeMonths: 6,
  maxOutputGap: 0.12,
  realRateSensitivity: 0.5,
  realRateSaturation: 0.1,
  fiscalMultiplier: 0.8,
  supplyShockOutputLoss: 0.3,
  inflationOutputCost: 0.05,
  importPropensity: 0.3,
  tradeElasticity: 0.2,
  maxCurrentAccount: 0.15,
};

export const DEMAND_PROXY_PARAM_SPECS: ParamSpecs<DemandProxyParams> = {
  gapHalfLifeMonths: {
    unit: '月',
    min: 2,
    max: 36,
    meaning: '产出缺口向目标值收敛的半衰期',
  },
  maxOutputGap: {
    unit: 'GDP比例',
    min: 0.02,
    max: 0.5,
    meaning: '产出偏离潜在水平的饱和上限：产能有限，需求再强也不能让经济无限过热',
  },
  realRateSensitivity: {
    unit: '缺口/利率',
    min: 0,
    max: 1.5,
    meaning:
      '私人借贷成本（实际利率 + 风险溢价）每高于中性利率 1 个百分点，产出缺口下降多少个百分点',
  },
  realRateSaturation: {
    unit: '年率',
    min: 0.02,
    max: 0.3,
    meaning:
      '实际借贷成本偏离中性超过这个幅度后，对需求的影响不再增加（例如恶性通胀时极负的实际利率不会无限刺激需求）',
  },
  fiscalMultiplier: {
    unit: '缺口/(GDP比例)',
    min: 0,
    max: 3,
    meaning: '财政乘数：基本赤字每占 GDP 1%，产出缺口上升多少个百分点',
  },
  supplyShockOutputLoss: {
    unit: '缺口/通胀冲击',
    min: 0,
    max: 2,
    meaning: '成本冲击（如油价）每带来 1 个百分点通胀，产出缺口下降多少个百分点',
  },
  inflationOutputCost: {
    unit: '缺口/通胀偏离',
    min: 0.02,
    max: 1,
    meaning:
      '通胀偏离目标的产出代价（扭曲价格信号、破坏合同）：小偏离时约为 系数 × 偏离²/2，大偏离时约为 系数 × 偏离',
  },
  importPropensity: {
    unit: '经常账户/缺口',
    min: 0,
    max: 2,
    meaning: '经济过热时进口增加：缺口每 1%，经常账户恶化多少（占GDP）',
  },
  tradeElasticity: {
    unit: '经常账户/实际贬值',
    min: 0,
    max: 0.5,
    meaning: '实际贬值每 1%，经常账户改善多少（占GDP）',
  },
  maxCurrentAccount: {
    unit: 'GDP比例',
    min: 0.02,
    max: 0.5,
    meaning: '经常账户的饱和上限（占GDP）',
  },
};

export interface DemandProxyState {
  readonly outputGap: number;
  readonly currentAccount: number;
  /** Local response of the current account to the real exchange rate, for the FX solve. */
  readonly currentAccountSensitivity: number;
}

export interface DemandProxyDrivers {
  readonly realRate: number;
  readonly riskPremium: number;
  readonly neutralRealRate: number;
  readonly primaryBalance: number;
  readonly costPush: number;
  readonly demandShock: number;
  readonly inflation: number;
  readonly inflationTarget: number;
  /** Log real exchange rate relative to equilibrium; positive means undervalued. */
  readonly realExchangeRate: number;
}

/** Current account for a given output gap and real exchange rate, with its local slope. */
export function currentAccountAt(
  outputGap: number,
  realExchangeRate: number,
  p: DemandProxyParams,
): DemandProxyState {
  const pressure = Math.tanh(
    (-p.importPropensity * outputGap + p.tradeElasticity * realExchangeRate) / p.maxCurrentAccount,
  );
  return {
    outputGap,
    currentAccount: p.maxCurrentAccount * pressure,
    currentAccountSensitivity: p.tradeElasticity * (1 - pressure * pressure),
  };
}

export function stepDemandProxy(
  state: DemandProxyState,
  d: DemandProxyDrivers,
  p: DemandProxyParams,
): DemandProxyState {
  // Private borrowers pay the sovereign risk premium too; the rate channel saturates, and
  // inflation away from target costs output with a bounded slope.
  const borrowingCost = d.realRate + d.riskPremium - d.neutralRealRate;
  const impulse =
    -p.realRateSensitivity *
      p.realRateSaturation *
      Math.tanh(borrowingCost / p.realRateSaturation) -
    p.fiscalMultiplier * d.primaryBalance -
    p.supplyShockOutputLoss * d.costPush -
    p.inflationOutputCost * logCosh(d.inflation - d.inflationTarget) +
    d.demandShock;
  const gapTarget = p.maxOutputGap * Math.tanh(impulse / p.maxOutputGap);
  const outputGap = approach(state.outputGap, gapTarget, p.gapHalfLifeMonths);
  return currentAccountAt(outputGap, d.realExchangeRate, p);
}
