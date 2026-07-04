import { normalizeEngineConfig } from "./engineConfig.js";

const OUTCOMES = ["home", "draw", "away"];
const OUTCOME_LABELS = {
  home: "主胜",
  draw: "平局",
  away: "客胜",
};
const HANDICAP_LINES = [-2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const TOTAL_GOAL_LINES = [1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4];

export function buildQuantEngine({ match = {}, records = [], bookmakers = [], bettingAnalysis = null, markets = {}, config = null } = {}) {
  const engineConfig = normalizeEngineConfig(config);
  const usableBookmakers = normalizeBookmakers(bookmakers, records, engineConfig);
  const latestRecords = usableBookmakers.map((bookmaker) => bookmaker.last).filter(Boolean);
  const probabilityByCompany = usableBookmakers.map((bookmaker) => buildCompanyProbability(bookmaker, match, engineConfig)).filter(Boolean);
  const consensus = calculateConsensusIndex(probabilityByCompany);
  const marketSignals = buildMarketSignals(probabilityByCompany, bettingAnalysis, engineConfig);
  const fusedProbability = fuseProbabilities(probabilityByCompany, marketSignals, engineConfig);
  const fallbackStrength = estimateStrengthFromProbability(fusedProbability);
  const goalModel = buildPoissonModel(fusedProbability, markets, fallbackStrength, engineConfig);
  const handicap = buildHandicapModel(goalModel, fusedProbability, markets?.asian, engineConfig);
  const volatility = calculateVolatilityIndex(records, usableBookmakers);
  const kelly = calculateKellyProfile(latestRecords, fusedProbability);
  const oddsTimeline = buildOddsTimeline(records);
  const asianTimeline = buildMarketTimeline(markets?.asian);
  const totalsTimeline = buildMarketTimeline(markets?.totals);
  const pattern = buildPatternDiagnostics({
    match,
    records,
    markets,
    oddsTimeline,
    asianTimeline,
    totalsTimeline,
    probabilityByCompany,
    fusedProbability,
    goalModel,
    handicap,
    config: engineConfig,
  });
  const indexes = buildIndexes({
    handicap,
    goalModel,
    volatility,
    consensus,
    kelly,
    probabilityByCompany,
    config: engineConfig,
  });
  const score = calculateAiScore({ indexes, volatility, consensus, kelly, handicap, config: engineConfig });
  const explanation = explainEngine({
    match,
    fusedProbability,
    marketSignals,
    goalModel,
    handicap,
    indexes,
    score,
    volatility,
    consensus,
    kelly,
    probabilityByCompany,
    markets,
    dataQuality: calculateDataQuality(records, usableBookmakers, markets),
    config: engineConfig,
    pattern,
  });

  return {
    generatedAt: new Date().toISOString(),
    configVersion: engineConfig.version,
    match,
    inputs: {
      recordsCount: records.length,
      bookmakerCount: usableBookmakers.length,
      latestRecordsCount: latestRecords.length,
      asianRecordsCount: markets?.asian?.records?.length || 0,
      totalsRecordsCount: markets?.totals?.records?.length || 0,
      dataQuality: calculateDataQuality(records, usableBookmakers, markets),
      marketAvailability: {
        europe: records.length > 0,
        asian: (markets?.asian?.records?.length || 0) > 0,
        totals: (markets?.totals?.records?.length || 0) > 0,
        kelly: latestRecords.some((record) => Number.isFinite(record.kellyHome)),
        betting: hasBettingSignal(bettingAnalysis),
      },
    },
    probability: {
      companies: probabilityByCompany,
      fused: fusedProbability,
      consensus,
      kelly,
      marketSignals,
    },
    odds: {
      timeline: oddsTimeline,
      volatility,
      returnRate: calculateReturnRateProfile(latestRecords),
    },
    markets: {
      asian: {
        source: markets?.asian?.records?.length ? "500公开亚盘" : "欧赔理论映射",
        timeline: asianTimeline,
        latest: markets?.asian?.latest || null,
      },
      totals: {
        source: markets?.totals?.records?.length ? "500公开大小球" : "泊松理论总进球",
        timeline: totalsTimeline,
        latest: markets?.totals?.latest || null,
      },
    },
    poisson: goalModel,
    handicap,
    indexes,
    pattern,
    ai: {
      score,
      rating: scoreRating(score),
      explanation,
      radar: buildRiskRadar({ indexes, volatility, consensus, kelly, handicap }),
    },
    debug: {
      config: engineConfig,
      probabilityByCompany,
      marketSignals,
      fallbackStrength,
      expectedGoals: goalModel.expectedGoals,
      handicapCandidates: handicap.candidates,
      generatedFrom: "europe+kelly+poisson+optional-market-lines",
    },
  };
}

export function calculateImpliedProbability(record) {
  const odds = [record?.homeOdds, record?.drawOdds, record?.awayOdds];
  if (!odds.every((value) => Number.isFinite(value) && value > 1)) return null;
  const raw = {
    home: 1 / odds[0],
    draw: 1 / odds[1],
    away: 1 / odds[2],
  };
  const overround = OUTCOMES.reduce((sum, key) => sum + raw[key], 0);
  const fair = overround > 0
    ? {
        home: raw.home / overround,
        draw: raw.draw / overround,
        away: raw.away / overround,
      }
    : emptyProbability();

  return {
    raw,
    fair,
    overround,
    margin: Math.max(0, overround - 1),
    returnRate: overround > 0 ? 1 / overround : null,
  };
}

export function calculateAsianCoverProbability(goalMatrix, line = 0) {
  const cover = splitHandicap(line).reduce((sum, part) => sum + coverForLine(goalMatrix, part), 0) / splitHandicap(line).length;
  const push = splitHandicap(line).reduce((sum, part) => sum + pushForLine(goalMatrix, part), 0) / splitHandicap(line).length;
  return {
    line,
    cover,
    push,
    loss: Math.max(0, 1 - cover - push),
    fairOdds: cover > 0 ? 1 / cover : null,
  };
}

function normalizeBookmakers(bookmakers, records, config) {
  if (bookmakers?.length) {
    return bookmakers
      .filter((item) => item?.first || item?.last)
      .map((item) => ({
        ...item,
        weight: bookmakerWeight(item, config),
      }));
  }

  const groups = new Map();
  records.forEach((record) => {
    const key = record.cid || record.bookmaker;
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });

  return [...groups.entries()].map(([key, rows]) => {
    const sorted = rows.slice().sort((a, b) => timeValue(a) - timeValue(b));
    const first = sorted.find(hasOddsTriple) || sorted[0];
    const last = sorted.slice().reverse().find(hasOddsTriple) || sorted.at(-1);
    return {
      cid: sorted[0]?.cid || key,
      bookmaker: sorted[0]?.bookmaker || key,
      isMain: sorted.some((row) => row.isMain),
      first,
      last,
      count: rows.length,
      weight: bookmakerWeight(sorted[0], config),
    };
  });
}

function buildCompanyProbability(bookmaker, match, config) {
  const latest = calculateImpliedProbability(bookmaker.last);
  const opening = calculateImpliedProbability(bookmaker.first);
  if (!latest && !opening) return null;
  const fair = latest?.fair || opening?.fair;
  const movement = opening?.fair && latest?.fair
    ? {
        home: latest.fair.home - opening.fair.home,
        draw: latest.fair.draw - opening.fair.draw,
        away: latest.fair.away - opening.fair.away,
      }
    : { home: 0, draw: 0, away: 0 };
  return {
    cid: bookmaker.cid || "",
    bookmaker: bookmaker.bookmaker || "未知公司",
    baseWeight: bookmaker.weight || 1,
    weight: bookmaker.weight || 1,
    isMain: !!bookmaker.isMain,
    fair,
    raw: latest?.raw || opening?.raw,
    openingFair: opening?.fair || null,
    movement,
    margin: latest?.margin ?? opening?.margin ?? null,
    returnRate: latest?.returnRate ?? opening?.returnRate ?? null,
    recencyWeight: calculateRecencyWeight(bookmaker.last, match, config),
    movementWeight: calculateMovementWeight(movement, config),
    outlierScore: 0,
    outlierWeight: 1,
    kelly: {
      home: bookmaker.last?.kellyHome ?? null,
      draw: bookmaker.last?.kellyDraw ?? null,
      away: bookmaker.last?.kellyAway ?? null,
    },
  };
}

function fuseProbabilities(companyProbabilities, marketSignals, config) {
  const weightedCompanies = applyCompanyProbabilityAdjustments(companyProbabilities, config);
  const base = weightedProbabilityAverage(weightedCompanies);
  const betting = marketSignals.bettingProbability;
  if (!betting) {
    return {
      ...base,
      diagnostics: buildProbabilityDiagnostics(weightedCompanies, marketSignals),
    };
  }
  const marketWeight = config.probability.marketBlendWeight;
  const bettingWeight = config.probability.bettingBlendWeight;

  const blended = normalizeProbability({
    home: base.home * marketWeight + betting.home * bettingWeight,
    draw: base.draw * marketWeight + betting.draw * bettingWeight,
    away: base.away * marketWeight + betting.away * bettingWeight,
  });
  return {
    ...blended,
    source: "分层欧赔融合+必发偏离微调",
    diagnostics: buildProbabilityDiagnostics(weightedCompanies, marketSignals),
  };
}

function applyCompanyProbabilityAdjustments(companyProbabilities, config) {
  if (!companyProbabilities.length) return companyProbabilities;
  const center = weightedProbabilityAverage(companyProbabilities, { useAdjustedWeight: false });
  const withOutliers = companyProbabilities.map((item) => {
    const outlierScore = item?.fair ? probabilityDistance(item.fair, center) : 0;
    const outlierWeight = companyProbabilities.length >= config.probability.outlierMinCompanies && outlierScore >= config.probability.outlierDistanceThreshold
      ? config.probability.outlierPenalty
      : 1;
    const weight = (item.baseWeight || item.weight || 1)
      * (item.recencyWeight || 1)
      * (item.movementWeight || 1)
      * outlierWeight;
    return {
      ...item,
      outlierScore,
      outlierWeight,
      weight,
    };
  });
  return withOutliers;
}

function weightedProbabilityAverage(companyProbabilities, options = {}) {
  const totals = { home: 0, draw: 0, away: 0 };
  let totalWeight = 0;
  companyProbabilities.forEach((item) => {
    if (!item?.fair) return;
    const weightSource = options.useAdjustedWeight === false ? item.baseWeight : item.weight;
    const weight = Number.isFinite(weightSource) ? weightSource : 1;
    OUTCOMES.forEach((key) => {
      totals[key] += item.fair[key] * weight;
    });
    totalWeight += weight;
  });

  if (!totalWeight) return { ...emptyProbability(), source: "等待欧赔样本" };
  return {
    home: totals.home / totalWeight,
    draw: totals.draw / totalWeight,
    away: totals.away / totalWeight,
    source: "多公司去水概率融合",
  };
}

function buildMarketSignals(companyProbabilities, bettingAnalysis, config) {
  const bettingProbability = buildBettingProbability(bettingAnalysis);
  const marketProbability = weightedProbabilityAverage(companyProbabilities);
  const bettingDistance = bettingProbability ? probabilityDistance(marketProbability, bettingProbability) : null;
  const bettingLeader = bettingProbability ? topProbabilityKey(bettingProbability) : null;
  const marketLeader = topProbabilityKey(marketProbability);
  return {
    bettingProbability,
    bettingDistance,
    bettingLeader,
    marketLeader,
    bettingDivergence: Number.isFinite(bettingDistance) && bettingDistance >= config.probability.bettingDivergenceWarn,
  };
}

function buildProbabilityDiagnostics(companyProbabilities, marketSignals) {
  const outliers = companyProbabilities
    .filter((item) => item.outlierWeight < 1)
    .map((item) => ({
      bookmaker: item.bookmaker,
      distance: item.outlierScore,
      weight: item.weight,
    }))
    .sort((a, b) => b.distance - a.distance);
  return {
    sourceCompanies: companyProbabilities.length,
    effectiveWeight: companyProbabilities.reduce((sum, item) => sum + (Number.isFinite(item.weight) ? item.weight : 0), 0),
    outliers,
    bettingDistance: marketSignals.bettingDistance,
    bettingDivergence: marketSignals.bettingDivergence,
  };
}

function buildBettingProbability(analysis) {
  const amounts = analysis?.largeVolume && sumOutcomeAmounts(analysis.largeVolume) > 0
    ? analysis.largeVolume
    : analysis?.volume;
  const total = sumOutcomeAmounts(amounts);
  if (!total) return null;
  return normalizeProbability({
    home: safeRatio(amounts.home, total),
    draw: safeRatio(amounts.draw, total),
    away: safeRatio(amounts.away, total),
  });
}

function buildPoissonModel(probability, markets, fallbackStrength, config) {
  const expectedGoals = estimateExpectedGoals(probability, markets, fallbackStrength, config);
  const scoreMatrix = buildScoreMatrix(expectedGoals.home, expectedGoals.away, config.poisson.scoreLimit, config);
  const goalDistribution = buildGoalDistribution(scoreMatrix);
  const goalDiffDistribution = buildGoalDiffDistribution(scoreMatrix);
  const resultProbability = resultProbabilityFromMatrix(scoreMatrix);
  const totalGoalLine = pickTotalGoalLine(goalDistribution, markets?.totals?.latest, config);

  return {
    scoreLimit: config.poisson.scoreLimit,
    expectedGoals,
    scoreMatrix,
    resultProbability,
    goalDistribution,
    goalDiffDistribution,
    totalGoalLine,
  };
}

function estimateExpectedGoals(probability, markets, strength, config) {
  const totalsMarket = markets?.totals;
  const asianMarket = markets?.asian;
  const marketLine = readMarketLine(totalsMarket?.latest?.line);
  const totalWaterAdjustment = calculateTotalWaterAdjustment(totalsMarket?.latest, config);
  const totalGoals = Number.isFinite(marketLine)
    ? clamp(marketLine + config.poisson.totalMarketOffset + totalWaterAdjustment, config.poisson.totalGoalsMin, config.poisson.totalGoalsMax)
    : estimateTotalGoalsFromDraw(probability.draw, config);
  const asianDominance = calculateAsianDominanceAdjustment(asianMarket?.latest, config);
  const dominance = clamp(
    (probability.home - probability.away) * config.poisson.dominanceProbabilityFactor
      + strength.homeEdge * config.poisson.dominanceStrengthFactor
      + asianDominance,
    config.poisson.dominanceMin,
    config.poisson.dominanceMax,
  );
  const home = clamp(totalGoals / 2 + dominance / 2, config.poisson.homeGoalsMin, config.poisson.homeGoalsMax);
  const away = clamp(totalGoals - home, config.poisson.awayGoalsMin, config.poisson.awayGoalsMax);

  return {
    home,
    away,
    total: home + away,
    totalWaterAdjustment,
    asianDominanceAdjustment: asianDominance,
    source: Number.isFinite(marketLine) ? "大小球盘口+水位校准" : "欧赔平局率反推",
  };
}

function estimateTotalGoalsFromDraw(drawProbability, config) {
  const draw = Number.isFinite(drawProbability) ? drawProbability : 0.27;
  const matched = config.poisson.drawTotalGoals.find((item) => draw >= item.minDraw);
  return matched?.totalGoals ?? config.poisson.defaultTotalGoals;
}

function calculateTotalWaterAdjustment(latestTotal, config) {
  const overWater = readWater(latestTotal?.overWater ?? latestTotal?.homeWater);
  const underWater = readWater(latestTotal?.underWater ?? latestTotal?.awayWater);
  if (!Number.isFinite(overWater) || !Number.isFinite(underWater)) return 0;
  const market = twoWayWaterProbability(overWater, underWater, config);
  if (!Number.isFinite(market.primary) || !Number.isFinite(market.secondary)) return 0;
  return clamp((market.primary - market.secondary) * config.poisson.totalWaterSensitivity, -0.18, 0.18);
}

function calculateAsianDominanceAdjustment(latestAsian, config) {
  const line = readMarketLine(latestAsian?.line);
  if (!Number.isFinite(line)) return 0;
  const homeWater = readWater(latestAsian?.homeWater);
  const awayWater = readWater(latestAsian?.awayWater);
  const market = twoWayWaterProbability(homeWater, awayWater, config);
  const waterBias = Number.isFinite(market.home) && Number.isFinite(market.away)
    ? (market.home - market.away) * config.market.waterScale
    : 0;
  return clamp(-line * config.poisson.asianDominanceSensitivity + waterBias, -0.55, 0.55);
}

function lowScoreCorrection(homeGoals, awayGoals, homeLambda, awayLambda, config) {
  const correction = config.poisson.lowScoreCorrection;
  if (!correction?.enabled || homeLambda + awayLambda > correction.maxTotalGoals) return 1;
  const rho = correction.rho;
  if (homeGoals === 0 && awayGoals === 0) return Math.max(0.2, 1 - homeLambda * awayLambda * rho);
  if (homeGoals === 0 && awayGoals === 1) return Math.max(0.2, 1 + homeLambda * rho);
  if (homeGoals === 1 && awayGoals === 0) return Math.max(0.2, 1 + awayLambda * rho);
  if (homeGoals === 1 && awayGoals === 1) return Math.max(0.2, 1 - rho);
  return 1;
}

function buildScoreMatrix(homeLambda, awayLambda, limit, config) {
  const homePoisson = Array.from({ length: limit + 1 }, (_, goals) => poisson(goals, homeLambda));
  const awayPoisson = Array.from({ length: limit + 1 }, (_, goals) => poisson(goals, awayLambda));
  const matrix = [];
  let captured = 0;

  for (let homeGoals = 0; homeGoals <= limit; homeGoals += 1) {
    const row = [];
    for (let awayGoals = 0; awayGoals <= limit; awayGoals += 1) {
      const probability = homePoisson[homeGoals] * awayPoisson[awayGoals] * lowScoreCorrection(homeGoals, awayGoals, homeLambda, awayLambda, config);
      captured += probability;
      row.push({
        homeGoals,
        awayGoals,
        score: `${homeGoals}:${awayGoals}`,
        probability,
      });
    }
    matrix.push(row);
  }

  const scale = captured > 0 ? 1 / captured : 1;
  return matrix.map((row) => row.map((cell) => ({ ...cell, probability: cell.probability * scale })));
}

function buildGoalDistribution(scoreMatrix) {
  const distribution = new Map();
  flattenMatrix(scoreMatrix).forEach((cell) => {
    const total = cell.homeGoals + cell.awayGoals;
    distribution.set(total, (distribution.get(total) || 0) + cell.probability);
  });
  return [...distribution.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([goals, probability]) => ({ goals, probability }));
}

function buildGoalDiffDistribution(scoreMatrix) {
  const distribution = new Map();
  flattenMatrix(scoreMatrix).forEach((cell) => {
    const diff = cell.homeGoals - cell.awayGoals;
    distribution.set(diff, (distribution.get(diff) || 0) + cell.probability);
  });
  return [...distribution.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([diff, probability]) => ({ diff, probability }));
}

function resultProbabilityFromMatrix(scoreMatrix) {
  const result = { home: 0, draw: 0, away: 0 };
  flattenMatrix(scoreMatrix).forEach((cell) => {
    if (cell.homeGoals > cell.awayGoals) result.home += cell.probability;
    else if (cell.homeGoals === cell.awayGoals) result.draw += cell.probability;
    else result.away += cell.probability;
  });
  return result;
}

function pickTotalGoalLine(goalDistribution, latestTotal, config) {
  const actual = readMarketLine(latestTotal?.line);
  const candidates = TOTAL_GOAL_LINES.map((line) => {
    const { over, under, push } = totalGoalProbability(goalDistribution, line);
    return {
      line,
      over,
      under,
      push,
      balance: Math.abs(over - under),
    };
  }).sort((a, b) => a.balance - b.balance);
  const actualProfile = Number.isFinite(actual) ? totalGoalProbability(goalDistribution, actual) : null;
  const marketValue = calculateTotalMarketValue(actualProfile, latestTotal, config);

  return {
    theoretical: candidates[0] || null,
    actual: Number.isFinite(actual) ? actual : null,
    bias: Number.isFinite(actual) && candidates[0] ? actual - candidates[0].line : null,
    actualProfile,
    marketValue,
    candidates,
  };
}

function totalGoalProbability(goalDistribution, line) {
  return goalDistribution.reduce((acc, item) => {
    if (item.goals > line) acc.over += item.probability;
    else if (item.goals < line) acc.under += item.probability;
    else acc.push += item.probability;
    return acc;
  }, { over: 0, under: 0, push: 0 });
}

function calculateTotalMarketValue(profile, latestTotal, config) {
  if (!profile) return { market: {}, overEdge: null, underEdge: null, pick: "", edge: null, label: "等待盘口" };
  const overWater = readWater(latestTotal?.overWater ?? latestTotal?.homeWater);
  const underWater = readWater(latestTotal?.underWater ?? latestTotal?.awayWater);
  const market = twoWayWaterProbability(overWater, underWater, config);
  const overEdge = Number.isFinite(market.primary) ? profile.over - market.primary : null;
  const underEdge = Number.isFinite(market.secondary) ? profile.under - market.secondary : null;
  const pick = Number.isFinite(overEdge) && Number.isFinite(underEdge)
    ? overEdge >= underEdge ? "over" : "under"
    : profile.over >= profile.under ? "over" : "under";
  const edge = pick === "over" ? overEdge : underEdge;
  return {
    market,
    overEdge,
    underEdge,
    pick,
    edge,
    label: marketValueLabel(edge, config),
  };
}

function buildHandicapModel(goalModel, probability, asianMarket, config) {
  const candidates = HANDICAP_LINES.map((line) => {
    const coverProfile = calculateAsianCoverProbability(goalModel.scoreMatrix, line);
    return {
      ...coverProfile,
      fairHomeOdds: coverProfile.cover > 0 ? 1 / coverProfile.cover : null,
      fairAwayOdds: coverProfile.loss > 0 ? 1 / coverProfile.loss : null,
      balance: Math.abs(coverProfile.cover - coverProfile.loss),
    };
  });
  const theoretical = candidates.slice().sort((a, b) => a.balance - b.balance)[0] || null;
  const euroMapped = mapProbabilityToHandicap(probability, config);
  const actual = readMarketLine(asianMarket?.latest?.line);
  const referenceLine = Number.isFinite(actual) ? actual : theoretical?.line ?? euroMapped;
  const actualCover = calculateAsianCoverProbability(goalModel.scoreMatrix, referenceLine);
  const fairLine = pickFairHandicapLine(candidates, config);
  const marketValue = calculateHandicapMarketValue(actualCover, asianMarket?.latest, config);
  const bias = Number.isFinite(actual)
    ? actual - euroMapped
    : (theoretical?.line ?? 0) - euroMapped;

  return {
    euroMappedLine: euroMapped,
    theoreticalLine: theoretical?.line ?? null,
    actualLine: Number.isFinite(actual) ? actual : null,
    hasActualLine: Number.isFinite(actual),
    referenceLine,
    bias,
    biasLabel: handicapBiasLabel(bias),
    cover: actualCover,
    fairLine,
    marketValue,
    candidates,
    drawProtectionIndex: calculateDrawProtection(goalModel.goalDiffDistribution, referenceLine),
    marginProtectionIndex: calculateMarginProtection(goalModel.goalDiffDistribution, referenceLine),
    goalDistributionIndex: calculateGoalDistributionIndex(goalModel.goalDiffDistribution),
  };
}

function pickFairHandicapLine(candidates, config) {
  const sorted = candidates
    .map((item) => ({
      line: item.line,
      cover: item.cover,
      loss: item.loss,
      push: item.push,
      edge: item.cover - item.loss,
      balance: Math.abs(item.cover - item.loss),
    }))
    .sort((a, b) => a.balance - b.balance);
  const fair = sorted[0] || null;
  const nearFair = sorted.filter((item) => item.balance <= config.market.fairLineTolerance);
  return {
    line: fair?.line ?? null,
    cover: fair?.cover ?? null,
    loss: fair?.loss ?? null,
    edge: fair?.edge ?? null,
    nearFair,
  };
}

function calculateHandicapMarketValue(coverProfile, latestAsian, config) {
  const homeWater = readWater(latestAsian?.homeWater);
  const awayWater = readWater(latestAsian?.awayWater);
  const market = twoWayWaterProbability(homeWater, awayWater, config);
  const homeEdge = Number.isFinite(market.home)
    ? coverProfile.cover - market.home
    : null;
  const awayEdge = Number.isFinite(market.away)
    ? coverProfile.loss - market.away
    : null;
  const pick = Number.isFinite(homeEdge) && Number.isFinite(awayEdge)
    ? homeEdge >= awayEdge ? "home" : "away"
    : coverProfile.cover >= coverProfile.loss ? "home" : "away";
  const edge = pick === "home" ? homeEdge : awayEdge;
  return {
    market,
    homeEdge,
    awayEdge,
    pick,
    edge,
    label: marketValueLabel(edge, config),
  };
}

function mapProbabilityToHandicap(probability, config) {
  const diff = probability.home - probability.away;
  const positive = config.handicapMap.thresholds.find((item) => diff >= item.minDiff);
  if (positive) return -positive.line;
  const negative = config.handicapMap.thresholds.find((item) => diff <= -item.minDiff);
  if (negative) return negative.line;
  return 0;
}

function calculateDrawProtection(diffDistribution, line) {
  const nearDrawMass = diffDistribution
    .filter((item) => Math.abs(item.diff) <= 1)
    .reduce((sum, item) => sum + item.probability, 0);
  const linePressure = Math.abs(line) === 0.75 ? 1 : Math.abs(line) === 0.5 ? 0.74 : Math.abs(line) === 1 ? 0.66 : 0.48;
  return clamp((nearDrawMass * 0.72 + linePressure * 0.28) * 100, 0, 100);
}

function calculateMarginProtection(diffDistribution, line) {
  const target = Math.max(1, Math.floor(Math.abs(line)));
  const enoughMargin = diffDistribution
    .filter((item) => Math.abs(item.diff) >= target + 1)
    .reduce((sum, item) => sum + item.probability, 0);
  const oneGoalMass = diffDistribution
    .filter((item) => Math.abs(item.diff) === 1)
    .reduce((sum, item) => sum + item.probability, 0);
  const linePressure = Math.abs(line) >= 1 ? 0.92 : Math.abs(line) >= 0.75 ? 0.66 : 0.38;
  return clamp((linePressure * 0.44 + enoughMargin * 0.38 + oneGoalMass * 0.18) * 100, 0, 100);
}

function calculateGoalDistributionIndex(diffDistribution) {
  const centerMass = diffDistribution
    .filter((item) => Math.abs(item.diff) <= 1)
    .reduce((sum, item) => sum + item.probability, 0);
  const tailMass = diffDistribution
    .filter((item) => Math.abs(item.diff) >= 3)
    .reduce((sum, item) => sum + item.probability, 0);
  return clamp((centerMass * 0.72 + tailMass * 0.18) * 100, 0, 100);
}

function calculateVolatilityIndex(records, bookmakers) {
  const seriesByBookmaker = new Map();
  records.filter(hasOddsTriple).forEach((record) => {
    const key = record.cid || record.bookmaker || "unknown";
    if (!seriesByBookmaker.has(key)) seriesByBookmaker.set(key, []);
    seriesByBookmaker.get(key).push(record);
  });

  const changes = [];
  seriesByBookmaker.forEach((rows) => {
    const sorted = rows.slice().sort((a, b) => timeValue(a) - timeValue(b));
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      OUTCOMES.forEach((key) => {
        const oddsKey = `${key}Odds`;
        if (Number.isFinite(previous[oddsKey]) && Number.isFinite(current[oddsKey])) {
          changes.push(Math.abs(current[oddsKey] - previous[oddsKey]) / previous[oddsKey]);
        }
      });
    }
  });

  const summaryMovement = bookmakers.flatMap((bookmaker) => OUTCOMES.map((key) => {
    const oddsKey = `${key}Odds`;
    if (!Number.isFinite(bookmaker.first?.[oddsKey]) || !Number.isFinite(bookmaker.last?.[oddsKey])) return null;
    return Math.abs(bookmaker.last[oddsKey] - bookmaker.first[oddsKey]) / bookmaker.first[oddsKey];
  })).filter(Number.isFinite);
  const allChanges = changes.length ? changes : summaryMovement;
  const avg = average(allChanges);
  const max = allChanges.length ? Math.max(...allChanges) : null;
  const index = Number.isFinite(avg)
    ? clamp(avg * 850 + (max || 0) * 180, 0, 100)
    : 0;

  return {
    index,
    averageChange: avg,
    maxChange: max,
    samples: allChanges.length,
    level: index >= 70 ? "高波动" : index >= 42 ? "中波动" : "低波动",
  };
}

