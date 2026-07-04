export const DEFAULT_ENGINE_CONFIG = {
  version: "p2-market-model-1",
  probability: {
    marketBlendWeight: 0.92,
    bettingBlendWeight: 0.08,
    outlierDistanceThreshold: 0.16,
    outlierMinCompanies: 5,
    outlierPenalty: 0.38,
    recencyHalfLifeHours: 18,
    recencyMinWeight: 0.72,
    movementInfluence: 0.32,
    bettingDivergenceWarn: 0.13,
  },
  bookmaker: {
    mainWeight: 1.18,
    brandWeight: 1.18,
    liquidityBase: 0.94,
    liquidityPerRecord: 0.012,
    liquidityCap: 1.12,
    mainNames: [
      "Bet365",
      "Pinnacle",
      "澳门",
      "威廉",
      "威廉希尔",
      "立博",
      "Interwetten",
      "必发",
      "皇冠",
      "伟德",
    ],
    tiers: [
      { keywords: ["Pinnacle", "平博"], weight: 1.22 },
      { keywords: ["Bet365"], weight: 1.18 },
      { keywords: ["威廉", "威廉希尔"], weight: 1.12 },
      { keywords: ["澳门"], weight: 1.1 },
      { keywords: ["立博", "Interwetten"], weight: 1.06 },
      { keywords: ["竞彩"], weight: 1.04 },
      { keywords: ["必发"], weight: 1.04 },
    ],
    groups: [
      { key: "sharp", label: "Sharp 公司", keywords: ["Pinnacle", "平博", "Bet365"] },
      { key: "euroMain", label: "欧系主流", keywords: ["威廉", "威廉希尔", "立博", "Interwetten"] },
      { key: "asiaMain", label: "亚系主流", keywords: ["澳门", "皇冠", "伟德"] },
      { key: "official", label: "官方/交易", keywords: ["竞彩", "必发"] },
    ],
  },
  poisson: {
    scoreLimit: 6,
    totalMarketOffset: 0.08,
    totalWaterSensitivity: 0.18,
    asianDominanceSensitivity: 0.22,
    totalGoalsMin: 1.65,
    totalGoalsMax: 4.25,
    dominanceProbabilityFactor: 1.6,
    dominanceStrengthFactor: 0.18,
    dominanceMin: -1.35,
    dominanceMax: 1.35,
    homeGoalsMin: 0.35,
    homeGoalsMax: 4.4,
    awayGoalsMin: 0.25,
    awayGoalsMax: 4.2,
    drawTotalGoals: [
      { minDraw: 0.31, totalGoals: 2.12 },
      { minDraw: 0.285, totalGoals: 2.38 },
      { minDraw: 0.255, totalGoals: 2.68 },
      { minDraw: 0.225, totalGoals: 2.96 },
    ],
    defaultTotalGoals: 3.18,
    lowScoreCorrection: {
      enabled: true,
      rho: -0.08,
      maxTotalGoals: 2.7,
    },
  },
  market: {
    waterBaseline: 0.94,
    waterScale: 0.22,
    fairLineTolerance: 0.06,
    valueEdgeThreshold: 0.035,
  },
  handicapMap: {
    thresholds: [
      { minDiff: 0.52, line: 2 },
      { minDiff: 0.43, line: 1.75 },
      { minDiff: 0.36, line: 1.5 },
      { minDiff: 0.29, line: 1.25 },
      { minDiff: 0.22, line: 1 },
      { minDiff: 0.16, line: 0.75 },
      { minDiff: 0.1, line: 0.5 },
      { minDiff: 0.045, line: 0.25 },
    ],
  },
  indexes: {
    handicapBiasBase: 50,
    handicapBiasFactor: 34,
    defaultKellyIndex: 54,
    totalGoalLeanMin: 1.7,
    totalGoalLeanRange: 2.2,
  },
  risk: {
    highVolatility: 68,
    lowConsensus: 52,
    severeConsensus: 42,
    marketDivergenceLine: 0.35,
    marketDivergenceEdge: 0.06,
    kellyConflictPressure: 8,
    dataQualityWarn: 52,
  },
  pattern: {
    pathWindowsHours: [24, 12, 6, 3, 1],
    pathMoveWarn: 0.018,
    pathMoveStrong: 0.035,
    groupDivergenceWarn: 0.075,
    entropyObserve: 0.86,
    entropyHigh: 0.93,
    leaderMarginObserve: 0.08,
    leaderMarginHighRisk: 0.045,
    lowScoreRandomMassWarn: 0.58,
  },
  aiScore: {
    stability: 0.22,
    consensus: 0.22,
    protection: 0.18,
    coverBalance: 0.18,
    kelly: 0.2,
    fallbackKelly: 52,
  },
};

export function normalizeEngineConfig(overrides = {}) {
  return deepMerge(DEFAULT_ENGINE_CONFIG, overrides || {});
}

function deepMerge(base, overrides) {
  if (Array.isArray(base)) {
    return Array.isArray(overrides) ? cloneValue(overrides) : cloneValue(base);
  }

  if (!isPlainObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const result = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overrides || {})]);
  keys.forEach((key) => {
    const baseValue = base[key];
    const overrideValue = overrides?.[key];
    if (overrideValue === undefined) {
      result[key] = cloneValue(baseValue);
    } else if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = cloneValue(overrideValue);
    }
  });
  return result;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) return deepMerge(value, {});
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
