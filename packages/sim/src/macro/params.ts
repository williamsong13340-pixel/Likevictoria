import type { ParamSpecs } from '../params.ts';

/**
 * Parameters of the monthly macro block. Rates and shares are decimals (0.03 = 3%),
 * rates are annualized, and every adjustment speed is a half-life in months.
 */
export interface MacroParams {
  readonly expectationHalfLifeMonths: number;
  readonly expectationAttention: number;
  readonly credibilityIndependent: number;
  readonly credibilityGovernment: number;
  readonly minCredibility: number;
  readonly credibilityHalfLifeMonths: number;
  readonly inflationMissTolerance: number;
  readonly inflationMissPenalty: number;
  readonly monetizationCredibilityPenalty: number;
  readonly phillipsSlope: number;
  readonly exchangeRatePassThrough: number;
  readonly monetizationInflation: number;
  readonly moneyFlightSemiElasticity: number;
  readonly maxInflation: number;
  readonly neutralRealRate: number;
  readonly ruleInflationWeight: number;
  readonly ruleGapWeight: number;
  readonly policyRateHalfLifeMonths: number;
  readonly policyRateFloor: number;
  readonly capitalMobilityClosed: number;
  readonly capitalMobilityPartial: number;
  readonly capitalMobilityOpen: number;
  readonly maxCapitalFlow: number;
  readonly floatSensitivity: number;
  readonly realExchangeRateReversion: number;
  readonly pegCrisisReserveMonths: number;
  readonly devaluationSize: number;
  readonly safeDebt: number;
  readonly debtPremiumSlope: number;
  readonly safeReserveMonths: number;
  readonly reservePremiumSlope: number;
  readonly termPremium: number;
  readonly debtMaturityMonths: number;
}

export const DEFAULT_MACRO_PARAMS: MacroParams = {
  expectationHalfLifeMonths: 12,
  expectationAttention: 5,
  credibilityIndependent: 0.8,
  credibilityGovernment: 0.3,
  minCredibility: 0.05,
  credibilityHalfLifeMonths: 36,
  inflationMissTolerance: 0.02,
  inflationMissPenalty: 8,
  monetizationCredibilityPenalty: 15,
  phillipsSlope: 0.3,
  exchangeRatePassThrough: 0.5,
  monetizationInflation: 6,
  moneyFlightSemiElasticity: 2,
  maxInflation: 50,
  neutralRealRate: 0.02,
  ruleInflationWeight: 0.5,
  ruleGapWeight: 0.5,
  policyRateHalfLifeMonths: 3,
  policyRateFloor: 0,
  capitalMobilityClosed: 0.2,
  capitalMobilityPartial: 2,
  capitalMobilityOpen: 8,
  maxCapitalFlow: 0.15,
  floatSensitivity: 5,
  realExchangeRateReversion: 0.2,
  pegCrisisReserveMonths: 1,
  devaluationSize: 0.35,
  safeDebt: 0.6,
  debtPremiumSlope: 0.1,
  safeReserveMonths: 3,
  reservePremiumSlope: 0.03,
  termPremium: 0.01,
  debtMaturityMonths: 48,
};