function calculateConsensusIndex(companyProbabilities) {
  if (companyProbabilities.length < 2) {
    return {
      index: companyProbabilities.length ? 68 : 0,
      dispersion: null,
      matrix: [],
      level: companyProbabilities.length ? "样本有限" : "等待样本",
    };
  }

  const dispersion = average(OUTCOMES.map((key) => standardDeviation(companyProbabilities.map((item) => item.fair[key]))));
  const index = clamp((1 - dispersion / 0.115) * 100, 0, 100);
  const matrix = companyProbabilities.map((a) => ({
    bookmaker: a.bookmaker,
    row: companyProbabilities.map((b) => ({
      bookmaker: b.bookmaker,
      value: 1 - Math.min(1, probabilityDistance(a.fair, b.fair) / 0.24),
    })),
  }));

  return {
    index,
    dispersion,
    matrix,
    level: index >= 76 ? "高度一致" : index >= 56 ? "分歧可控" : "明显分歧",
  };
}

function calculateKellyProfile(records, fusedProbability) {
  const kellyRows = records
    .map((record) => ({
      bookmaker: record.bookmaker,
      home: record.kellyHome,
      draw: record.kellyDraw,
      away: record.kellyAway,
    }))
    .filter((row) => OUTCOMES.some((key) => Number.isFinite(row[key])));

  const averageKelly = OUTCOMES.reduce((acc, key) => {
    acc[key] = average(kellyRows.map((row) => row[key]).filter(Number.isFinite));
    return acc;
  }, {});
  const pressure = OUTCOMES.reduce((acc, key) => {
    acc[key] = Number.isFinite(averageKelly[key])
      ? clamp((1 - averageKelly[key]) * 100, -45, 45)
      : null;
    return acc;
  }, {});
  const protectedOutcome = OUTCOMES
    .map((key) => ({ key, value: pressure[key], probability: fusedProbability[key] }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)[0] || null;
  const dispersion = average(OUTCOMES.map((key) => standardDeviation(kellyRows.map((row) => row[key]).filter(Number.isFinite))));

  return {
    samples: kellyRows.length,
    average: averageKelly,
    pressure,
    protectedOutcome,
    dispersion,
    index: Number.isFinite(dispersion) ? clamp((1 - dispersion / 0.18) * 100, 0, 100) : 0,
  };
}

function calculateReturnRateProfile(records) {
  const values = records.map((record) => {
    if (Number.isFinite(record.returnRate)) return record.returnRate / (record.returnRate > 1 ? 100 : 1);
    return calculateImpliedProbability(record)?.returnRate ?? null;
  }).filter(Number.isFinite);

  return {
    average: average(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

function buildOddsTimeline(records) {
  const grouped = new Map();
  records.filter(hasOddsTriple).forEach((record) => {
    const key = normalizeTimeBucket(record);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  });

  return [...grouped.entries()]
    .map(([time, rows]) => ({
      time,
      home: average(rows.map((row) => row.homeOdds)),
      draw: average(rows.map((row) => row.drawOdds)),
      away: average(rows.map((row) => row.awayOdds)),
    }))
    .sort((a, b) => timeTextValue(a.time) - timeTextValue(b.time))
    .slice(-80);
}

function buildMarketTimeline(market) {
  return (market?.records || [])
    .filter((record) => Number.isFinite(record.line))
    .map((record) => ({
      time: record.time || record.updateTime || "",
      line: record.line,
      homeWater: record.homeWater ?? record.overWater ?? null,
      awayWater: record.awayWater ?? record.underWater ?? null,
      company: record.bookmaker || "",
    }))
    .slice(-80);
}

function buildPatternDiagnostics({ match, records, markets, oddsTimeline, asianTimeline, totalsTimeline, probabilityByCompany, fusedProbability, goalModel, handicap, config }) {
  const marketPath = buildMarketPathDiagnostics({ match, records, oddsTimeline, asianTimeline, totalsTimeline, config });
  const bookmakerGroups = buildBookmakerGroupDiagnostics(probabilityByCompany, config);
  const uncertainty = buildUncertaintyDiagnostics({ fusedProbability, goalModel, handicap, marketPath, bookmakerGroups, config });
  return {
    marketPath,
    bookmakerGroups,
    uncertainty,
    fingerprint: buildEngineFingerprint({
      fusedProbability,
      goalModel,
      handicap,
      marketPath,
      bookmakerGroups,
      uncertainty,
      markets,
    }),
  };
}

function buildMarketPathDiagnostics({ match, records, oddsTimeline, asianTimeline, totalsTimeline, config }) {
  const europe = config.pattern.pathWindowsHours.map((hours) => buildOddsWindowSignal(records, match, hours, config));
  const asian = config.pattern.pathWindowsHours.map((hours) => buildMarketWindowSignal(asianTimeline, match, hours, "line", config));
  const totals = config.pattern.pathWindowsHours.map((hours) => buildMarketWindowSignal(totalsTimeline, match, hours, "line", config));
  const fullOdds = buildTimelineMoveSignal(oddsTimeline, "home", config);
  return {
    europe,
    asian,
    totals,
    fullOdds,
    flags: buildPathFlags(europe, asian, totals, config),
  };
}

function buildOddsWindowSignal(records, match, hours, config) {
  const rows = filterRecordsByWindow(records.filter(hasOddsTriple), match, hours);
  const first = averageOddsRow(rows[0] ? [rows[0]] : []);
  const last = averageOddsRow(rows.length ? [rows.at(-1)] : []);
  const delta = {
    home: numericDelta(first.home, last.home),
    draw: numericDelta(first.draw, last.draw),
    away: numericDelta(first.away, last.away),
  };
  const probabilityDelta = {
    home: oddsDeltaToProbabilityDelta(first.home, last.home),
    draw: oddsDeltaToProbabilityDelta(first.draw, last.draw),
    away: oddsDeltaToProbabilityDelta(first.away, last.away),
  };
  const strongest = strongestDelta(probabilityDelta);
  return {
    hours,
    samples: rows.length,
    delta,
    probabilityDelta,
    strongest,
    label: pathMoveLabel(strongest?.value, config),
  };
}

function buildMarketWindowSignal(rows, match, hours, key, config) {
  const filtered = filterRowsByWindow(rows, match, hours);
  const first = filtered[0];
  const last = filtered.at(-1);
  const delta = numericDelta(first?.[key], last?.[key]);
  return {
    hours,
    samples: filtered.length,
    delta,
    label: pathMoveLabel(delta, config),
  };
}

function buildTimelineMoveSignal(rows, key, config) {
  const first = rows[0];
  const last = rows.at(-1);
  const delta = numericDelta(first?.[key], last?.[key]);
  return {
    samples: rows.length,
    delta,
    label: pathMoveLabel(delta, config),
  };
}

function buildPathFlags(europe, asian, totals, config) {
  const flags = [];
  const lateEurope = europe.find((item) => item.hours === 3) || europe.at(-1);
  const lateAsian = asian.find((item) => item.hours === 3) || asian.at(-1);
  const lateTotals = totals.find((item) => item.hours === 3) || totals.at(-1);
  if (lateEurope?.strongest && Math.abs(lateEurope.strongest.value) >= config.pattern.pathMoveStrong) flags.push(`临场欧赔强变化：${OUTCOME_LABELS[lateEurope.strongest.key]}`);
  if (Number.isFinite(lateAsian?.delta) && Math.abs(lateAsian.delta) >= 0.25) flags.push("临场亚盘变线");
  if (Number.isFinite(lateTotals?.delta) && Math.abs(lateTotals.delta) >= 0.25) flags.push("临场大小球变线");
  if (lateEurope?.strongest?.key === "home" && lateEurope.strongest.value > config.pattern.pathMoveWarn && Number.isFinite(lateAsian?.delta) && lateAsian.delta > -0.01) flags.push("欧赔支持主队但亚盘未跟进");
  if (lateEurope?.strongest?.key === "away" && lateEurope.strongest.value > config.pattern.pathMoveWarn && Number.isFinite(lateAsian?.delta) && lateAsian.delta < 0.01) flags.push("欧赔支持客队但亚盘未跟进");
  if (!flags.length) flags.push("路径无明显背离");
  return flags;
}

function buildBookmakerGroupDiagnostics(companyProbabilities, config) {
  const groups = config.bookmaker.groups.map((group) => {
    const companies = companyProbabilities.filter((item) => group.keywords.some((keyword) => item.bookmaker.includes(keyword)));
    const probability = weightedProbabilityAverage(companies);
    return {
      key: group.key,
      label: group.label,
      count: companies.length,
      probability,
      leader: companies.length ? topProbabilityKey(probability) : "",
      averageMovement: averageMovement(companies),
    };
  });
  const all = weightedProbabilityAverage(companyProbabilities);
  const sharp = groups.find((group) => group.key === "sharp");
  const divergence = groups
    .filter((group) => group.count > 0)
    .map((group) => ({
      key: group.key,
      label: group.label,
      distance: probabilityDistance(group.probability, all),
      leader: group.leader,
    }))
    .sort((a, b) => b.distance - a.distance);
  return {
    all,
    groups,
    sharpDistance: sharp?.count ? probabilityDistance(sharp.probability, all) : null,
    divergence,
    flags: buildGroupFlags(groups, divergence, config),
  };
}

function buildGroupFlags(groups, divergence, config) {
  const flags = [];
  const leaderGroups = groups.filter((group) => group.count > 0 && group.leader);
  const leaders = new Set(leaderGroups.map((group) => group.leader));
  if (leaders.size >= 2) flags.push("公司组方向不一致");
  divergence.filter((item) => item.distance >= config.pattern.groupDivergenceWarn).slice(0, 2).forEach((item) => {
    flags.push(`${item.label}偏离均值`);
  });
  if (!flags.length) flags.push("公司组方向接近");
  return flags;
}

function buildUncertaintyDiagnostics({ fusedProbability, goalModel, handicap, marketPath, bookmakerGroups, config }) {
  const entries = OUTCOMES.map((key) => ({ key, value: fusedProbability[key] })).sort((a, b) => b.value - a.value);
  const entropy = probabilityEntropy(fusedProbability);
  const leaderMargin = (entries[0]?.value || 0) - (entries[1]?.value || 0);
  const lowScoreMass = goalModel.goalDistribution
    .filter((item) => item.goals <= 2)
    .reduce((sum, item) => sum + item.probability, 0);
  const coverGap = Math.abs(handicap.cover.cover - handicap.cover.loss);
  const groupConflict = bookmakerGroups.flags.some((flag) => flag.includes("不一致") || flag.includes("偏离"));
  const pathConflict = marketPath.flags.some((flag) => flag.includes("未跟进") || flag.includes("变线"));
  const score = clamp(
    entropy * 42
      + (1 - clamp(leaderMargin / 0.16, 0, 1)) * 24
      + (1 - clamp(coverGap / 0.16, 0, 1)) * 14
      + (lowScoreMass >= config.pattern.lowScoreRandomMassWarn ? 10 : 0)
      + (groupConflict ? 6 : 0)
      + (pathConflict ? 4 : 0),
    0,
    100,
  );
  return {
    score,
    level: uncertaintyLevel(score),
    entropy,
    leaderMargin,
    lowScoreMass,
    coverGap,
    flags: buildUncertaintyFlags({ entropy, leaderMargin, lowScoreMass, groupConflict, pathConflict, config }),
  };
}

function buildUncertaintyFlags({ entropy, leaderMargin, lowScoreMass, groupConflict, pathConflict, config }) {
  const flags = [];
  if (entropy >= config.pattern.entropyHigh) flags.push("胜平负高度接近");
  else if (entropy >= config.pattern.entropyObserve) flags.push("胜平负分布偏均衡");
  if (leaderMargin <= config.pattern.leaderMarginHighRisk) flags.push("主信号优势很薄");
  else if (leaderMargin <= config.pattern.leaderMarginObserve) flags.push("主信号优势有限");
  if (lowScoreMass >= config.pattern.lowScoreRandomMassWarn) flags.push("低比分随机性偏高");
  if (groupConflict) flags.push("公司组存在冲突");
  if (pathConflict) flags.push("市场路径存在背离");
  if (!flags.length) flags.push("不确定性可控");
  return flags;
}

function buildEngineFingerprint({ fusedProbability, goalModel, handicap, marketPath, bookmakerGroups, uncertainty, markets }) {
  return {
    homeProbability: roundMetric(fusedProbability.home),
    drawProbability: roundMetric(fusedProbability.draw),
    awayProbability: roundMetric(fusedProbability.away),
    totalGoals: roundMetric(goalModel.expectedGoals.total),
    fairHandicap: roundMetric(handicap.fairLine.line),
    actualHandicap: roundMetric(handicap.actualLine),
    handicapEdge: roundMetric(handicap.marketValue.edge),
    totalLine: roundMetric(goalModel.totalGoalLine.actual ?? goalModel.totalGoalLine.theoretical?.line),
    totalEdge: roundMetric(goalModel.totalGoalLine.marketValue.edge),
    uncertainty: roundMetric(uncertainty.score / 100),
    pathHome3h: roundMetric(marketPath.europe.find((item) => item.hours === 3)?.probabilityDelta.home),
    pathAway3h: roundMetric(marketPath.europe.find((item) => item.hours === 3)?.probabilityDelta.away),
    sharpDistance: roundMetric(bookmakerGroups.sharpDistance),
    hasAsian: (markets?.asian?.records?.length || 0) > 0 ? 1 : 0,
    hasTotals: (markets?.totals?.records?.length || 0) > 0 ? 1 : 0,
  };
}

function buildIndexes({ handicap, goalModel, volatility, consensus, kelly, probabilityByCompany, config }) {
  const handicapBias = clamp(config.indexes.handicapBiasBase + Math.abs(handicap.bias || 0) * config.indexes.handicapBiasFactor, 0, 100);
  const coverProbability = clamp(handicap.cover.cover * 100, 0, 100);
  const volatilityIndex = volatility.index;
  const consensusIndex = consensus.index;
  const kellyIndex = kelly.index || (probabilityByCompany.length ? config.indexes.defaultKellyIndex : 0);
  const goalDistribution = handicap.goalDistributionIndex;
  const totalGoals = goalModel.expectedGoals.total;

  return {
    coverProbability,
    handicapBias,
    drawProtection: handicap.drawProtectionIndex,
    marginProtection: handicap.marginProtectionIndex,
    goalDistribution,
    volatility: volatilityIndex,
    consensus: consensusIndex,
    kelly: kellyIndex,
    totalGoalLean: clamp((totalGoals - config.indexes.totalGoalLeanMin) / config.indexes.totalGoalLeanRange * 100, 0, 100),
  };
}

function calculateAiScore({ indexes, volatility, consensus, kelly, handicap, config }) {
  const stability = 100 - volatility.index;
  const consensusPart = consensus.index;
  const protectionPart = (indexes.drawProtection + indexes.marginProtection) / 2;
  const coverBalance = 100 - Math.abs((handicap.cover.cover - handicap.cover.loss) * 100);
  const kellyPart = kelly.index || config.aiScore.fallbackKelly;
  return Math.round(clamp(
    stability * config.aiScore.stability
      + consensusPart * config.aiScore.consensus
      + protectionPart * config.aiScore.protection
      + coverBalance * config.aiScore.coverBalance
      + kellyPart * config.aiScore.kelly,
    0,
    100,
  ));
}

function buildRiskRadar({ indexes, volatility, consensus, kelly, handicap }) {
  return [
    { name: "波动风险", value: volatility.index },
    { name: "公司分歧", value: 100 - consensus.index },
    { name: "凯利异常", value: 100 - (kelly.index || 50) },
    { name: "盘口偏差", value: indexes.handicapBias },
    { name: "赢盘压力", value: Math.abs((handicap.cover.cover - handicap.cover.loss) * 100) },
    { name: "进球离散", value: 100 - indexes.goalDistribution },
  ];
}

function explainEngine(context) {
  const {
    fusedProbability,
    marketSignals,
    goalModel,
    handicap,
    indexes,
    score,
    volatility,
    consensus,
    kelly,
    probabilityByCompany,
    markets,
    dataQuality,
    config,
    pattern,
  } = context;
  const leader = OUTCOMES
    .map((key) => ({ key, value: fusedProbability[key] }))
    .sort((a, b) => b.value - a.value)[0];
  const protectedOutcome = kelly.protectedOutcome;
  const actualAsian = Number.isFinite(handicap.actualLine) ? formatHandicap(handicap.actualLine) : "暂无公开亚盘";
  const asianSource = markets?.asian?.records?.length ? "实际亚盘" : "理论盘口";
  const totalSource = markets?.totals?.records?.length ? "实际大小球" : "泊松反推总进球";

  const bullets = [
    `分层去水后，${OUTCOME_LABELS[leader.key]}概率最高，为 ${formatPercent(leader.value)}，平局保护为 ${formatPercent(fusedProbability.draw)}。`,
    `${asianSource}参考为 ${actualAsian}，公平盘口 ${formatHandicap(handicap.fairLine.line)}，模型判断为${handicap.marketValue.label}。`,
    `${totalSource}给出的期望进球为 ${formatDecimal(goalModel.expectedGoals.total, 2)}，大小球价值为${goalModel.totalGoalLine.marketValue.label}，比分热区集中在 ${topScores(goalModel.scoreMatrix, 3).map((item) => item.score).join("、")}。`,
    `公司一致性 ${formatDecimal(consensus.index, 0)}，赔率波动 ${volatility.level}，当前样本数 ${probabilityByCompany.length} 家。`,
    `路径诊断为${pattern.marketPath.flags.join("、")}；不确定性 ${formatDecimal(pattern.uncertainty.score, 0)}，等级 ${pattern.uncertainty.level}。`,
  ];

  if (protectedOutcome) {
    bullets.push(`凯利保护更偏向${OUTCOME_LABELS[protectedOutcome.key]}，均值压力 ${formatDecimal(protectedOutcome.value, 1)}。`);
  }
  if (marketSignals.bettingDivergence) {
    bullets.push(`必发资金与欧赔共识存在偏离，距离 ${formatDecimal(marketSignals.bettingDistance, 3)}，需要降低单边信号权重。`);
  }

  const conclusion = score >= 76
    ? "模型结构较稳定，适合进入人工复核与实战观察队列。"
    : score >= 58
      ? "模型存在可用信号，但盘口保护与波动仍需人工复核。"
      : "当前分歧或波动偏高，不建议只依赖单一欧赔结论。";

  return {
    headline: `${scoreRating(score)}：${OUTCOME_LABELS[leader.key]}为主信号，${handicap.biasLabel}`,
    bullets,
    conclusion,
    flags: buildRiskFlags({ indexes, volatility, consensus, kelly, handicap, goalModel, marketSignals, dataQuality, config, pattern }),
  };
}

function buildRiskFlags({ indexes, volatility, consensus, kelly, handicap, goalModel, marketSignals, dataQuality, config, pattern }) {
  const flags = [];
  if (volatility.index >= config.risk.highVolatility) flags.push("赔率波动偏高");
  if (consensus.index <= config.risk.severeConsensus) flags.push("公司严重分歧");
  else if (consensus.index <= config.risk.lowConsensus) flags.push("公司分歧明显");
  if (dataQuality <= config.risk.dataQualityWarn) flags.push("数据质量不足");
  if (marketSignals.bettingDivergence) flags.push("必发资金偏离");
  if (Number.isFinite(handicap.actualLine) && Number.isFinite(handicap.fairLine.line) && Math.abs(handicap.actualLine - handicap.fairLine.line) >= config.risk.marketDivergenceLine) flags.push("欧亚盘口背离");
  if (Number.isFinite(handicap.marketValue.edge) && Math.abs(handicap.marketValue.edge) >= config.risk.marketDivergenceEdge) flags.push("亚盘价格偏离");
  if (Number.isFinite(goalModel.totalGoalLine.marketValue.edge) && Math.abs(goalModel.totalGoalLine.marketValue.edge) >= config.risk.marketDivergenceEdge) flags.push("大小球价格偏离");
  if (pattern.uncertainty.score >= 72) flags.push("高随机信号");
  if (pattern.bookmakerGroups.flags.some((flag) => flag.includes("不一致"))) flags.push("公司组方向冲突");
  if (pattern.marketPath.flags.some((flag) => flag.includes("未跟进"))) flags.push("欧亚路径背离");
  if (kelly.protectedOutcome && marketSignals.marketLeader && kelly.protectedOutcome.key !== marketSignals.marketLeader && kelly.protectedOutcome.value >= config.risk.kellyConflictPressure) flags.push("凯利保护冲突");
  if (indexes.marginProtection >= 72 && Math.abs(handicap.referenceLine) >= 1) flags.push("深盘穿盘压力");
  if (indexes.drawProtection >= 72 && Math.abs(handicap.referenceLine) <= 0.75) flags.push("平局保护较强");
  if (!flags.length) flags.push("无明显极端风险");
  return flags;
}

function calculateDataQuality(records, bookmakers, markets) {
  const recordScore = clamp(records.length / 120 * 36, 0, 36);
  const bookmakerScore = clamp(bookmakers.length / 12 * 30, 0, 30);
  const kellyScore = records.some((record) => Number.isFinite(record.kellyHome)) ? 14 : 0;
  const marketScore = ((markets?.asian?.records?.length || 0) ? 10 : 0) + ((markets?.totals?.records?.length || 0) ? 10 : 0);
  return Math.round(recordScore + bookmakerScore + kellyScore + marketScore);
}

function hasBettingSignal(analysis) {
  return sumOutcomeAmounts(analysis?.volume) > 0
    || sumOutcomeAmounts(analysis?.largeVolume) > 0
    || (analysis?.trend || []).length > 0;
}

function estimateStrengthFromProbability(probability) {
  return {
    homeEdge: probability.home - probability.away,
    favorite: probability.home >= probability.away ? "home" : "away",
  };
}

function bookmakerWeight(bookmaker, config) {
  const name = String(bookmaker?.bookmaker || "");
  const mainWeight = bookmaker?.isMain ? config.bookmaker.mainWeight : 1;
  const brandWeight = config.bookmaker.mainNames.some((keyword) => name.includes(keyword)) ? config.bookmaker.brandWeight : 1;
  const tierWeight = config.bookmaker.tiers.find((tier) => tier.keywords.some((keyword) => name.includes(keyword)))?.weight || 1;
  const liquidityWeight = Math.min(
    config.bookmaker.liquidityCap,
    config.bookmaker.liquidityBase + Math.max(0, bookmaker?.count || 1) * config.bookmaker.liquidityPerRecord,
  );
  return mainWeight * brandWeight * tierWeight * liquidityWeight;
}

function calculateRecencyWeight(record, match, config) {
  const recordTime = timeValue(record);
  const kickoffTime = match?.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())
    ? match.kickoffTime.getTime()
    : null;
  if (!Number.isFinite(recordTime) || !Number.isFinite(kickoffTime) || recordTime <= 0) return 1;
  const hoursBefore = Math.max(0, (kickoffTime - recordTime) / 3600000);
  const halfLife = Math.max(1, config.probability.recencyHalfLifeHours);
  return clamp(2 ** (-hoursBefore / halfLife) * 0.55 + 0.55, config.probability.recencyMinWeight, 1.12);
}

function calculateMovementWeight(movement, config) {
  const size = Math.sqrt(OUTCOMES.reduce((sum, key) => sum + (Number.isFinite(movement?.[key]) ? movement[key] ** 2 : 0), 0));
  return clamp(1 + size * config.probability.movementInfluence, 0.94, 1.16);
}

function topProbabilityKey(probability) {
  return OUTCOMES
    .map((key) => ({ key, value: probability?.[key] }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)[0]?.key || "";
}

function filterRecordsByWindow(records, match, hours) {
  const sorted = records.slice().sort((a, b) => timeValue(a) - timeValue(b));
  const anchor = getWindowAnchor(sorted, match);
  if (!Number.isFinite(anchor)) return sorted;
  const start = anchor - hours * 3600000;
  return sorted.filter((record) => {
    const value = timeValue(record);
    return Number.isFinite(value) && value >= start && value <= anchor;
  });
}

function filterRowsByWindow(rows, match, hours) {
  const sorted = rows.slice().sort((a, b) => timeTextValue(a.time) - timeTextValue(b.time));
  const anchor = getWindowAnchor(sorted, match, (row) => timeTextValue(row.time));
  if (!Number.isFinite(anchor)) return sorted;
  const start = anchor - hours * 3600000;
  return sorted.filter((row) => {
    const value = timeTextValue(row.time);
    return Number.isFinite(value) && value >= start && value <= anchor;
  });
}

function getWindowAnchor(rows, match, read = timeValue) {
  const kickoff = match?.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())
    ? match.kickoffTime.getTime()
    : null;
  if (Number.isFinite(kickoff)) return kickoff;
  return rows.map(read).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a)[0] ?? null;
}

function averageOddsRow(rows) {
  return {
    home: average(rows.map((row) => row.homeOdds ?? row.home)),
    draw: average(rows.map((row) => row.drawOdds ?? row.draw)),
    away: average(rows.map((row) => row.awayOdds ?? row.away)),
  };
}

function oddsDeltaToProbabilityDelta(firstOdds, lastOdds) {
  if (!Number.isFinite(firstOdds) || !Number.isFinite(lastOdds) || firstOdds <= 1 || lastOdds <= 1) return null;
  return (1 / lastOdds) - (1 / firstOdds);
}

function strongestDelta(delta) {
  return OUTCOMES
    .map((key) => ({ key, value: delta?.[key] }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0] || null;
}

function pathMoveLabel(value, config) {
  if (!Number.isFinite(value)) return "样本不足";
  const abs = Math.abs(value);
  if (abs >= config.pattern.pathMoveStrong) return value > 0 ? "强上行" : "强下行";
  if (abs >= config.pattern.pathMoveWarn) return value > 0 ? "上行" : "下行";
  return "平稳";
}

function averageMovement(companies) {
  return OUTCOMES.reduce((acc, key) => {
    acc[key] = average(companies.map((item) => item.movement?.[key]));
    return acc;
  }, {});
}

function probabilityEntropy(probability) {
  const entropy = OUTCOMES.reduce((sum, key) => {
    const value = Number.isFinite(probability?.[key]) && probability[key] > 0 ? probability[key] : 0;
    return value ? sum - value * Math.log(value) : sum;
  }, 0);
  return entropy / Math.log(OUTCOMES.length);
}

function uncertaintyLevel(score) {
  if (score >= 72) return "高随机";
  if (score >= 52) return "中性观察";
  if (score >= 34) return "可控但需复核";
  return "信号集中";
}

function numericDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

function roundMetric(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function splitHandicap(line) {
  const value = Number(line);
  if (!Number.isFinite(value)) return [0];
  const abs = Math.abs(value);
  const integer = Math.trunc(abs);
  const decimal = Number((abs - integer).toFixed(2));
  const sign = Math.sign(value) || 1;

  if (decimal === 0.25) return [sign * integer, sign * (integer + 0.5)];
  if (decimal === 0.75) return [sign * (integer + 0.5), sign * (integer + 1)];
  return [value];
}

function coverForLine(goalMatrix, line) {
  return flattenMatrix(goalMatrix)
    .filter((cell) => cell.homeGoals - cell.awayGoals + line > 0)
    .reduce((sum, cell) => sum + cell.probability, 0);
}

function pushForLine(goalMatrix, line) {
  return flattenMatrix(goalMatrix)
    .filter((cell) => cell.homeGoals - cell.awayGoals + line === 0)
    .reduce((sum, cell) => sum + cell.probability, 0);
}

function normalizeProbability(value) {
  const total = OUTCOMES.reduce((sum, key) => sum + (Number.isFinite(value?.[key]) ? value[key] : 0), 0);
  if (!total) return emptyProbability();
  return {
    home: value.home / total,
    draw: value.draw / total,
    away: value.away / total,
  };
}

function emptyProbability() {
  return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}

function sumOutcomeAmounts(amounts) {
  return OUTCOMES.reduce((sum, key) => sum + (Number.isFinite(amounts?.[key]) ? amounts[key] : 0), 0);
}

function hasOddsTriple(record) {
  return Number.isFinite(record?.homeOdds) && Number.isFinite(record?.drawOdds) && Number.isFinite(record?.awayOdds);
}

function flattenMatrix(matrix) {
  return matrix.flatMap((row) => row);
}

function poisson(k, lambda) {
  return Math.exp(-lambda) * lambda ** k / factorial(k);
}

function factorial(value) {
  let result = 1;
  for (let index = 2; index <= value; index += 1) result *= index;
  return result;
}

function probabilityDistance(a, b) {
  return Math.sqrt(OUTCOMES.reduce((sum, key) => sum + (a[key] - b[key]) ** 2, 0));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const mean = average(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length);
}

function safeRatio(value, total) {
  return Number.isFinite(value) && total ? value / total : 0;
}

function timeValue(record) {
  return Number.isFinite(record?.timeMs) ? record.timeMs : timeTextValue(record?.time);
}

function timeTextValue(value) {
  if (!value) return 0;
  const normalized = String(value).replace(/\//g, "-").replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTimeBucket(record) {
  if (record?.time) return record.time;
  if (Number.isFinite(record?.timeMs)) return new Date(record.timeMs).toLocaleString("zh-CN", { hour12: false });
  return record?.type || "即时";
}

function readMarketLine(value) {
  if (Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Number.parseFloat(text.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readWater(value) {
  if (Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Number.parseFloat(text.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function waterToDecimalOdds(water, config) {
  if (!Number.isFinite(water)) return null;
  if (water > 1.5) return water;
  return 1 + Math.max(0.01, water);
}

function twoWayWaterProbability(primaryWater, secondaryWater, config) {
  const primaryOdds = waterToDecimalOdds(primaryWater, config);
  const secondaryOdds = waterToDecimalOdds(secondaryWater, config);
  if (!Number.isFinite(primaryOdds) || !Number.isFinite(secondaryOdds)) {
    return { primary: null, secondary: null, home: null, away: null };
  }
  const primaryRaw = 1 / primaryOdds;
  const secondaryRaw = 1 / secondaryOdds;
  const total = primaryRaw + secondaryRaw;
  return {
    primary: total ? primaryRaw / total : null,
    secondary: total ? secondaryRaw / total : null,
    home: total ? primaryRaw / total : null,
    away: total ? secondaryRaw / total : null,
  };
}

function marketValueLabel(edge, config) {
  if (!Number.isFinite(edge)) return "等待水位";
  if (edge >= config.market.valueEdgeThreshold) return "模型价值偏高";
  if (edge <= -config.market.valueEdgeThreshold) return "市场价格偏贵";
  return "盘口价格接近";
}

function handicapBiasLabel(value) {
  if (!Number.isFinite(value)) return "等待盘口";
  if (value <= -0.35) return "实际盘口比欧赔更深";
  if (value <= -0.14) return "实际盘口略深";
  if (value >= 0.35) return "实际盘口比欧赔更浅";
  if (value >= 0.14) return "实际盘口略浅";
  return "盘口基本匹配";
}

function scoreRating(score) {
  if (score >= 82) return "A 强信号";
  if (score >= 70) return "B 稳定";
  if (score >= 58) return "C 观察";
  if (score >= 42) return "D 高风险";
  return "E 等待数据";
}

function topScores(scoreMatrix, count) {
  return flattenMatrix(scoreMatrix)
    .slice()
    .sort((a, b) => b.probability - a.probability)
    .slice(0, count);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDecimal(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toFixed(digits);
}

function formatHandicap(value) {
  if (!Number.isFinite(value)) return "--";
  if (value === 0) return "平手";
  const side = value < 0 ? "主让" : "客让";
  return `${side}${Math.abs(value).toFixed(2).replace(/\.00$/, "")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
