import { approach } from '../math.ts';
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
  readonly fiscalMultiplier: number;
  readonly supplyShockOutputLoss: number;
  readonly importPropensity: number;
  readonly tradeElasticity: number;
}

export const DEFAULT_DEMAND_PROXY_PARAMS: DemandProxyParams = {
  gapHalfLifeMonths: 6,
  maxOutputGap: 0.12,
  realRateSensitivity: 0.5,
  fiscalMultiplier: 0.8,
  supplyShockOutputLoss: 0.3,
  importPropensity: 0.3,
  tradeElasticity: 0.2,
};

export const DEMAND_PROXY_PARAM_SPECS: ParamSpecs<DemandProxyParams> = {
  gapHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 36,
    meaning: '产出缺口向目标值收敛的半衰期',
  },
  maxOutputGap: {
    unit: 'GDP比例',
    min: 0.02,
    max: 0.5,
    meaning: '产出偏离潜在水平的饱和上限：产能有限，再负的实际利率也不能让经济无限过热',
  },
  realRateSensitivity: {
    unit: '缺口/利率',
    min: 0,
    max: 3,
    meaning: '实际利率每高于中性利率 1 个百分点，产出缺口下降多少个百分点',
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
  importPropensity: {
    unit: '经常账户/缺口',
    min: 0,
    max: 2,
    meaning: '经济过热时进口增加：缺口每 1%，经常账户恶化多少（占GDP）',
  },
  tradeElasticity: {
    unit: '经常账户/实际贬值',
    min: 0,
    max: 2,
    meaning: '实际贬值每 1%，经常账户改善多少（占GDP）',
  },
};

export interface DemandProxyState {
  readonly outputGap: number;
  readonly currentAccount: number;
}

export interface DemandProxyDrivers {
  readonly realRate: number;
  readonly neutralRealRate: number;
  readonly primaryBalance: number;
  readonly costPush: number;
  readonly demandShock: number;
  /** Log real exchange rate relative to equilibrium; positive means undervalued. */
  readonly realExchangeRate: number;
  readonly baselineCurrentAccount: number;
}

export function stepDemandProxy(
  state: DemandProxyState,
  d: DemandProxyDrivers,
  p: DemandProxyParams,
): DemandProxyState {
  const demandImpulse =
    -p.realRateSensitivity * (d.realRate - d.neutralRealRate) -
    p.fiscalMultiplier * d.primaryBalance -
    p.supplyShockOutputLoss * d.costPush +
    d.demandShock;
  const gapTarget = p.maxOutputGap * Math.tanh(demandImpulse / p.maxOutputGap);
  const outputGap = approach(state.outputGap, gapTarget, p.gapHalfLifeMonths);
  const currentAccount =
    d.baselineCurrentAccount -
    p.importPropensity * outputGap +
    p.tradeElasticity * d.realExchangeRate;
  return { outputGap, currentAccount };
}
