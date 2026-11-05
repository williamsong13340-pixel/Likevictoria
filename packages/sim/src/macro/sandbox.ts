import { validateParams, type ParamSpecs } from '../params.ts';
import {
  currentAccountAt,
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  stepDemandProxy,
  type DemandProxyParams,
} from './demand-proxy.ts';
import {
  initialMacroState,
  stepMacro,
  type MacroInputs,
  type MacroPolicy,
  type MacroStart,
} from './model.ts';
import { DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, type MacroParams } from './params.ts';

type PolicyNumbers = Omit<MacroPolicy, 'independentCentralBank'>;

/** Valid ranges of policy settings, which laws and scenarios supply as data. */
export const POLICY_LIMITS: ParamSpecs<PolicyNumbers> = {
  exchangeRateFlexibility: {
    unit: '0—1',
    min: 0,
    max: 1,
    meaning: '汇率灵活度：0 为钉住，1 为自由浮动',
  },
  capitalMobility: { unit: 'GDP比例/利差', min: 0, max: 50, meaning: '资本流动性' },
  baseCredibility: { unit: '0—1', min: 0, max: 1, meaning: '央行法律地位决定的基础信誉' },
  inflationTarget: { unit: '年率', min: -0.02, max: 0.2, meaning: '通胀目标' },
  governmentRate: { unit: '年率', min: -0.05, max: 1, meaning: '政府设定的政策利率' },
  primaryBalance: { unit: 'GDP比例', min: -0.2, max: 0.2, meaning: '基本财政盈余' },
  monetizedShare: { unit: '比例', min: 0, max: 1, meaning: '由央行印钞弥补的赤字比例' },
  foreignBorrowingShare: { unit: '比例', min: 0, max: 1, meaning: '新借款中外币的比例' },
};

/** Valid starting conditions. */
const START_LIMITS: ParamSpecs<MacroStart> = {
  inflation: { unit: '年率', min: -0.5, max: 20, meaning: '起始通胀' },
  credibility: { unit: '0—1', min: 0, max: 1, meaning: '起始信誉' },
  reserves: { unit: '月进口额', min: 0, max: 60, meaning: '起始外汇储备' },
  domesticDebt: { unit: 'GDP比例', min: 0, max: 5, meaning: '起始本币债务' },
  foreignDebt: { unit: 'GDP比例', min: -5, max: 5, meaning: '起始外币债务；负数为海外净资产' },
};

type ScenarioNumbers = Pick<
  MacroScenario,
  'anchorRate' | 'anchorInflation' | 'potentialGrowth' | 'importShare' | 'politicalRiskPremium'
>;

/** Valid ranges of the outside world and fixed structure a scenario assumes. */
const SCENARIO_LIMITS: ParamSpecs<ScenarioNumbers> = {
  anchorRate: { unit: '年率', min: -0.02, max: 0.3, meaning: '锚货币利率' },
  anchorInflation: { unit: '年率', min: -0.05, max: 0.2, meaning: '锚货币通胀' },
  potentialGrowth: { unit: '年率', min: -0.05, max: 0.15, meaning: '潜在增长率' },
  importShare: { unit: 'GDP比例', min: 0.02, max: 1, meaning: '进口占 GDP 的比例，必须为正' },
  politicalRiskPremium: { unit: '年率', min: 0, max: 0.3, meaning: '政治风险溢价' },
};

type ShockSizes = Required<Pick<ScenarioShock, 'costPush' | 'demandShock'>>;

/** Valid sizes of a shock in any month. */
const SHOCK_LIMITS: ParamSpecs<ShockSizes> = {
  costPush: { unit: '年率', min: -0.3, max: 0.3, meaning: '成本冲击（如油价）' },
  demandShock: { unit: 'GDP比例', min: -0.3, max: 0.3, meaning: '需求冲击' },
};

/** A temporary shock, active for months in [fromMonth, untilMonth). */
interface ScenarioShock {
  readonly fromMonth: number;
  readonly untilMonth: number;
  readonly costPush?: number;
  readonly demandShock?: number;
}

/** A lasting policy change that takes effect at the start of `month`. */
interface ScenarioPolicyChange {
  readonly month: number;
  readonly policy: Partial<MacroPolicy>;
}

/** One country, one storyline: starting conditions, policy, shocks and fixed structure. */
export interface MacroScenario {
  readonly id: string;
  readonly title: string;
  readonly lesson: string;
  readonly months: number;
  readonly start: MacroStart;
  readonly policy: MacroPolicy;
  readonly policyChanges: readonly ScenarioPolicyChange[];
  readonly shocks: readonly ScenarioShock[];
  readonly anchorRate: number;
  readonly anchorInflation: number;
  readonly potentialGrowth: number;
  readonly importShare: number;
  readonly politicalRiskPremium: number;
}

