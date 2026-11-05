import type { ParamSpecs } from '../params.ts';

/**
 * Parameters of the monthly macro block. Rates are continuously compounded annual rates
 * (0.03 ≈ 3% a year), shares are fractions of GDP, and adjustment speeds are half-lives.
 * Every range below is numerically safe: a property test samples all of them at random and
 * runs every scenario for a hundred years.
 */
export interface MacroParams {
  readonly expectationHalfLifeMonths: number;
  readonly expectationAttention: number;
  readonly minCredibility: number;
  readonly credibilityHalfLifeMonths: number;
  readonly inflationMissTolerance: number;
  readonly inflationMissPenalty: number;
  readonly monetizationCredibilityPenalty: number;
  readonly phillipsSlope: number;
  readonly exchangeRatePassThrough: number;
  readonly passThroughHalfLifeMonths: number;
  readonly monetizationInflation: number;
  readonly moneyFlightSemiElasticity: number;
  readonly minMoneyDemand: number;
  readonly minInflation: number;
  readonly maxInflation: number;
  readonly neutralRealRate: number;
  readonly ruleInflationWeight: number;
  readonly ruleGapWeight: number;
  readonly maxRuleAdjustment: number;
  readonly policyRateHalfLifeMonths: number;
  readonly policyRateFloor: number;
  readonly reserveDefenseWeight: number;
  readonly maxCapitalFlow: number;
  readonly floatSensitivity: number;
  readonly realExchangeRateHalfLifeYears: number;
  readonly maxRealExchangeRateDeviation: number;
  readonly pegCrisisReserveMonths: number;
  readonly devaluationSize: number;
  readonly safeDebt: number;
  readonly debtPremiumSlope: number;
  readonly safeReserveMonths: number;
  readonly reservePremiumSlope: number;
  readonly maxRiskPremium: number;
  readonly termPremium: number;
  readonly debtRepricingHalfLifeMonths: number;
  readonly defaultDebtThreshold: number;
  readonly defaultHaircut: number;
  readonly marketExclusionMonths: number;
  readonly defaultReputationPremium: number;
  readonly reputationHalfLifeMonths: number;
}

export const DEFAULT_MACRO_PARAMS: MacroParams = {
  expectationHalfLifeMonths: 12,
  expectationAttention: 5,
  minCredibility: 0.05,
  credibilityHalfLifeMonths: 36,
  inflationMissTolerance: 0.02,
  inflationMissPenalty: 8,
  monetizationCredibilityPenalty: 15,
  phillipsSlope: 0.3,
  exchangeRatePassThrough: 0.5,
  passThroughHalfLifeMonths: 3,
  monetizationInflation: 6,
  moneyFlightSemiElasticity: 2,
  minMoneyDemand: 0.02,
  minInflation: -0.2,
  maxInflation: 20,
  neutralRealRate: 0.02,
  ruleInflationWeight: 0.5,
  ruleGapWeight: 0.5,
  maxRuleAdjustment: 0.1,
  policyRateHalfLifeMonths: 3,
  policyRateFloor: 0,
  reserveDefenseWeight: 0.5,
  maxCapitalFlow: 0.15,
  floatSensitivity: 5,
  realExchangeRateHalfLifeYears: 3.5,
  maxRealExchangeRateDeviation: 1.5,
  pegCrisisReserveMonths: 1,
  devaluationSize: 0.35,
  safeDebt: 0.6,
  debtPremiumSlope: 0.1,
  safeReserveMonths: 3,
  reservePremiumSlope: 0.03,
  maxRiskPremium: 0.25,
  termPremium: 0.01,
  debtRepricingHalfLifeMonths: 36,
  defaultDebtThreshold: 2,
  defaultHaircut: 0.5,
  marketExclusionMonths: 36,
  defaultReputationPremium: 0.08,
  reputationHalfLifeMonths: 36,
};

