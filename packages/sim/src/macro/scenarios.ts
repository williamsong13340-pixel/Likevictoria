import type { MacroPolicy, MacroStart } from './model.ts';
import type { MacroScenario } from './sandbox.ts';

// Exchange-rate flexibility and capital mobility as the corresponding laws will set them.
const FLOAT = 1;
const MANAGED = 0.5;
const PEG = 0;
const OPEN = 8;
const PARTIAL = 2;
const CLOSED = 0.2;

const INDEPENDENT_CB = { independentCentralBank: true, baseCredibility: 0.8 };
const GOVERNMENT_CB = { independentCentralBank: false, baseCredibility: 0.3 };

const STEADY_START: MacroStart = {
  inflation: 0.03,
  credibility: 0.8,
  reserves: 6,
  domesticDebt: 0.5,
  foreignDebt: 0,
};

const BASE_POLICY: MacroPolicy = {
  exchangeRateFlexibility: FLOAT,
  capitalMobility: OPEN,
  ...INDEPENDENT_CB,
  inflationTarget: 0.03,
  governmentRate: 0.05,
  primaryBalance: 0,
  monetizedShare: 0,
  foreignBorrowingShare: 0,
};

const BASELINE: MacroScenario = {
  id: 'baseline',
  title: '稳态',
  lesson: '没有冲击时，通胀停在目标、产出缺口为零、债务率稳定：模型自身不会漂移。',
  months: 120,
  start: STEADY_START,
  policy: BASE_POLICY,
  policyChanges: [],
  shocks: [],
  anchorRate: 0.05,
  anchorInflation: 0.03,
  potentialGrowth: 0.03,
  importShare: 0.25,
  politicalRiskPremium: 0,
};

const OIL_SHOCK = [{ fromMonth: 0, untilMonth: 12, costPush: 0.08 }];

const RATE_CUT_UNDER_PEG: MacroPolicy = {
  ...BASE_POLICY,
  ...GOVERNMENT_CB,
  exchangeRateFlexibility: PEG,
  governmentRate: 0.02,
};
const MISMATCHED_DEBT: MacroStart = { ...STEADY_START, domesticDebt: 0.3, foreignDebt: 0.2 };