export interface MonthRecord {
  readonly month: number;
  readonly inflation: number;
  readonly expectedInflation: number;
  readonly credibility: number;
  readonly policyRate: number;
  readonly realRate: number;
  readonly outputGap: number;
  readonly currentAccount: number;
  readonly capitalFlow: number;
  readonly financingGap: number;
  readonly reserves: number;
  readonly logExchangeRate: number;
  readonly debt: number;
  readonly foreignDebt: number;
  readonly fiscalDeficit: number;
  readonly monetizedDeficit: number;
  readonly riskPremium: number;
  readonly logPriceLevel: number;
  readonly pegCollapsed: boolean;
  readonly defaulted: boolean;
}

/** Runs the macro block against the demand stand-in for the whole scenario. */
export function runScenario(
  scenario: MacroScenario,
  macroParams: MacroParams = DEFAULT_MACRO_PARAMS,
  demandParams: DemandProxyParams = DEFAULT_DEMAND_PROXY_PARAMS,
): MonthRecord[] {
  validateParams(macroParams, MACRO_PARAM_SPECS);
  validateParams(demandParams, DEMAND_PROXY_PARAM_SPECS);
  validateParams(scenario.start, START_LIMITS);
  validateParams<ScenarioNumbers>(scenario, SCENARIO_LIMITS);
  const months = [
    scenario.months,
    ...scenario.policyChanges.map((change) => change.month),
    ...scenario.shocks.flatMap((shock) => [shock.fromMonth, shock.untilMonth]),
  ];
  if (!months.every((month) => Number.isInteger(month) && month >= 0) || scenario.months < 1) {
    throw new RangeError(`场景 ${scenario.id} 的月份必须是非负整数，长度至少 1 个月`);
  }

  let policy = scenario.policy;
  validateParams<PolicyNumbers>(policy, POLICY_LIMITS);
  let demand = currentAccountAt(0, 0, demandParams);
  const inputsFor = (costPush: number): MacroInputs => ({
    outputGap: demand.outputGap,
    potentialGrowth: scenario.potentialGrowth,
    costPush,
    currentAccount: demand.currentAccount,
    currentAccountSensitivity: demand.currentAccountSensitivity,
    importShare: scenario.importShare,
    politicalRiskPremium: scenario.politicalRiskPremium,
    anchorRate: scenario.anchorRate,
    anchorInflation: scenario.anchorInflation,
  });
  let state = initialMacroState(scenario.start, policy, inputsFor(0), macroParams);
  const records: MonthRecord[] = [];

  for (let month = 0; month < scenario.months; month++) {
    for (const change of scenario.policyChanges) {
      if (change.month === month) {
        policy = { ...policy, ...change.policy };
        validateParams<PolicyNumbers>(policy, POLICY_LIMITS);
      }
    }
    let costPush = 0;
    let demandShock = 0;
    for (const shock of scenario.shocks) {
      if (month >= shock.fromMonth && month < shock.untilMonth) {
        costPush += shock.costPush ?? 0;
        demandShock += shock.demandShock ?? 0;
      }
    }
    validateParams({ costPush, demandShock }, SHOCK_LIMITS);

    const step = stepMacro(state, policy, inputsFor(costPush), macroParams);
    state = step.state;
    if (step.pegCollapsed) policy = { ...policy, exchangeRateFlexibility: 1 };

    records.push({
      month,
      inflation: state.inflation,
      expectedInflation: state.expectedInflation,
      credibility: state.credibility,
      policyRate: state.policyRate,
      realRate: step.realRate,
      outputGap: demand.outputGap,
      currentAccount: demand.currentAccount,
      capitalFlow: step.capitalFlow,
      financingGap: step.financingGap,
      reserves: state.reserves,
      logExchangeRate: state.logExchangeRate,
      debt: state.domesticDebt + state.foreignDebt,
      foreignDebt: state.foreignDebt,
      fiscalDeficit: step.fiscalDeficit,
      monetizedDeficit: step.monetizedDeficit,
      riskPremium: step.riskPremium,
      logPriceLevel: state.logPriceLevel,
      pegCollapsed: step.pegCollapsed,
      defaulted: step.defaulted,
    });

    demand = stepDemandProxy(
      demand,
      {
        realRate: step.realRate,
        riskPremium: step.riskPremium,
        neutralRealRate: macroParams.neutralRealRate,
        primaryBalance: policy.primaryBalance,
        costPush,
        demandShock,
        inflation: state.inflation,
        inflationTarget: policy.inflationTarget,
        realExchangeRate: state.realExchangeRate,
      },
      demandParams,
    );
  }
  return records;
}