export const MACRO_PARAM_SPECS: ParamSpecs<MacroParams> = {
  expectationHalfLifeMonths: {
    unit: '月',
    min: 3,
    max: 60,
    meaning: '适应性预期的记忆：通胀为零时，民众用多久把预期向实际通胀调整一半',
  },
  expectationAttention: {
    unit: '1/通胀',
    min: 0,
    max: 50,
    meaning: '通胀越高，人们越关注物价：记忆中的通胀每高 1.00，预期调整速度提高的倍数',
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
    meaning: '信誉建立或丧失的半衰期',
  },
  inflationMissTolerance: {
    unit: '年率',
    min: 0,
    max: 0.1,
    meaning: '记忆中的通胀偏离目标多少以内不损害信誉',
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
    max: 1,
    meaning: '菲利普斯曲线斜率：产出缺口每 1% 带来多少个百分点的年通胀',
  },
  exchangeRatePassThrough: {
    unit: '比例',
    min: 0,
    max: 1,
    meaning: '汇率传导：进口品实际价格变动传到消费物价的比例（再乘以进口占 GDP 的比重）',
  },
  passThroughHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 24,
    meaning: '汇率传导的半衰期：进口价格变化需要多久才有一半传到消费物价',
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
  minMoneyDemand: {
    unit: '比例',
    min: 0.005,
    max: 0.2,
    meaning:
      '无论通胀多高，人们仍会持有的实际货币量（相对正常水平）：只有大量印钞才能维持恶性通胀，零星印钞不能',
  },
  minInflation: {
    unit: '年率',
    min: -0.5,
    max: 0,
    meaning: '通缩下限（数值安全）',
  },
  maxInflation: {
    unit: '年率（对数）',
    min: 1,
    max: 20,
    meaning: '通胀上限（数值安全），20 约等于物价每年上涨 4.85 亿倍；货币改革事件实现之前只做截断',
  },
  neutralRealRate: {
    unit: '年率',
    min: -0.02,
    max: 0.06,
    meaning: '中性实际利率：既不刺激也不抑制需求的实际利率',
  },
  ruleInflationWeight: {
    unit: '系数',
    min: 0,
    max: 3,
    meaning: '利率规则对预期通胀偏离目标的反应（大于 0 即满足泰勒原则）',
  },
  ruleGapWeight: {
    unit: '系数',
    min: 0,
    max: 1.5,
    meaning: '利率规则对产出缺口的反应',
  },
  maxRuleAdjustment: {
    unit: '年率',
    min: 0.01,
    max: 0.3,
    meaning: '利率规则把实际利率推离中性水平的最大幅度',
  },
  policyRateHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 24,
    meaning: '央行调整利率的平滑程度',
  },
  policyRateFloor: {
    unit: '年率',
    min: -0.02,
    max: 0.02,
    meaning: '政策利率下限（零利率下限）',
  },
  reserveDefenseWeight: {
    unit: '系数',
    min: 0,
    max: 10,
    meaning: '固定或管理汇率下，央行保卫储备的意愿：资本越自由，利率越要跟随锚货币',
  },
  maxCapitalFlow: {
    unit: 'GDP比例/年',
    min: 0.01,
    max: 0.5,
    meaning: '资本流动的饱和上限：一年内流入或流出最多占 GDP 的比例（突然停止的规模）',
  },
  floatSensitivity: {
    unit: '贬值/(GDP比例)',
    min: 0.5,
    max: 20,
    meaning: '浮动汇率下，国际收支压力每占 GDP 1.00 带来的年化实际贬值（对数）',
  },
  realExchangeRateHalfLifeYears: {
    unit: '年',
    min: 0.5,
    max: 20,
    meaning: '购买力平价半衰期：市场预期实际汇率偏离均衡后多久回归一半，它让浮动汇率超调后停住',
  },
  maxRealExchangeRateDeviation: {
    unit: '对数',
    min: 0.5,
    max: 1.5,
    meaning:
      '实际汇率偏离均衡的上限（1.5 约为 4.5 倍）：超过之后人们改用外币，而不是继续抛售本币资产',
  },
  pegCrisisReserveMonths: {
    unit: '月进口额',
    min: 0.25,
    max: 2,
    meaning: '外汇储备降到多少个月进口额时，钉住汇率崩溃',
  },
  devaluationSize: {
    unit: '对数',
    min: 0,
    max: 2,
    meaning: '钉住汇率崩溃时的一次性贬值幅度（0.35 约为 42%）',
  },
  safeDebt: {
    unit: 'GDP比例',
    min: 0,
    max: 1.5,
    meaning: '政府债务低于此水平时没有债务风险溢价（范围与违约阈值不重叠）',
  },
  debtPremiumSlope: {
    unit: '利率/债务²',
    min: 0,
    max: 0.5,
    meaning: '债务风险溢价的凸性：溢价 = 斜率 ×（债务 − 安全水平）²，再经饱和',
  },
  safeReserveMonths: {
    unit: '月进口额',
    min: 2,
    max: 12,
    meaning: '外汇储备高于此水平时没有储备风险溢价',
  },
  reservePremiumSlope: {
    unit: '年率',
    min: 0,
    max: 0.2,
    meaning: '储备耗尽时的储备风险溢价',
  },
  maxRiskPremium: {
    unit: '年率',
    min: 0.02,
    max: 0.5,
    meaning: '风险溢价的饱和上限',
  },
  termPremium: {
    unit: '年率',
    min: 0,
    max: 0.05,
    meaning: '国债相对政策利率的期限溢价',
  },
  debtRepricingHalfLifeMonths: {
    unit: '月',
    min: 1,
    max: 240,
    meaning: '国债平均利率向市场利率调整的半衰期（约等于平均期限 × 0.7）',
  },
  defaultDebtThreshold: {
    unit: 'GDP比例',
    min: 1.5,
    max: 5,
    meaning: '政府债务超过此水平时违约',
  },
  defaultHaircut: {
    unit: '比例',
    min: 0.3,
    max: 0.9,
    meaning: '违约重组时的减记比例：债务被减到"阈值 ×（1 − 比例）"',
  },
  marketExclusionMonths: {
    unit: '月',
    min: 6,
    max: 120,
    meaning:
      '违约后无法借款的时长：期间基本赤字只能靠印钞弥补，重组后的债务不再随市场利率重新定价，外国资本不进入，也不会再次违约',
  },
  defaultReputationPremium: {
    unit: '年率',
    min: 0,
    max: 0.3,
    meaning: '违约刚发生时的声誉溢价：市场重新开放后，借钱仍比违约前贵',
  },
  reputationHalfLifeMonths: {
    unit: '月',
    min: 6,
    max: 240,
    meaning: '违约的声誉溢价每过多少个月减半',
  },
};