export const MACRO_PARAM_SPECS: ParamSpecs<MacroParams> = {
  expectationHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 60,
    meaning: '适应性预期的记忆：通胀为零时，民众用多久把预期向实际通胀调整一半',
  },
  expectationAttention: {
    unit: '1/通胀',
    min: 0,
    max: 50,
    meaning: '通胀越高，人们越关注物价：预期通胀每高 1.00，预期调整速度提高的倍数',
  },
  credibilityIndependent: {
    unit: '0—1',
    min: 0,
    max: 1,
    meaning: '独立央行的基础信誉：预期在多大程度上锚定在通胀目标上',
  },
  credibilityGovernment: {
    unit: '0—1',
    min: 0,
    max: 1,
    meaning: '政府控制央行时的基础信誉',
  },
  minCredibility: {
    unit: '0—1',
    min: 0.01,
    max: 0.5,
    meaning: '信誉下限：即使信誉扫地，预期仍会部分锚定在货币增长隐含的通胀上',
  },
  credibilityHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 120,
    meaning: '信誉建立或丧失的速度',
  },
  inflationMissTolerance: {
    unit: '比例/年',
    min: 0,
    max: 0.1,
    meaning: '通胀偏离目标多少以内不损害信誉',
  },
  inflationMissPenalty: {
    unit: '信誉/偏离',
    min: 0,
    max: 20,
    meaning: '超出容忍度的通胀偏离每 1.00 降低的目标信誉',
  },
  monetizationCredibilityPenalty: {
    unit: '信誉/(GDP比例)',
    min: 0,
    max: 100,
    meaning: '央行每为相当于 GDP 1.00 的赤字融资所降低的目标信誉',
  },
  phillipsSlope: {
    unit: '通胀/缺口',
    min: 0,
    max: 2,
    meaning: '菲利普斯曲线斜率：产出缺口每 1% 带来的年化通胀（百分点）',
  },
  exchangeRatePassThrough: {
    unit: '比例',
    min: 0,
    max: 1,
    meaning: '汇率传导：进口品价格变动传到通胀的比例（再乘以进口占GDP比重）',
  },
  monetizationInflation: {
    unit: '通胀/(GDP比例)',
    min: 0,
    max: 30,
    meaning: '货币化赤字每占 GDP 1.00 带来的额外货币增长（约等于基础货币/GDP 的倒数）',
  },
  moneyFlightSemiElasticity: {
    unit: '1/通胀',
    min: 0,
    max: 10,
    meaning: '卡甘半弹性：预期通胀越高，人们越不愿持有货币，同样的印钞带来更高通胀',
  },
  maxInflation: {
    unit: '比例/年',
    min: 1,
    max: 1000,
    meaning: '数值安全上限（年化通胀），超过时由游戏触发货币改革事件',
  },
  neutralRealRate: {
    unit: '比例/年',
    min: -0.02,
    max: 0.06,
    meaning: '中性实际利率：既不刺激也不抑制需求的实际利率',
  },
  ruleInflationWeight: {
    unit: '系数',
    min: 0,
    max: 3,
    meaning: '利率规则对通胀偏离的额外反应（大于0即满足泰勒原则）',
  },
  ruleGapWeight: {
    unit: '系数',
    min: 0,
    max: 3,
    meaning: '利率规则对产出缺口的反应',
  },
  policyRateHalfLifeMonths: {
    unit: '月',
    min: 0.5,
    max: 24,
    meaning: '央行调整利率的平滑程度',
  },
  policyRateFloor: {
    unit: '比例/年',
    min: -0.02,
    max: 0.02,
    meaning: '政策利率下限（零利率下限）',
  },
  capitalMobilityClosed: {
    unit: 'GDP比例/利差',
    min: 0,
    max: 50,
    meaning: '资本管制严格时，每 1.00 利差引起的年资本流动（占GDP）',
  },
  capitalMobilityPartial: {
    unit: 'GDP比例/利差',
    min: 0,
    max: 50,
    meaning: '资本账户部分开放时的资本流动敏感度',
  },
  capitalMobilityOpen: {
    unit: 'GDP比例/利差',
    min: 0,
    max: 50,
    meaning: '资本账户完全开放时的资本流动敏感度',
  },
  maxCapitalFlow: {
    unit: 'GDP比例/年',
    min: 0.01,
    max: 0.5,
    meaning: '资本流动的饱和上限：一年内流入或流出最多占 GDP 的比例（突然停止的规模）',
  },
  floatSensitivity: {
    unit: '贬值/(GDP比例)',
    min: 0,
    max: 50,
    meaning: '浮动汇率下，国际收支压力每占 GDP 1.00 带来的年化贬值（对数）',
  },
  realExchangeRateReversion: {
    unit: '1/年',
    min: 0.05,
    max: 2,
    meaning:
      '市场预期实际汇率每年回归均衡的比例（约 0.2 对应 3—4 年的购买力平价半衰期）；它让浮动汇率超调后停住',
  },
  pegCrisisReserveMonths: {
    unit: '月进口额',
    min: 0,
    max: 6,
    meaning: '外汇储备低于多少个月进口额时，钉住汇率崩溃',
  },
  devaluationSize: {
    unit: '对数',
    min: 0,
    max: 2,
    meaning: '钉住汇率崩溃时的一次性贬值幅度',
  },
  safeDebt: {
    unit: 'GDP比例',
    min: 0,
    max: 3,
    meaning: '政府债务低于此水平时没有债务风险溢价',
  },
  debtPremiumSlope: {
    unit: '利率/债务²',
    min: 0,
    max: 1,
    meaning: '债务风险溢价的凸性：溢价 = 斜率 ×（债务 − 安全水平）²',
  },
  safeReserveMonths: {
    unit: '月进口额',
    min: 0.5,
    max: 12,
    meaning: '外汇储备高于此水平时没有储备风险溢价',
  },
  reservePremiumSlope: {
    unit: '比例/年',
    min: 0,
    max: 0.2,
    meaning: '储备耗尽时的最大风险溢价',
  },
  termPremium: {
    unit: '比例/年',
    min: 0,
    max: 0.05,
    meaning: '国债相对政策利率的期限溢价',
  },
  debtMaturityMonths: {
    unit: '月',
    min: 1,
    max: 240,
    meaning: '国债平均期限：市场利率变化传到债务平均利率的半衰期',
  },
};