export const MACRO_SCENARIOS: readonly MacroScenario[] = [
  BASELINE,
  {
    ...BASELINE,
    id: 'demand-boom',
    title: '财政扩张',
    lesson:
      '基本赤字占 GDP 5%、持续 3 年：产出缺口转正，通胀升破目标，央行加息（菲利普斯曲线、泰勒规则），经常账户转为赤字（双赤字）；扩张结束后回落。',
    months: 96,
    policy: { ...BASE_POLICY, primaryBalance: -0.05 },
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
      '同样的冲击，但央行信誉低、政府把利率固定不动：预期随通胀上升，实际利率转负、经济过热，通胀长期停在 9% 左右，第 5 年后还在缓慢上升（预期失锚、违反泰勒原则）。',
    months: 96,
    start: { ...STEADY_START, credibility: 0.3 },
    policy: { ...BASE_POLICY, ...GOVERNMENT_CB },
    shocks: OIL_SHOCK,
  },
  {
    ...BASELINE,
    id: 'disinflation',
    title: '反通胀',
    lesson:
      '高通胀下改为独立央行：利率升到约 20%，本币大幅升值，通胀先因进口变便宜而回落；经济随后陷入衰退；汇率回落时通胀一度反弹，靠多年的高实际利率和缓慢重建的信誉，约 8 年后才接近目标（信誉低时反通胀代价大）。',
    months: 120,
    start: { ...STEADY_START, inflation: 0.12, credibility: 0.05 },
    policy: { ...BASE_POLICY, ...GOVERNMENT_CB, governmentRate: 0.1 },
    policyChanges: [{ month: 12, policy: INDEPENDENT_CB }],
  },
  {
    ...BASELINE,
    id: 'fiscal-dominance',
    title: '财政主导：温和印钞',
    lesson:
      '央行被迫为约 1.5% GDP 的赤字印钞：即使利率加到 20% 以上，通胀仍升到约 15% 并停在那里，加息只换来衰退（财政主导、货币数量论）；高通胀同时把本币债务稀释掉（通胀税）。',
    months: 180,
    start: { ...STEADY_START, domesticDebt: 0.1 },
    policy: { ...BASE_POLICY, primaryBalance: -0.01, monetizedShare: 1 },
  },
  {
    ...BASELINE,
    id: 'hyperinflation',
    title: '恶性通胀',
    lesson:
      '为 6% GDP 的赤字全额印钞并压低利率：超过铸币税上限后通胀自我加速，第 3 年超过 100%，第 4 年失控，信誉崩溃，经济最终陷入深度衰退；本币债务被稀释殆尽，外币债务却从 10% 涨到约 28%。',
    months: 60,
    start: { ...STEADY_START, credibility: 0.3, domesticDebt: 0.2, foreignDebt: 0.1 },
    policy: { ...BASE_POLICY, ...GOVERNMENT_CB, primaryBalance: -0.06, monetizedShare: 1 },
  },
  {
    ...BASELINE,
    id: 'peg-open-capital',
    title: '钉住汇率 + 资本开放 + 自主降息',
    lesson:
      '钉住汇率时把利率压到锚货币以下 3 个百分点：资本外流在一年内耗尽储备，钉住崩溃、一次性大幅贬值，外币债务随之膨胀（不可能三角、货币错配）。',
    months: 60,
    start: MISMATCHED_DEBT,
    policy: { ...RATE_CUT_UNDER_PEG, capitalMobility: OPEN },
  },
  {
    ...BASELINE,
    id: 'peg-closed-capital',
    title: '钉住汇率 + 资本管制 + 自主降息',
    lesson:
      '同样的降息，但资本账户关闭：外流很小，储备只是缓慢下降，钉住可以维持多年（资本管制换来货币政策自主）；不过本国通胀高于锚货币，实际升值会慢慢侵蚀经常账户。',
    months: 60,
    start: MISMATCHED_DEBT,
    policy: { ...RATE_CUT_UNDER_PEG, capitalMobility: CLOSED },
  },
  {
    ...BASELINE,
    id: 'managed-partial',
    title: '有管理浮动 + 部分开放 + 自主降息',
    lesson:
      '同样的降息，但汇率有管理地浮动、资本部分开放：压力由汇率和储备分担，本币逐步贬值、储备温和下降，不会突然崩溃（不可能三角的中间状态）。',
    months: 60,
    start: MISMATCHED_DEBT,
    policy: { ...RATE_CUT_UNDER_PEG, exchangeRateFlexibility: MANAGED, capitalMobility: PARTIAL },
  },
  {
    ...BASELINE,
    id: 'peg-defended',
    title: '钉住汇率 + 资本开放 + 独立央行：遇上衰退',
    lesson:
      '钉住汇率、资本开放、央行独立：遇到衰退时，利率只能跟着锚货币利率走，几乎不能降息，衰退只能靠时间消化（不可能三角的另一面：放弃货币政策自主）。',
    months: 72,
    policy: { ...BASE_POLICY, exchangeRateFlexibility: PEG },
    shocks: [{ fromMonth: 0, untilMonth: 24, demandShock: -0.04 }],
  },
  {
    ...BASELINE,
    id: 'debt-spiral',
    title: '债务螺旋',
    lesson:
      '高债务 + 基本赤字 + 政治风险：风险溢价随债务上升，私人借贷成本跟着上升，经济转入衰退；资本外流使本币贬值、外币债务膨胀，债务率加速上升，第 6 年违约减记。之后三年被市场排斥：基本赤字只能印钞，通胀逐年升到约 19%，信誉大跌；外国资本不再进入，但巨额贸易顺差让超跌的本币明显回升。排斥结束、停止印钞后通胀回落，但赤字不改，重新借款还要付声誉溢价，债务一路累积，第 14 年再次违约。',
    months: 180,
    start: { ...STEADY_START, domesticDebt: 0.7, foreignDebt: 0.3 },
    policy: { ...BASE_POLICY, primaryBalance: -0.03, foreignBorrowingShare: 0.3 },
    politicalRiskPremium: 0.02,
  },
];
