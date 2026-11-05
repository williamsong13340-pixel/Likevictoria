import { validateParams } from '../params.ts';
import {
  DEFAULT_DEMAND_PROXY_PARAMS,
  DEMAND_PROXY_PARAM_SPECS,
  stepDemandProxy,
  type DemandProxyParams,
  type DemandProxyState,
} from './demand-proxy.ts';
import { stepMacro, type MacroPolicy, type MacroState } from './model.ts';
import { DEFAULT_MACRO_PARAMS, MACRO_PARAM_SPECS, type MacroParams } from './params.ts';

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

/** One country, one storyline: initial conditions, policy, shocks and fixed structure. */
export interface MacroScenario {
  readonly id: string;
  readonly title: string;
  readonly lesson: string;
  readonly months: number;
  readonly initial: MacroState;
  readonly initialOutputGap: number;
  readonly policy: MacroPolicy;
  readonly policyChanges: readonly ScenarioPolicyChange[];
  readonly shocks: readonly ScenarioShock[];
  readonly anchorRate: number;
  readonly anchorInflation: number;
  readonly potentialGrowth: number;
  readonly importShare: number;
  readonly baselineCurrentAccount: number;
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
  readonly reserves: number;
  readonly exchangeRate: number;
  readonly debt: number;
  readonly fiscalDeficit: number;
  readonly monetizedDeficit: number;
  readonly riskPremium: number;
  readonly priceLevel: number;
  readonly pegCollapsed: boolean;
}

/** Runs the macro block against the demand stand-in for the whole scenario. */
export function runScenario(
  scenario: MacroScenario,
  macroParams: MacroParams = DEFAULT_MACRO_PARAMS,
  demandParams: DemandProxyParams = DEFAULT_DEMAND_PROXY_PARAMS,
): MonthRecord[] {
  validateParams(macroParams, MACRO_PARAM_SPECS);
  validateParams(demandParams, DEMAND_PROXY_PARAM_SPECS);

  let state = scenario.initial;
  let policy = scenario.policy;
  let demand: DemandProxyState = {
    outputGap: scenario.initialOutputGap,
    currentAccount: scenario.baselineCurrentAccount,
  };
  const records: MonthRecord[] = [];

  for (let month = 0; month < scenario.months; month++) {
    for (const change of scenario.policyChanges) {
      if (change.month === month) policy = { ...policy, ...change.policy };
    }
    let costPush = 0;
    let demandShock = 0;
    for (const shock of scenario.shocks) {
      if (month >= shock.fromMonth && month < shock.untilMonth) {
        costPush += shock.costPush ?? 0;
        demandShock += shock.demandShock ?? 0;
      }
    }

    const step = stepMacro(
      state,
      policy,
      {
        outputGap: demand.outputGap,
        potentialGrowth: scenario.potentialGrowth,
        costPush,
        currentAccount: demand.currentAccount,
        importShare: scenario.importShare,
        politicalRiskPremium: scenario.politicalRiskPremium,
        anchorRate: scenario.anchorRate,
        anchorInflation: scenario.anchorInflation,
      },
      macroParams,
    );
    state = step.state;
    if (step.pegCollapsed) policy = { ...policy, exchangeRegime: 'float' };

    records.push({
      month,
      inflation: state.inflation,
      expectedInflation: step.expectedInflation,
      credibility: state.credibility,
      policyRate: state.policyRate,
      realRate: step.realRate,
      outputGap: demand.outputGap,
      currentAccount: demand.currentAccount,
      capitalFlow: step.capitalFlow,
      reserves: state.reserves,
      exchangeRate: Math.exp(state.logExchangeRate),
      debt: state.debt,
      fiscalDeficit: step.fiscalDeficit,
      monetizedDeficit: step.monetizedDeficit,
      riskPremium: step.riskPremium,
      priceLevel: state.priceLevel,
      pegCollapsed: step.pegCollapsed,
    });

    demand = stepDemandProxy(
      demand,
      {
        realRate: step.realRate,
        neutralRealRate: macroParams.neutralRealRate,
        primaryBalance: policy.primaryBalance,
        costPush,
        demandShock,
        realExchangeRate: state.realExchangeRate,
        baselineCurrentAccount: scenario.baselineCurrentAccount,
      },
      demandParams,
    );
  }
  return records;
}
