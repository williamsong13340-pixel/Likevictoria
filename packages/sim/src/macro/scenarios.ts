import type { MacroPolicy, MacroState } from './model.ts';
import type { MacroScenario } from './sandbox.ts';

const STEADY_STATE: MacroState = {
  inflation: 0.03,
  adaptiveExpectation: 0.03,
  credibility: 0.8,
  policyRate: 0.05,
  logExchangeRate: 0,
  realExchangeRate: 0,
  lastRealDepreciation: 0,
  reserves: 6,
  debt: 0.5,
  foreignCurrencyDebtShare: 0,
  effectiveDebtRate: 0.06,
  priceLevel: 1,
};

const INDEPENDENT_FLOAT: MacroPolicy = {
  exchangeRegime: 'float',
  capitalAccount: 'open',
  independentCentralBank: true,
  inflationTarget: 0.03,
  governmentRate: 0.05,
  primaryBalance: 0,
  monetizedShare: 0,
};

const BASELINE: MacroScenario = {
  id: 'baseline',
  title: '稳态',
  lesson: '没有冲击时，通胀停在目标、产出缺口为零、债务率稳定：模型自身不会漂移。',
  months: 120,
  initial: STEADY_STATE,
  initialOutputGap: 0,
  policy: INDEPENDENT_FLOAT,
  policyChanges: [],
  shocks: [],
  anchorRate: 0.05,
  anchorInflation: 0.03,
  potentialGrowth: 0.03,
  importShare: 0.25,
  baselineCurrentAccount: 0,
  politicalRiskPremium: 0,
};

const OIL_SHOCK = [{ fromMonth: 0, untilMonth: 12, costPush: 0.08 }];

const PEG_BELOW_ANCHOR: MacroPolicy = {
  ...INDEPENDENT_FLOAT,
  exchangeRegime: 'peg',
  independentCentralBank: false,
  governmentRate: 0.02,
};

export const MACRO_SCENARIOS: readonly MacroScenario[] = [
  BASELINE,
  {
    ...BASELINE,
    id: 'demand-boom',
    title: '财政扩张',
    lesson:
      '基本赤字占 GDP 5%、持续 3 年：产出缺口转正，通胀升破目标，央行加息（菲利普斯曲线、泰勒规则）；扩张结束后回落。',
    months: 96,
    policy: { ...INDEPENDENT_FLOAT, primaryBalance: -0.05 },
    policyChanges: [{ month: 36, policy: { primaryBalance: 0 } }],
  },
  {
    ...BASELINE,
    id: 'oil-shock-anchored',
    title: '石油冲击：预期稳定',
    lesson: '一年的成本冲击带来滞胀（通胀上升、产出下降），但独立央行的信誉让通胀很快回到目标。',
    months: 96,
    shocks: OIL_SHOCK,
  },
  {
    ...BASELINE,
    id: 'oil-shock-unanchored',
    title: '石油冲击：预期失锚',
    lesson:
      '同样的冲击，但政府控制央行、利率不动：预期随通胀上升，实际利率转负，八年后通胀仍在 9%—10% 并缓慢加速（预期失锚、违反泰勒原则）。',
    months: 96,
    initial: { ...STEADY_STATE, credibility: 0.3 },
    policy: { ...INDEPENDENT_FLOAT, independentCentralBank: false },
    shocks: OIL_SHOCK,
  },
  {
    ...BASELINE,
    id: 'disinflation',
    title: '反通胀',
    lesson:
      '高通胀下改为独立央行：大幅加息、实际利率转正，先经历衰退，通胀随后下降，信誉逐步重建（反通胀的代价）。',
    months: 120,
    initial: {
      ...STEADY_STATE,
      inflation: 0.12,
      adaptiveExpectation: 0.12,
      credibility: 0.05,
      policyRate: 0.1,
      effectiveDebtRate: 0.1,
    },
    policy: { ...INDEPENDENT_FLOAT, independentCentralBank: false, governmentRate: 0.1 },
    policyChanges: [{ month: 12, policy: { independentCentralBank: true } }],
  },
  {
    ...BASELINE,
    id: 'fiscal-dominance',
    title: '财政主导：温和印钞',
    lesson:
      '央行被迫为约 1.5% GDP 的赤字印钞：即使大幅加息，通胀仍停在 10%—15%，加息只换来衰退（财政主导、货币数量论）；高通胀同时把政府债务稀释掉（通胀税）。',
    months: 180,
    initial: { ...STEADY_STATE, debt: 0.1 },
    policy: { ...INDEPENDENT_FLOAT, primaryBalance: -0.01, monetizedShare: 1 },
  },
  {
    ...BASELINE,
    id: 'hyperinflation',
    title: '恶性通胀',
    lesson:
      '为 6% GDP 的赤字全额印钞并压低利率：超过铸币税上限后，通胀自我加速，信誉崩溃（恶性通胀）。',
    months: 60,
    initial: { ...STEADY_STATE, debt: 0.2, credibility: 0.3 },
    policy: {
      ...INDEPENDENT_FLOAT,
      independentCentralBank: false,
      primaryBalance: -0.06,
      monetizedShare: 1,
    },
  },
  {
    ...BASELINE,
    id: 'peg-open-capital',
    title: '钉住汇率 + 资本开放 + 自主降息',
    lesson:
      '钉住汇率时把利率压到锚货币以下 3 个百分点：资本外流耗尽储备，钉住崩溃、一次性大幅贬值，外币债务随之膨胀（不可能三角、货币错配）。',
    months: 60,
    initial: { ...STEADY_STATE, foreignCurrencyDebtShare: 0.4 },
    policy: PEG_BELOW_ANCHOR,
  },
  {
    ...BASELINE,
    id: 'peg-closed-capital',
    title: '钉住汇率 + 资本管制 + 自主降息',
    lesson:
      '同样的降息，但资本账户关闭：外流很小，钉住可以维持很多年（资本管制换来货币政策自主）。',
    months: 60,
    initial: { ...STEADY_STATE, foreignCurrencyDebtShare: 0.4 },
    policy: { ...PEG_BELOW_ANCHOR, capitalAccount: 'closed' },
  },
  {
    ...BASELINE,
    id: 'debt-spiral',
    title: '债务螺旋',
    lesson:
      '高债务 + 基本赤字 + 政治风险：风险溢价随债务凸性上升，资本外流使本币贬值、外币债务膨胀，利息负担推高赤字，债务率加速上升。',
    months: 120,
    initial: { ...STEADY_STATE, debt: 1.0, foreignCurrencyDebtShare: 0.3 },
    policy: { ...INDEPENDENT_FLOAT, primaryBalance: -0.03 },
    politicalRiskPremium: 0.02,
  },
];
