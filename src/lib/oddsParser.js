const KNOWN_BOOKMAKER_WORDS = [
  "竞彩",
  "威廉",
  "立博",
  "澳门",
  "Bet365",
  "Bwin",
  "易胜博",
  "皇冠",
  "伟德",
  "Interwetten",
  "明陞",
  "SNAI",
  "Oddset",
  "Pinnacle",
];

const CHINESE_NUMERAL_MAP = new Map([
  ["０", "0"],
  ["１", "1"],
  ["２", "2"],
  ["３", "3"],
  ["４", "4"],
  ["５", "5"],
  ["６", "6"],
  ["７", "7"],
  ["８", "8"],
  ["９", "9"],
  ["．", "."],
  ["％", "%"],
]);

const SCHEDULE_LOOKBACK_DAYS = 7;
const SCHEDULE_LOOKAHEAD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SINGLE_MATCH_BET_TYPE = "单场比分";
const ODDS_WEIGHT_WINDOW_MINUTES = 72 * 60;
const ODDS_WEIGHT_WINDOW_MS = ODDS_WEIGHT_WINDOW_MINUTES * MINUTE_MS;
const ODDS_WEIGHT_MODE_KEYS = new Set(["hot", "normal", "cold"]);
const ODDS_WEIGHT_POINTS = [
  { minutesBeforeKickoff: 72 * 60, hot: 0.20, normal: 0.40, cold: 0.80 },
  { minutesBeforeKickoff: 48 * 60, hot: 0.35, normal: 0.55, cold: 0.90 },
  { minutesBeforeKickoff: 36 * 60, hot: 0.50, normal: 0.70, cold: 1.00 },
  { minutesBeforeKickoff: 24 * 60, hot: 0.75, normal: 0.90, cold: 1.10 },
  { minutesBeforeKickoff: 12 * 60, hot: 1.00, normal: 1.10, cold: 1.20 },
  { minutesBeforeKickoff: 6 * 60, hot: 1.25, normal: 1.30, cold: 1.30 },
  { minutesBeforeKickoff: 3 * 60, hot: 1.50, normal: 1.45, cold: 1.40 },
  { minutesBeforeKickoff: 2 * 60, hot: 1.80, normal: 1.60, cold: 1.50 },
  { minutesBeforeKickoff: 1 * 60, hot: 2.20, normal: 1.80, cold: 1.60 },
  { minutesBeforeKickoff: 30, hot: 2.60, normal: 2.00, cold: 1.70 },
  { minutesBeforeKickoff: 15, hot: 3.00, normal: 2.20, cold: 1.80 },
];

export function parseOddsPayload(payload, match) {
  const normalized = normalizeHtmlText(payload);
  const doc = parseHtmlDocument(normalized);
  const explicitHistory = parseHistoryTables(doc, match);
  const summaryRecords = parseSummaryRows(doc, match);
  const records = mergeRecords(explicitHistory.length ? explicitHistory : summaryRecords);
  return buildOddsResult(records, match);
}

export function buildOddsResult(records, match) {
  const sortedRecords = sortRecords(mergeRecords(records), match);
  const bookmakers = summarizeBookmakers(sortedRecords, match);
  return {
    records: sortedRecords,
    bookmakers,
  };
}

export function findMatchCandidate(payload, match, baseUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const doc = parseHtmlDocument(normalized);
  const anchors = [...doc.querySelectorAll("a[href]")];
  const homeKey = normalizeTeamName(match.homeTeam);
  const awayKey = normalizeTeamName(match.awayTeam);
  const kickoffDate = match.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())
    ? match.kickoffTime
    : null;

  const candidates = anchors
    .map((anchor) => buildLinkCandidate(anchor, baseUrl, kickoffDate))
    .filter((candidate) => candidate.href && /fenxi|ouzhi|odds/i.test(candidate.href));

  const exact = candidates.find((candidate) => {
    const textKey = normalizeTeamName(candidate.context);
    const teamsMatch = textKey.includes(homeKey) && textKey.includes(awayKey);
    const timeMatch = !kickoffDate || candidate.times.some((time) => isNearKickoff(time, kickoffDate));
    return teamsMatch && timeMatch;
  });
  if (exact) return candidateToOddsUrl(exact, match);

  const teamOnly = candidates.find((candidate) => {
    const textKey = normalizeTeamName(candidate.context);
    return textKey.includes(homeKey) && textKey.includes(awayKey);
  });
  return teamOnly ? candidateToOddsUrl(teamOnly, match) : null;
}

export function parseFixtureConfig(payload, oddsUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const fixtureId = extractFixtureId(oddsUrl) || matchNumber(normalized, /_id\s*=\s*(\d{5,})/) || matchNumber(normalized, /fid["']?\s*[:=]\s*["']?(\d{5,})/);
  const limit = matchNumber(normalized, /_limit\s*=\s*(\d+)/) || 30;
  const total = matchNumber(normalized, /window\._total\s*=\s*(\d+)/) || null;
  const explicitStart = matchNumber(normalized, /_start\s*=\s*(\d+)/);

  return {
    fixtureId,
    total,
    limit,
    start: explicitStart || limit,
    r: matchNumber(normalized, /_r\s*=\s*(-?\d+)/) ?? 1,
    ctype: matchNumber(normalized, /_ctype\s*=\s*(\d+)/) ?? 1,
    style: matchNumber(normalized, /_style\s*=\s*(\d+)/) ?? 0,
    guojia: 0,
    chupan: 1,
  };
}

export function parseBookmakerRows(payload, match) {
  const normalized = normalizeHtmlText(payload);
  const doc = parseHtmlDocument(normalized);
  return parseBookmakerRowsFromDoc(doc, match);
}

export function parseMatchInfo(payload, oddsUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const doc = typeof DOMParser !== "undefined" ? parseHtmlDocument(normalized) : null;
  const title = cleanText(doc?.querySelector("title")?.textContent);
  const fallbackTitle = cleanText(normalized.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const headerText = cleanText(doc?.querySelector(".odds_header")?.textContent || doc?.querySelector(".odds_hd_cont")?.textContent);
  const nameNodes = doc ? [...doc.querySelectorAll(".odds_header .hd_name, .odds_hd_cont .hd_name, .odds_header a[href*='/team/']")]
    .map((node) => cleanTeamLabel(node.textContent))
    .filter(Boolean) : extractTeamNamesFromHtml(normalized);
  const titleTeams = extractTeamsFromTitle(title || fallbackTitle);
  const context = cleanText(`${title || fallbackTitle} ${headerText} ${normalized.slice(0, 12000)}`);
  const kickoffTime = extractKickoffDate(context);

  return {
    fixtureId: extractFixtureId(oddsUrl) || matchNumber(normalized, /_id\s*=\s*(\d{5,})/) || "",
    homeTeam: titleTeams.homeTeam || nameNodes[0] || "",
    awayTeam: titleTeams.awayTeam || inferAwayTeamFromNames(nameNodes, titleTeams.homeTeam) || "",
    matchType: titleTeams.matchType || inferMatchType(context),
    kickoffTime,
  };
}

export function parseMatchResult(payload, fixture = {}, sourceUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const fixtureId = fixture.fixtureId || extractFixtureId(sourceUrl);
  const doc = typeof DOMParser !== "undefined" ? parseHtmlDocument(normalized) : null;
  const currentMatchScore = fixtureId ? getDetailCurrentMatchScore(normalized, doc, fixtureId) : "";

  const score = [
    currentMatchScore,
  ].map(parseResultScore).find(Boolean);

  return score ? buildFixtureResult(score.homeScore, score.awayScore) : emptyFixtureResult();
}

export function mergeBookmakerLists(...lists) {
  const merged = new Map();
  lists.flat().filter(Boolean).forEach((company) => {
    const key = company.cid || company.bookmaker;
    if (!key || merged.has(key)) return;
    merged.set(key, company);
  });
  return [...merged.values()];
}

export function buildMoreBookmakersUrl(config, start = config?.start || 30) {
  if (!config?.fixtureId) return "";
  const params = new URLSearchParams({
    id: config.fixtureId,
    ctype: String(config.ctype ?? 1),
    start: String(start),
    r: String(config.r ?? 1),
    style: String(config.style ?? 0),
    last: "1",
    guojia: String(config.guojia ?? 0),
    chupan: String(config.chupan ?? 1),
  });
  return `https://odds.500.com/fenxi1/ouzhi.php?${params.toString()}`;
}

export function buildOddsHistoryUrl(config, company, type) {
  if (!config?.fixtureId || !company?.cid || !company?.dataTime) return "";
  const params = new URLSearchParams({
    fid: config.fixtureId,
    cid: company.cid,
    r: String(config.r ?? 1),
    time: company.dataTime,
    type,
  });
  return `https://odds.500.com/fenxi1/json/ouzhi.php?${params.toString()}`;
}

export function buildBettingAnalysisUrls(config) {
  if (!config?.fixtureId) return [];
  return [
    `https://odds.500.com/fenxi/touzhu-${config.fixtureId}.shtml`,
    `https://odds.500.com/fenxi/shuju-${config.fixtureId}.shtml`,
    `https://odds.500.com/fenxi/bifa-${config.fixtureId}.shtml`,
    `https://odds.500.com/fenxi1/json/bifa.php?fid=${config.fixtureId}`,
    `https://odds.500.com/fenxi1/json/touzhu.php?fid=${config.fixtureId}`,
    `https://odds.500.com/fenxi1/bifa.php?id=${config.fixtureId}`,
    `https://odds.500.com/fenxi1/touzhu.php?id=${config.fixtureId}`,
  ];
}

export function parseBettingAnalysisPayload(payload, match = {}, sourceUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const scriptData = parseBettingScriptData(normalized, match, sourceUrl);
  if (hasParsedBettingData(scriptData)) return scriptData;

  const jsonData = parseJsonPayload(normalized);
  if (jsonData) {
    const parsedJson = parseBettingAnalysisJson(jsonData, match, sourceUrl);
    if (hasParsedBettingData(parsedJson)) return parsedJson;
  }

  const doc = parseHtmlDocument(normalized);
  const sections = getBettingSections(doc);
  const sectionText = sections.map((node) => cleanText(node.textContent)).join(" ");

  const volume = pickBestOutcomeAmounts(sections, [/必发.*交易|交易量|成交量|成交额/]);
  const trend = extractBettingTrend(sections, normalized, match);
  const largeVolume = pickBestOutcomeAmounts(sections, [/大额.*交易量|大额成交|大额交易/]);
  const largeDistribution = extractLargeDistribution(sections);
  const largeDetails = extractLargeTradeDetails(sections, match);

  return {
    sourceUrl,
    volume,
    trend,
    largeVolume,
    largeDistribution,
    largeDetails,
    summaryText: extractBettingSummaryText(sectionText),
  };
}

export function parseOddsHistoryPayload(payload, company, type, match) {
  const data = parseJsonPayload(payload);
  if (!Array.isArray(data)) {
    if (data?.code === -100) throw new Error("目标站点要求登录后才能读取该公司历史数据");
    return [];
  }

  return data.map((row, index) => {
    if (!Array.isArray(row)) return null;
    const time = normalizeTimeString(row[type === "kelly" ? 3 : 4]);
    if (type === "kelly") {
      return {
        cid: company.cid,
        bookmaker: company.bookmaker,
        isMain: company.isMain,
        time,
        cutoff: isBeforeKickoff(time, match.kickoffTime),
        homeOdds: null,
        drawOdds: null,
        awayOdds: null,
        returnRate: null,
        kellyHome: parseNumber(row[0]),
        kellyDraw: parseNumber(row[1]),
        kellyAway: parseNumber(row[2]),
        sequence: index,
        type: "凯利",
      };
    }

    return {
      cid: company.cid,
      bookmaker: company.bookmaker,
      isMain: company.isMain,
      time,
      cutoff: isBeforeKickoff(time, match.kickoffTime),
      homeOdds: parseNumber(row[0]),
      drawOdds: parseNumber(row[1]),
      awayOdds: parseNumber(row[2]),
      returnRate: parseNumber(row[3]),
      kellyHome: null,
      kellyDraw: null,
      kellyAway: null,
      sequence: index,
      type: "欧赔",
    };
  }).filter(Boolean);
}

export function buildOddsUrl(input) {
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) {
    const id = input.match(/(?:ouzhi-|shuju-|id=|fenxi[^0-9]*)(\d{5,})/i)?.[1] || input.match(/\/(\d{5,})(?:\.shtml|\/)?$/)?.[1];
    if (/odds\.500\.com|500\.com\/fenxi/i.test(input) && id) {
      return `https://odds.500.com/fenxi/ouzhi-${id}.shtml`;
    }
    return input;
  }

  const id = input.match(/\d{5,}/)?.[0];
  if (!id) return "";
  return `https://odds.500.com/fenxi/ouzhi-${id}.shtml`;
}

export function buildScheduleUrls(match) {
  if (match.scheduleInput) return [match.scheduleInput];
  if (!(match.kickoffTime instanceof Date) || Number.isNaN(match.kickoffTime.getTime())) return [];

  const ymd = `${match.kickoffTime.getFullYear()}${pad(match.kickoffTime.getMonth() + 1)}${pad(match.kickoffTime.getDate())}`;
  const ymdDash = `${match.kickoffTime.getFullYear()}-${pad(match.kickoffTime.getMonth() + 1)}-${pad(match.kickoffTime.getDate())}`;
  return [
    `https://live.500.com/?e=${ymd}`,
    `https://live.500.com/wanchang.php?e=${ymd}`,
    `https://live.500.com/zqdc.php?e=${ymd}`,
    `https://live.500.com/jczq.php?date=${ymdDash}`,
  ];
}

export function buildScheduleScanUrls(baseDate = new Date()) {
  const base = startOfLocalDay(baseDate);
  const dates = [];
  for (let offset = -SCHEDULE_LOOKBACK_DAYS; offset <= SCHEDULE_LOOKAHEAD_DAYS; offset += 1) {
    dates.push(new Date(base.getTime() + offset * DAY_MS));
  }

  return [...new Set(dates.flatMap((date) => {
    const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const ymdDash = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return [
      "https://live.500.com/zqdc.php",
      `https://live.500.com/zqdc.php?e=${ymd}`,
      `https://live.500.com/zqdc.php?e=${ymdDash}`,
      `https://live.500.com/zqdc.php?date=${ymdDash}`,
    ];
  }))];
}

export function buildFutureScheduleUrls(baseDate = new Date()) {
  return buildScheduleScanUrls(baseDate);
}

export function extractScheduleScanUrls(payload, baseUrl = "") {
  const normalized = normalizeHtmlText(payload);
  const urls = [];
  const add = (url) => {
    if (url && !urls.includes(url)) urls.push(url);
  };

  for (const match of normalized.matchAll(/live_expect_list\s*=\s*(\[[^\]]+\])/gi)) {
    parseJsonPayload(match[1])?.forEach((expect) => {
      const value = cleanText(expect);
      if (/^\d{4,8}$/.test(value)) add(`https://live.500.com/zqdc.php?e=${value}`);
    });
  }

  for (const match of normalized.matchAll(/<option[^>]*value=["']?(\d{4,8})["']?/gi)) {
    add(`https://live.500.com/zqdc.php?e=${match[1]}`);
  }

  for (const match of normalized.matchAll(/zqdc\.php\?e=(\d{4,8})/gi)) {
    add(absolutizeUrl(`/zqdc.php?e=${match[1]}`, baseUrl || "https://live.500.com/zqdc.php"));
  }

  return urls;
}

export function parseScheduleFixtures(payload, baseUrl = "", now = new Date()) {
  const normalized = normalizeHtmlText(payload);
  const base = startOfLocalDay(now);
  const windowStart = base.getTime() - SCHEDULE_LOOKBACK_DAYS * DAY_MS;
  const windowEnd = endOfLocalDay(new Date(base.getTime() + SCHEDULE_LOOKAHEAD_DAYS * DAY_MS)).getTime();
  const rowContexts = buildScheduleRowContexts(normalized);
  const pageBetType = inferPageBetType(normalized, baseUrl);

  return rowContexts
    .map(({ row, headers }) => parseFutureFixtureRow(row, baseUrl, now, headers, pageBetType))
    .filter((fixture) => {
      const kickoffMs = fixture?.kickoffTime?.getTime();
      return fixture
        && Number.isFinite(kickoffMs)
        && kickoffMs >= windowStart
        && kickoffMs <= windowEnd
        && isSingleMatchFixture(fixture);
      });
}

export function parseFutureFixtures(payload, baseUrl = "", now = new Date()) {
  return parseScheduleFixtures(payload, baseUrl, now);
}

export function applyProxy(url, prefix) {
  if (!prefix) return url;
  return `${prefix}${encodeURIComponent(url)}`;
}

export function buildRequestUrl(url, proxyPrefix = "") {
  if (proxyPrefix) return applyProxy(url, proxyPrefix);
  if (!isLocalDev()) return url;

  try {
    const parsed = new URL(url);
    const targetKey = getProxyTargetKey(parsed.hostname);
    if (!targetKey) return url;
    return `/proxy500/${targetKey}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export async function decodeResponse(response) {
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "";
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim();
  const candidates = [charset, "gb18030", "gbk", "gb2312", "utf-8"].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(buffer);
    } catch {
      // Try the next decoder.
    }
  }

  return new TextDecoder("utf-8").decode(buffer);
}

export function toDatetimeLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDisplayDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "--";
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  return `${date} ${time}`;
}

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toFixed(digits);
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toFixed(2)}%`;
}

export function formatOddsTriple(record) {
  return [record.homeOdds, record.drawOdds, record.awayOdds].map((value) => formatNumber(value)).join(" / ");
}

export function numericDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

export function buildWeightedOddsTimeline(records, match) {
  const kickoffMs = getKickoffWindowEnd(records, match);
  const stateRows = buildOddsStateRows(records, match);

  return stateRows.map((record, index) => {
    const weight = calculateRecordWeight(stateRows, index, kickoffMs, match);
    return {
      ...record,
      holdMinutes: weight.holdMinutes,
      weightCoefficient: weight.coefficient,
      weightMinutes: weight.weightMinutes,
    };
  });
}

function parseHistoryTables(doc, match) {
  const records = [];
  const tables = [...doc.querySelectorAll("table")];

  tables.forEach((table) => {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length < 2) return;

    const tableText = cleanText(table.textContent);
    const firstRowCells = getRowCells(rows[0]);
    const headerText = firstRowCells.join("|") || tableText.slice(0, 160);
    const kind = detectHistoryKind(headerText, tableText, table);
    if (!kind) return;

    const company = getCompanyNameFromContext(table) || inferCompanyFromRows(rows) || "未知公司";
    rows.slice(1).forEach((row, index) => {
      const cells = getRowCells(row);
      if (cells.length < 4 || !cells.some(looksNumeric)) return;

      const record = kind === "kelly"
        ? parseKellyHistoryRow(cells, company, match)
        : parseEuroHistoryRow(cells, company, match);

      if (record) {
        record.sequence = index;
        records.push(record);
      }
    });
  });

  return records;
}

function detectHistoryKind(headerText, tableText, table) {
  const marker = `${table.dataset.history || ""} ${table.className || ""} ${table.id || ""}`;
  const haystack = `${marker} ${headerText} ${tableText}`;
  const hasTime = /时间|变化|更新|变动|日期|time/i.test(haystack);
  const hasWinDrawLose = /胜|平|负|主胜|客胜|draw|home|away/i.test(haystack);
  const hasKelly = /凯|kelly/i.test(haystack);
  const hasReturn = /返还|回报|return|赔付/i.test(haystack);

  if (hasKelly && hasTime) return "kelly";
  if ((hasReturn || hasWinDrawLose) && hasTime && !/公司|筛选/.test(headerText)) return "euro";
  return null;
}

function parseEuroHistoryRow(cells, company, match) {
  const nums = cells.map(parseNumber).filter((value) => value !== null);
  if (nums.length < 3) return null;

  const time = extractTimeFromCells(cells);
  return {
    bookmaker: company,
    time,
    cutoff: isBeforeKickoff(time, match.kickoffTime),
    homeOdds: nums[0],
    drawOdds: nums[1],
    awayOdds: nums[2],
    returnRate: inferReturnRate(cells, nums.slice(3), nums.slice(0, 3)),
    kellyHome: null,
    kellyDraw: null,
    kellyAway: null,
    type: "历史欧赔",
  };
}

function parseKellyHistoryRow(cells, company, match) {
  const nums = cells.map(parseNumber).filter((value) => value !== null);
  if (nums.length < 3) return null;

  const time = extractTimeFromCells(cells);
  return {
    bookmaker: company,
    time,
    cutoff: isBeforeKickoff(time, match.kickoffTime),
    homeOdds: null,
    drawOdds: null,
    awayOdds: null,
    returnRate: null,
    kellyHome: nums[0],
    kellyDraw: nums[1],
    kellyAway: nums[2],
    type: "历史凯利",
  };
}

function parseSummaryRows(doc, match) {
  const records = [];
  const bookmakerRows = parseBookmakerRowsFromDoc(doc, match);

  if (bookmakerRows.length) {
    bookmakerRows.forEach((company) => {
      if (company.opening) {
        records.push({
          cid: company.cid,
          bookmaker: company.bookmaker,
          isMain: company.isMain,
          time: null,
          cutoff: true,
          homeOdds: company.opening.homeOdds,
          drawOdds: company.opening.drawOdds,
          awayOdds: company.opening.awayOdds,
          returnRate: company.opening.returnRate,
          kellyHome: company.opening.kellyHome,
          kellyDraw: company.opening.kellyDraw,
          kellyAway: company.opening.kellyAway,
          type: "开盘",
        });
      }

      if (company.latest) {
        records.push({
          cid: company.cid,
          bookmaker: company.bookmaker,
          isMain: company.isMain,
          time: company.dataTime || null,
          cutoff: isBeforeKickoff(company.dataTime, match.kickoffTime),
          homeOdds: company.latest.homeOdds,
          drawOdds: company.latest.drawOdds,
          awayOdds: company.latest.awayOdds,
          returnRate: company.latest.returnRate,
          kellyHome: company.latest.kellyHome,
          kellyDraw: company.latest.kellyDraw,
          kellyAway: company.latest.kellyAway,
          type: "即时",
        });
      }
    });
    return records;
  }

  const rows = [...doc.querySelectorAll("tr")];

  rows.forEach((row) => {
    const cells = getRowCells(row);
    if (cells.length < 8) return;

    const rowText = cells.join(" ");
    if (!looksLikeOddsRow(rowText, cells)) return;

    const company = getCompanyNameFromRow(row, cells);
    const nums = cells.map(parseNumber).filter((value) => value !== null);
    if (nums.length < 6) return;

    const times = cells.map(extractTime).filter(Boolean);
    const openingTime = times[0] || null;
    const latestTime = times[times.length - 1] || null;
    const openingOdds = nums.slice(0, 3);
    const latestOdds = nums.slice(3, 6);
    const rateCandidates = nums.slice(6).filter((value) => value > 20 && value <= 100);
    const kellyCandidates = nums.slice(6).filter((value) => value > 0 && value < 1.6);
    const openingReturn = rateCandidates[0] ?? calculateReturnRate(openingOdds);
    const latestReturn = rateCandidates[1] ?? calculateReturnRate(latestOdds);
    const openingKelly = kellyCandidates.slice(0, 3);
    const latestKelly = kellyCandidates.slice(3, 6);

    records.push({
      bookmaker: company,
      time: openingTime,
      cutoff: isBeforeKickoff(openingTime, match.kickoffTime),
      homeOdds: openingOdds[0],
      drawOdds: openingOdds[1],
      awayOdds: openingOdds[2],
      returnRate: openingReturn,
      kellyHome: openingKelly[0] ?? null,
      kellyDraw: openingKelly[1] ?? null,
      kellyAway: openingKelly[2] ?? null,
      type: "开盘",
    });

    records.push({
      bookmaker: company,
      time: latestTime,
      cutoff: isBeforeKickoff(latestTime, match.kickoffTime),
      homeOdds: latestOdds[0],
      drawOdds: latestOdds[1],
      awayOdds: latestOdds[2],
      returnRate: latestReturn,
      kellyHome: latestKelly[0] ?? null,
      kellyDraw: latestKelly[1] ?? null,
      kellyAway: latestKelly[2] ?? null,
      type: "即时",
    });
  });

  return records;
}

function parseBookmakerRowsFromDoc(doc, match) {
  const scopedRows = [...doc.querySelectorAll("#datatb tr[xls='row'], #datatb tr[xls=\"row\"]")];
  const rows = scopedRows.length ? scopedRows : [...doc.querySelectorAll("tr[xls='row'], tr[xls=\"row\"]")];

  return rows
    .map((row) => parseBookmakerRow(row, match))
    .filter(Boolean);
}

function parseBettingAnalysisJson(data, match, sourceUrl) {
  const nodes = flattenJsonNodes(data);
  const volume = pickJsonOutcomeAmounts(nodes, [/必发|交易量|成交量|成交额|volume|amount|total/i]);
  const trend = extractTrendFromJson(nodes, match);
  const largeVolume = pickJsonOutcomeAmounts(nodes, [/大额|large|big/i]);
  const largeDistribution = extractDistributionFromJson(nodes);
  const largeDetails = extractLargeDetailsFromJson(nodes, match);

  return {
    sourceUrl,
    volume,
    trend,
    largeVolume,
    largeDistribution,
    largeDetails,
    summaryText: extractBettingSummaryText(nodes.map((node) => node.text).join(" ")),
  };
}

function parseBettingScriptData(payload, match, sourceUrl) {
  const variables = readScriptVariables(payload, [
    "trade_win",
    "trade_draw",
    "trade_lost",
    "trade_time",
    "trade_list",
    "trade_odds",
    "big_list",
    "big_buy",
    "big_sell",
  ]);
  const tradeList = parseMoneySeries(variables.trade_list);
  const bigList = parseMoneySeries(variables.big_list);
  const tradeWin = parseMoneySeries(variables.trade_win);
  const tradeDraw = parseMoneySeries(variables.trade_draw);
  const tradeLost = parseMoneySeries(variables.trade_lost);
  const times = splitCsvText(variables.trade_time);
  const largeDetails = extractLargeTradeDetailsFromHtml(payload, match);
  const summaryText = extractBettingTipsFromHtml(payload) || extractBettingSummaryText(cleanText(stripHtml(payload)));

  return {
    sourceUrl,
    volume: outcomeAmountsFromSeries(tradeList),
    trend: buildScriptTrendRows(times, tradeWin, tradeDraw, tradeLost, match),
    largeVolume: outcomeAmountsFromSeries(bigList),
    largeDistribution: {
      home: { buy: parseMoneySeries(variables.big_buy)[0] ?? null, sell: parseMoneySeries(variables.big_sell)[0] ?? null },
      draw: { buy: parseMoneySeries(variables.big_buy)[1] ?? null, sell: parseMoneySeries(variables.big_sell)[1] ?? null },
      away: { buy: parseMoneySeries(variables.big_buy)[2] ?? null, sell: parseMoneySeries(variables.big_sell)[2] ?? null },
    },
    largeDetails,
    summaryText,
  };
}

function readScriptVariables(payload, names) {
  const result = {};
  names.forEach((name) => {
    const pattern = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*["']([^"']*)["']`, "i");
    result[name] = String(payload || "").match(pattern)?.[1] || "";
  });
  return result;
}

function splitCsvText(value) {
  return String(value || "").split(",").map(cleanText).filter(Boolean);
}

function parseMoneySeries(value) {
  return splitCsvText(value).map(parseMoneyAmount).filter(Number.isFinite);
}

function outcomeAmountsFromSeries(values) {
  return {
    home: values[0] ?? null,
    draw: values[1] ?? null,
    away: values[2] ?? null,
  };
}

function buildScriptTrendRows(times, homeValues, drawValues, awayValues, match) {
  const length = Math.max(times.length, homeValues.length, drawValues.length, awayValues.length);
  return Array.from({ length }, (_, index) => ({
    time: normalizeTimeForChart(times[index] || "", match),
    home: homeValues[index] ?? null,
    draw: drawValues[index] ?? null,
    away: awayValues[index] ?? null,
  })).filter((row) => ["home", "draw", "away"].some((key) => Number.isFinite(row[key]))).slice(-60);
}

function extractLargeTradeDetailsFromHtml(payload, match) {
  const html = String(payload || "");
  const headerIndex = html.search(/<th>\s*综合\s*<\/th>/i);
  const tableStart = headerIndex >= 0 ? html.lastIndexOf("<table", headerIndex) : -1;
  const tableEnd = tableStart >= 0 ? html.indexOf("</table>", headerIndex) : -1;
  const tableHtml = tableStart >= 0 && tableEnd > tableStart ? html.slice(tableStart, tableEnd + 8) : "";
  if (!tableHtml) return [];

  return extractRowHtmlFragments(tableHtml)
    .map(getFutureRowCells)
    .filter((cells) => cells.length >= 5 && !/综合|属性|成交量/.test(cells.join(" ")))
    .map((cells) => ({
      time: normalizeTimeForChart(cells[3], match),
      outcome: parseOutcomeLabel(cells[0]),
      side: parseTradeSide(cells[1]),
      amount: parseMoneyAmount(cells[2]),
      ratio: parseNumber(cells[4]),
      price: null,
      raw: cells.join(" "),
    }))
    .filter((item) => Number.isFinite(item.amount))
    .slice(0, 24);
}

function extractBettingTipsFromHtml(payload) {
  const text = cleanText(stripHtml(String(payload || "").match(/<td[^>]*rowspan=["']?3["']?[^>]*>\s*数据提点[\s\S]*?<\/tr>\s*<\/tbody>/i)?.[0] || ""));
  return cleanText(text.replace(/^数据提点\s*/, "")).slice(0, 180);
}

function parseTradeSide(value) {
  const text = cleanText(value);
  if (/买|buy|back/i.test(text)) return "买入";
  if (/卖|sell|lay/i.test(text)) return "卖出";
  return text || "";
}

function flattenJsonNodes(value, path = "") {
  if (Array.isArray(value)) {
    const arrayNode = {
      path,
      value,
      text: value.map((item) => typeof item === "object" ? "" : String(item ?? "")).join(" "),
    };
    return [arrayNode, ...value.flatMap((item, index) => flattenJsonNodes(item, `${path}.${index}`))];
  }

  if (value && typeof value === "object") {
    const text = Object.entries(value)
      .map(([key, item]) => `${key}:${typeof item === "object" ? "" : item}`)
      .join(" ");
    return [
      { path, value, text },
      ...Object.entries(value).flatMap(([key, item]) => flattenJsonNodes(item, path ? `${path}.${key}` : key)),
    ];
  }

  return [{ path, value, text: String(value ?? "") }];
}

function pickJsonOutcomeAmounts(nodes, titlePatterns, fallback = null) {
  const scored = nodes
    .map((node) => {
      const text = cleanText(`${node.path} ${node.text}`);
      const titleScore = titlePatterns.some((pattern) => pattern.test(text)) ? 8 : 0;
      const amounts = extractOutcomeAmountsFromJsonNode(node);
      return { score: titleScore + countOutcomeAmounts(amounts), amounts };
    })
    .filter((item) => item.score > 0 && countOutcomeAmounts(item.amounts) > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.amounts || fallback || emptyOutcomeAmounts();
}

function extractOutcomeAmountsFromJsonNode(node) {
  if (Array.isArray(node.value)) {
    const values = node.value.map(parseMoneyAmount).filter(Number.isFinite);
    if (values.length >= 3) {
      return { home: values[0], draw: values[1], away: values[2] };
    }
  }

  if (node.value && typeof node.value === "object" && !Array.isArray(node.value)) {
    const result = emptyOutcomeAmounts();
    Object.entries(node.value).forEach(([key, value]) => {
      const outcome = parseOutcomeLabel(`${key} ${value}`);
      if (!outcome) return;
      const amount = parseMoneyAmount(value);
      if (Number.isFinite(amount)) result[outcome] = amount;
    });
    if (countOutcomeAmounts(result) > 0) return result;
  }

  return extractOutcomeAmountsFromText(cleanText(`${node.path} ${node.text}`));
}

function extractTrendFromJson(nodes, match) {
  const rows = nodes
    .map((node) => {
      const values = readJsonOutcomeValues(node.value);
      const time = readJsonTime(node.value) || extractTime(`${node.path} ${node.text}`);
      if (!time || countOutcomeAmounts(values) < 2) return null;
      return {
        time: normalizeTimeForChart(time, match),
        home: values.home,
        draw: values.draw,
        away: values.away,
      };
    })
    .filter(Boolean);
  return rows.slice(-24);
}

function extractDistributionFromJson(nodes) {
  const result = {
    home: { buy: null, sell: null },
    draw: { buy: null, sell: null },
    away: { buy: null, sell: null },
  };

  nodes.forEach((node) => {
    const text = cleanText(`${node.path} ${node.text}`);
    const outcome = parseOutcomeLabel(text);
    if (!outcome) return;
    const buy = readJsonValueByPattern(node.value, /买入|buy|back/i);
    const sell = readJsonValueByPattern(node.value, /卖出|sell|lay/i);
    if (Number.isFinite(buy)) result[outcome].buy = buy;
    if (Number.isFinite(sell)) result[outcome].sell = sell;
  });

  return result;
}

function extractLargeDetailsFromJson(nodes, match) {
  return nodes
    .map((node) => {
      const text = cleanText(`${node.path} ${node.text}`);
      if (!/大额|large|big|买入|卖出|buy|sell|back|lay/i.test(text)) return null;
      const amount = readJsonValueByPattern(node.value, /金额|交易|成交|amount|money|volume|total/i) ?? parseMoneyAmount(text);
      if (!Number.isFinite(amount)) return null;
      return {
        time: normalizeTimeForChart(readJsonTime(node.value) || extractTime(text), match),
        outcome: parseOutcomeLabel(text),
        side: /卖出|sell|lay/i.test(text) ? "卖出" : /买入|buy|back/i.test(text) ? "买入" : "",
        amount,
        price: readJsonValueByPattern(node.value, /赔率|price|odds|rate/i),
        raw: text,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 12);
}

function hasParsedBettingData(parsed) {
  return countOutcomeAmounts(parsed.volume) > 0
    || countOutcomeAmounts(parsed.largeVolume) > 0
    || parsed.trend.length > 0
    || parsed.largeDetails.length > 0;
}

function readJsonOutcomeValues(value) {
  if (Array.isArray(value)) {
    const values = value.map(parseMoneyAmount).filter(Number.isFinite);
    if (values.length >= 3) return { home: values[0], draw: values[1], away: values[2] };
  }

  if (!value || typeof value !== "object") return emptyOutcomeAmounts();
  const result = emptyOutcomeAmounts();
  Object.entries(value).forEach(([key, item]) => {
    const outcome = parseOutcomeLabel(key);
    if (!outcome) return;
    const amount = parseMoneyAmount(item);
    if (Number.isFinite(amount)) result[outcome] = amount;
  });
  return result;
}

function readJsonTime(value) {
  if (Array.isArray(value)) return value.map(extractTime).find(Boolean) || "";
  if (!value || typeof value !== "object") return extractTime(value) || "";
  return Object.entries(value)
    .map(([key, item]) => /time|date|时间|日期/i.test(key) ? extractTime(item) || cleanText(item) : extractTime(item))
    .find(Boolean) || "";
}

function readJsonValueByPattern(value, pattern) {
  if (Array.isArray(value)) {
    return value.map(parseMoneyAmount).find(Number.isFinite) ?? null;
  }

  if (!value || typeof value !== "object") return parseMoneyAmount(value);
  for (const [key, item] of Object.entries(value)) {
    if (!pattern.test(key)) continue;
    const amount = parseMoneyAmount(item);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function getBettingSections(doc) {
  const candidates = [...doc.querySelectorAll("table, div, section, article")]
    .filter((node) => /必发|成交|交易|大额|买入|卖出|Betfair|betfair/i.test(cleanText(node.textContent)));
  const compact = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node) && cleanText(other.textContent).length < cleanText(node.textContent).length * 1.8));
  return compact.length ? compact : [doc.body || doc.documentElement];
}

function pickBestOutcomeAmounts(sections, titlePatterns, fallback = null) {
  const scored = sections
    .map((section) => {
      const text = cleanText(section.textContent);
      const titleScore = titlePatterns.some((pattern) => pattern.test(text)) ? 8 : 0;
      const amounts = extractOutcomeAmountsFromNode(section);
      const amountScore = countOutcomeAmounts(amounts);
      return { score: titleScore + amountScore, amounts };
    })
    .filter((item) => item.score > 0 && countOutcomeAmounts(item.amounts) > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.amounts || fallback || emptyOutcomeAmounts();
}

function extractOutcomeAmountsFromNode(node) {
  const rows = [...node.querySelectorAll("tr")].map(getRowCells).filter((cells) => cells.length);
  for (const cells of rows) {
    const rowText = cells.join(" ");
    if (/主胜|平局|客胜/.test(rowText)) {
      const rowAmounts = extractOutcomeAmountsFromCells(cells);
      if (countOutcomeAmounts(rowAmounts) >= 2) return rowAmounts;
    }
  }

  const text = cleanText(node.textContent);
  return extractOutcomeAmountsFromText(text);
}

function extractOutcomeAmountsFromCells(cells) {
  const result = emptyOutcomeAmounts();
  cells.forEach((cell, index) => {
    const label = parseOutcomeLabel(cell);
    if (!label) return;
    const amount = parseMoneyAmount(cell) ?? parseMoneyAmount(cells[index + 1]);
    if (Number.isFinite(amount)) result[label] = amount;
  });

  const numeric = cells.map(parseMoneyAmount).filter(Number.isFinite);
  if (countOutcomeAmounts(result) === 0 && numeric.length >= 3) {
    result.home = numeric[0];
    result.draw = numeric[1];
    result.away = numeric[2];
  }
  return result;
}

function extractOutcomeAmountsFromText(text) {
  const result = emptyOutcomeAmounts();
  [
    ["home", /主胜[^0-9+\-.]*(\d[\d,]*(?:\.\d+)?)/],
    ["draw", /平局[^0-9+\-.]*(\d[\d,]*(?:\.\d+)?)/],
    ["away", /客胜[^0-9+\-.]*(\d[\d,]*(?:\.\d+)?)/],
  ].forEach(([key, pattern]) => {
    const value = parseMoneyAmount(text.match(pattern)?.[1]);
    if (Number.isFinite(value)) result[key] = value;
  });
  return result;
}

function extractBettingTrend(sections, payload, match) {
  const series = extractTrendFromScripts(payload, match);
  if (series.length) return series;

  const rows = sections.flatMap((section) => [...section.querySelectorAll("tr")].map(getRowCells));
  return rows
    .map((cells) => {
      const time = cells.find((cell) => extractTime(cell)) || "";
      const values = cells.map(parseMoneyAmount).filter(Number.isFinite);
      if (!time || values.length < 3) return null;
      return {
        time: normalizeTimeForChart(extractTime(time), match),
        home: values[0],
        draw: values[1],
        away: values[2],
      };
    })
    .filter(Boolean)
    .slice(-24);
}

function extractTrendFromScripts(payload, match) {
  const rows = [];
  for (const matchItem of String(payload || "").matchAll(/(\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})[^,\]\n]*[,，]\s*(\d[\d,.]*)[,，]\s*(\d[\d,.]*)[,，]\s*(\d[\d,.]*)/g)) {
    rows.push({
      time: normalizeTimeForChart(normalizeTimeString(matchItem[1]), match),
      home: parseMoneyAmount(matchItem[2]),
      draw: parseMoneyAmount(matchItem[3]),
      away: parseMoneyAmount(matchItem[4]),
    });
  }
  return rows.filter((row) => Number.isFinite(row.home) && Number.isFinite(row.draw) && Number.isFinite(row.away)).slice(-24);
}

function extractLargeDistribution(sections) {
  const rows = sections.flatMap((section) => [...section.querySelectorAll("tr")].map(getRowCells));
  const result = {
    home: { buy: null, sell: null },
    draw: { buy: null, sell: null },
    away: { buy: null, sell: null },
  };

  rows.forEach((cells) => {
    const rowText = cells.join(" ");
    const outcome = parseOutcomeLabel(rowText);
    if (!outcome || !/买入|卖出|大额/.test(rowText)) return;
    const values = cells.map(parseMoneyAmount).filter(Number.isFinite);
    if (/买入/.test(rowText) && Number.isFinite(values[0])) result[outcome].buy = values[0];
    if (/卖出/.test(rowText) && Number.isFinite(values.at(-1))) result[outcome].sell = values.at(-1);
    if (values.length >= 2) {
      result[outcome].buy ??= values[0];
      result[outcome].sell ??= values[1];
    }
  });

  return result;
}

function extractLargeTradeDetails(sections, match) {
  const rows = sections.flatMap((section) => [...section.querySelectorAll("tr")].map(getRowCells));
  return rows
    .map((cells) => {
      const rowText = cells.join(" ");
      if (!/大额|买入|卖出/.test(rowText)) return null;
      const amount = cells.map(parseMoneyAmount).find(Number.isFinite);
      if (!Number.isFinite(amount)) return null;
      return {
        time: normalizeTimeForChart(cells.map(extractTime).find(Boolean), match),
        outcome: parseOutcomeLabel(rowText) || "",
        side: /卖出/.test(rowText) ? "卖出" : /买入/.test(rowText) ? "买入" : "",
        amount,
        price: cells.map(parseNumber).find((value) => Number.isFinite(value) && value > 1 && value < 100) ?? null,
        raw: rowText,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 12);
}

function extractBettingSummaryText(text) {
  const sentences = cleanText(text).split(/[。；;]/).map(cleanText).filter(Boolean);
  return sentences.find((item) => /必发|成交|交易|大额/.test(item) && item.length > 12)?.slice(0, 140) || "";
}

function emptyOutcomeAmounts() {
  return { home: null, draw: null, away: null };
}

function countOutcomeAmounts(value) {
  return ["home", "draw", "away"].filter((key) => Number.isFinite(value?.[key])).length;
}

function parseOutcomeLabel(value) {
  const text = cleanText(value);
  if (/主胜|^主$|胜\b|主队|\bhome\b|\bhost\b|\bwin\b|\bh\b/i.test(text)) return "home";
  if (/平局|^平$|平\b|\bdraw\b|\btie\b|\bd\b/i.test(text)) return "draw";
  if (/客胜|^客$|负\b|客队|\baway\b|\bguest\b|\bloss\b|\blose\b|\ba\b/i.test(text)) return "away";
  return "";
}

function parseMoneyAmount(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/[-+]?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  let number = Number.parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(number)) return null;
  if (/万/.test(text)) number *= 10000;
  if (/亿/.test(text)) number *= 100000000;
  return number;
}

function normalizeTimeForChart(value, match) {
  if (!value) return "";
  const time = normalizeTimeString(value);
  if (/^\d{1,2}:\d{2}/.test(time) && match?.kickoffTime instanceof Date) {
    return `${pad(match.kickoffTime.getMonth() + 1)}-${pad(match.kickoffTime.getDate())} ${time}`;
  }
  return time.replace(/^20\d{2}-/, "");
}

function parseFutureFixtureRow(row, baseUrl, now, headers = [], pageBetType = "") {
  const cells = getFutureRowCells(row);
  const rowText = cleanText(cells.join(" "));
  if (!rowText || /取消|推迟|腰斩/.test(rowText)) return null;

  const links = getFutureRowLinks(row, baseUrl);
  const oddsLink = links.find((link) => /fenxi\/(?:ouzhi|shuju)-\d+\.shtml/i.test(link.href) || /fenxi/i.test(link.href));
  const fixtureId = extractScheduleFixtureId(row, links, oddsLink);
  const oddsUrl = buildOddsUrl(oddsLink?.href || fixtureId);

  const kickoffTime = inferFixtureKickoff(cells, rowText, now, baseUrl, headers);
  if (!kickoffTime) return null;

  const rowMeta = getFixtureRowMeta(row);
  const teams = inferFixtureTeams(cells, links, rowText, headers, rowMeta);
  if (!teams.homeTeam || !teams.awayTeam) return null;

  const matchType = inferFixtureType(cells, rowText, headers, teams, rowMeta);
  const betType = inferFixtureBetType(cells, rowText, headers, baseUrl, pageBetType);
  rowMeta.statusText = rowMeta.statusText || inferFixtureStatus(cells, headers);
  const result = inferFixtureResult(cells, headers, rowMeta);
  return {
    fixtureId,
    oddsUrl,
    matchInput: oddsUrl || fixtureId,
    kickoffTime,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    matchType,
    betType,
    statusText: rowMeta.statusText,
    statusCode: rowMeta.statusCode,
    isFinishedCandidate: isFixtureFinishedStatus(rowMeta),
    ...result,
    sourceText: rowText,
    sourceUrl: baseUrl,
  };
}

function buildFutureRowContexts(rows) {
  const contexts = [];
  let currentHeaders = [];

  rows.forEach((row) => {
    const cells = getFutureRowCells(row);
    if (!cells.length) return;
    if (isFutureHeaderRow(row, cells)) {
      currentHeaders = cells.map(cleanHeaderCell);
      return;
    }
    contexts.push({ row, headers: currentHeaders });
  });

  return contexts;
}

function buildScheduleRowContexts(html) {
  const contexts = [];
  const seen = new Set();
  const addContexts = (items) => {
    items.forEach((item) => {
      const key = cleanText(getFutureRowCells(item.row).join("|"));
      if (!key || seen.has(key)) return;
      seen.add(key);
      contexts.push(item);
    });
  };

  if (typeof DOMParser !== "undefined") {
    addContexts(buildFutureRowContexts([...parseHtmlDocument(html).querySelectorAll("tr")]));
  }
  addContexts(buildFutureRowContexts(extractRowHtmlFragments(html)));
  return contexts;
}

function isFutureHeaderRow(row, cells) {
  const rowText = cleanText(cells.join(" "));
  const hasHeaderTag = typeof row === "string"
    ? /<th\b/i.test(row)
    : row.querySelectorAll("th").length > 0;
  const headerWordCount = cells.filter((cell) => /^(场次|赛事|联赛|轮次|比赛|比赛时间|时间|主队|客队|主客队|对阵|赛果|比分|盘口|状态|分析|欧赔|亚盘|资料|直播|置顶)$/.test(cleanHeaderCell(cell))).length;
  return (hasHeaderTag && headerWordCount >= 2) || (headerWordCount >= 2 && /赛事|联赛|比赛/.test(rowText));
}

function cleanHeaderCell(value) {
  return cleanText(value).replace(/\s+/g, "");
}

function getFutureRowCells(row) {
  if (typeof row === "string") {
    return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => cleanText(stripHtml(match[1])))
      .filter(Boolean);
  }
  return getRowCells(row);
}

function getFutureRowLinks(row, baseUrl) {
  if (typeof row === "string") {
    return [...row.matchAll(/<a[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({
        href: absolutizeUrl(match[1], baseUrl),
        rawHref: match[1],
        text: cleanText(stripHtml(match[2])),
        marker: match[0],
      }))
      .filter((link) => link.href);
  }

  return [...row.querySelectorAll("a[href]")]
    .map((anchor) => ({
      href: absolutizeUrl(anchor.getAttribute("href"), baseUrl),
      rawHref: anchor.getAttribute("href") || "",
      text: cleanText(anchor.textContent || anchor.title),
      marker: `${anchor.className || ""} ${anchor.closest("td")?.className || ""}`,
    }))
    .filter((link) => link.href);
}

function getFutureRowId(row) {
  if (typeof row === "string") {
    return row.match(/\bfid=["']?(\d{5,})["']?/i)?.[1]
      || row.match(/\bid=["']?a?(\d{5,})["']?/i)?.[1]
      || "";
  }
  return row.getAttribute?.("fid") || row.id?.match(/\d{5,}/)?.[0] || "";
}

function extractScheduleFixtureId(row, links, oddsLink) {
  const linkText = [
    oddsLink?.href,
    oddsLink?.rawHref,
    ...links
      .filter((link) => /fenxi|detail\.php|[?&]fid=/i.test(`${link.href} ${link.rawHref}`))
      .flatMap((link) => [link.href, link.rawHref]),
  ].join(" ");

  return linkText.match(/(?:ouzhi-|shuju-|stat-|yazhi-|youliao-)(\d{5,})/i)?.[1]
    || linkText.match(/[?&]fid=(\d{5,})/i)?.[1]
    || extractFixtureId(oddsLink?.href || "")
    || getFutureRowId(row);
}

function getFixtureRowMeta(row) {
  const meta = {
    statusCode: getRowAttribute(row, "status"),
    statusText: "",
    score: extractFixtureFullScoreFromRow(row),
  };
  const candidates = [
    getRowAttribute(row, "gy"),
    getRowAttribute(row, "yy"),
  ];

  for (const candidate of candidates) {
    const parts = cleanText(candidate).split(/[,，]/).map(cleanText).filter(Boolean);
    if (parts.length < 3) continue;
    return {
      ...meta,
      matchType: cleanMatchType(parts[0]),
      homeTeam: cleanTeamLabel(parts[1]),
      awayTeam: cleanTeamLabel(parts[2]),
    };
  }

  return meta;
}

function getRowAttribute(row, name) {
  if (typeof row === "string") {
    return row.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] || "";
  }
  return row.getAttribute?.(name) || "";
}

function extractRowHtmlFragments(html) {
  return [...String(html || "").matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
}

function inferFixtureKickoff(cells, rowText, now, baseUrl, headers = []) {
  const scheduleDate = getScheduleDateFromUrl(baseUrl);
  const headerTime = extractTime(getHeaderCell(cells, headers, [/^比赛时间$/, /^时间$/, /^开赛时间$/, /^日期$/]));
  const fullTime = headerTime || extractTimeFromCells(cells) || extractTime(rowText);
  if (fullTime) {
    const ms = parseTimeToMs(fullTime, scheduleDate || now);
    if (ms !== null) return new Date(ms);
  }

  const clock = rowText.match(/\b\d{1,2}:\d{2}\b/)?.[0];
  if (!clock) return null;
  let candidate = scheduleDate || new Date(now);
  const [hours, minutes] = clock.split(":").map((value) => Number.parseInt(value, 10));
  candidate.setHours(hours, minutes, 0, 0);
  return candidate;
}

function inferFixtureStatus(cells, headers = []) {
  const status = getHeaderCell(cells, headers, [/^状态$/, /^赛果状态$/, /^比赛状态$/]);
  if (status) return cleanText(status);
  return cells.find((cell) => /^(完|完场|已完|结束|未|未开赛|延期|取消|中|上半场|下半场)$/.test(cleanText(cell))) || "";
}

function extractFixtureFullScoreFromRow(row) {
  const pair = extractPkScorePair(row);
  if (pair) return pair;
  return null;
}

function extractPkScorePair(row) {
  if (typeof row === "string") {
    const home = row.match(/class=["'][^"']*\bclt1\b[^"']*["'][^>]*>\s*(\d{1,2})\s*</i)?.[1];
    const away = row.match(/class=["'][^"']*\bclt3\b[^"']*["'][^>]*>\s*(\d{1,2})\s*</i)?.[1];
    return home !== undefined && away !== undefined
      ? { homeScore: Number.parseInt(home, 10), awayScore: Number.parseInt(away, 10) }
      : null;
  }

  const pk = row.querySelector?.(".pk");
  if (!pk) return null;
  const home = cleanText(pk.querySelector(".clt1")?.textContent);
  const away = cleanText(pk.querySelector(".clt3")?.textContent);
  return /^\d{1,2}$/.test(home) && /^\d{1,2}$/.test(away)
    ? { homeScore: Number.parseInt(home, 10), awayScore: Number.parseInt(away, 10) }
    : null;
}

function inferFixtureTeams(cells, links, rowText, headers = [], rowMeta = {}) {
  if (isLikelyTeamName(rowMeta.homeTeam) && isLikelyTeamName(rowMeta.awayTeam)) {
    return { homeTeam: rowMeta.homeTeam, awayTeam: rowMeta.awayTeam };
  }

  const headerTeams = getFixtureTeamsFromHeaders(cells, headers);
  if (headerTeams.homeTeam && headerTeams.awayTeam) return headerTeams;

  const linkedTeams = links
    .filter((link) => /\/team\/|teamid=|team\/|liansai\.500\.com\/team/i.test(link.href + " " + link.rawHref + " " + link.marker))
    .map((link) => cleanTeamLabel(link.text))
    .filter(isLikelyTeamName);
  if (linkedTeams.length >= 2) return { homeTeam: linkedTeams[0], awayTeam: linkedTeams[1] };

  const teamLinks = links
    .map((link) => cleanTeamLabel(link.text))
    .filter(isLikelyTeamName);
  if (teamLinks.length >= 2) return { homeTeam: teamLinks[0], awayTeam: teamLinks[1] };

  const vsIndex = cells.findIndex((cell) => /^(VS|vs|v)$/i.test(cleanText(cell)) || /VS|vs| v /.test(cell));
  const vsCell = vsIndex >= 0 ? cells[vsIndex] : "";
  if (vsCell) {
    const match = cleanText(vsCell).match(/(.{1,24}?)(?:\s*VS\s*|\s*vs\s*|\s+v\s+)(.{1,24})/i);
    if (match) {
      const homeTeam = cleanTeamLabel(match[1]);
      const awayTeam = cleanTeamLabel(match[2]);
      if (isLikelyTeamName(homeTeam) && isLikelyTeamName(awayTeam)) return { homeTeam, awayTeam };
    }

    const before = findNearestTeamCell(cells, vsIndex, -1);
    const after = findNearestTeamCell(cells, vsIndex, 1);
    if (before && after) return { homeTeam: before, awayTeam: after };
  }

  const textMatch = rowText.match(/([\u4e00-\u9fa5A-Za-z0-9·.\-]{1,24})\s*(?:VS|vs|v)\s*([\u4e00-\u9fa5A-Za-z0-9·.\-]{1,24})/);
  if (textMatch) {
    const homeTeam = cleanTeamLabel(textMatch[1]);
    const awayTeam = cleanTeamLabel(textMatch[2]);
    if (isLikelyTeamName(homeTeam) && isLikelyTeamName(awayTeam)) return { homeTeam, awayTeam };
  }

  const cellTeams = cells
    .map((cell) => cleanTeamLabel(cell))
    .filter((cell) => isLikelyTeamName(cell) && !/\d{1,2}:\d{2}|^\d+周|周[一二三四五六日]/.test(cell));
  if (cellTeams.length >= 2) return { homeTeam: cellTeams[0], awayTeam: cellTeams[1] };

  return {};
}

function inferFixtureResult(cells, headers = [], rowMeta = {}) {
  if (!isFixtureFinishedStatus(rowMeta)) return emptyFixtureResult();
  if (rowMeta.score) return buildFixtureResult(rowMeta.score.homeScore, rowMeta.score.awayScore);

  const scoreCell = getHeaderCell(cells, headers, [/^比分$/, /^赛果$/, /^全场$/, /^比分结果$/]);
  const score = parseResultScore(scoreCell);
  return score ? buildFixtureResult(score.homeScore, score.awayScore) : emptyFixtureResult();
}

function parseResultScore(value) {
  const text = cleanText(value);
  if (!text || /VS/i.test(text)) return null;
  const matches = [...text.matchAll(/(?:^|[^\d])(\d{1,2})\s*[:：-]\s*(\d{1,2})(?:[^\d]|$)/g)];
  for (const match of matches) {
    const homeScore = Number.parseInt(match[1], 10);
    const awayScore = Number.parseInt(match[2], 10);
    if (Number.isFinite(homeScore) && Number.isFinite(awayScore) && homeScore <= 20 && awayScore <= 20) {
      return { homeScore, awayScore };
    }
  }
  return null;
}

function buildFixtureResult(homeScore, awayScore) {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return emptyFixtureResult();
  if (homeScore < 0 || awayScore < 0 || homeScore > 20 || awayScore > 20) return emptyFixtureResult();
  return {
    resultText: `完赛 ${homeScore}:${awayScore}`,
    homeScore,
    awayScore,
    isFinished: true,
  };
}

function emptyFixtureResult() {
  return { resultText: "", homeScore: null, awayScore: null, isFinished: false };
}

function isFixtureFinishedStatus(rowMeta = {}) {
  const statusCode = cleanText(rowMeta.statusCode);
  const statusText = cleanText(rowMeta.statusText);
  if (/^(4|完|完场|已完|结束|赛果)$/.test(statusCode) || /完|完场|已完|结束/.test(statusText)) return true;
  return false;
}

function getDetailCurrentMatchScore(normalized, doc, fixtureId) {
  const selectors = [
    `tr.hd_box_this a.hd_cz_duizhen[href*="${fixtureId}"] .gray`,
    `a.hd_cz_duizhen[href*="${fixtureId}"] .gray`,
  ];
  if (doc) {
    const score = selectors
      .map((selector) => cleanText(doc.querySelector(selector)?.textContent))
      .find((value) => parseResultScore(value));
    if (score) return score;
  }

  const escapedId = fixtureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const currentRowPattern = new RegExp(`<tr[^>]*class=["'][^"']*hd_box_this[^"']*["'][\\s\\S]*?<a[^>]*hd_cz_duizhen[^>]*href=["'][^"']*${escapedId}[^"']*["'][\\s\\S]*?<span[^>]*class=["'][^"']*gray[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i");
  const currentRowScore = cleanText(stripHtml(normalized.match(currentRowPattern)?.[1] || ""));
  if (parseResultScore(currentRowScore)) return currentRowScore;

  const anyRowPattern = new RegExp(`<a[^>]*hd_cz_duizhen[^>]*href=["'][^"']*${escapedId}[^"']*["'][\\s\\S]*?<span[^>]*class=["'][^"']*gray[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i");
  return cleanText(stripHtml(normalized.match(anyRowPattern)?.[1] || ""));
}

function getFixtureTeamsFromHeaders(cells, headers = []) {
  const homeTeam = cleanTeamLabel(getHeaderCell(cells, headers, [/^主队$/, /^主$/]));
  const awayTeam = cleanTeamLabel(getHeaderCell(cells, headers, [/^客队$/, /^客$/]));
  if (isLikelyTeamName(homeTeam) && isLikelyTeamName(awayTeam)) {
    return { homeTeam, awayTeam };
  }

  const matchup = cleanText(getHeaderCell(cells, headers, [/^主客队$/, /^对阵$/, /^比赛$/]));
  const match = matchup.match(/(.{1,24}?)(?:\s*VS\s*|\s*vs\s*|\s+v\s+|对阵)(.{1,24})/i);
  if (match) {
    const left = cleanTeamLabel(match[1]);
    const right = cleanTeamLabel(match[2]);
    if (isLikelyTeamName(left) && isLikelyTeamName(right)) return { homeTeam: left, awayTeam: right };
  }

  return {};
}

function getHeaderCell(cells, headers = [], patterns = []) {
  if (!Array.isArray(headers) || !headers.length) return "";
  for (let index = 0; index < headers.length; index += 1) {
    const header = cleanHeaderCell(headers[index]);
    if (patterns.some((pattern) => pattern.test(header))) return cells[index] || "";
  }
  return "";
}

function findNearestTeamCell(cells, startIndex, step) {
  for (let index = startIndex + step; index >= 0 && index < cells.length; index += step) {
    const text = cleanTeamLabel(cells[index]);
    if (!text || /^(VS|vs|v)$/.test(text) || /\d{1,2}:\d{2}/.test(text)) continue;
    if (isLikelyTeamName(text)) return text;
    return "";
  }
  return "";
}

function isLikelyTeamName(value) {
  const text = cleanTeamLabel(value);
  if (!text || text.length < 2 || text.length > 24) return false;
  if (/^(VS|vs|v|析|欧|亚|大|同|主|客|胜|平|负|让球|盘口|指数|赔率|数据|直播|阵容|排名|单场比分|单场|比分|半球|一球|半球\/一球|一球\/球半|球半|两球|受让|平手)$/.test(text)) return false;
  if (/世界杯|世界盃|联赛|杯赛|赛程|赛事|轮次|决赛|小组赛|排名|盘口|半球|一球|球半|两球|受让|平手/.test(text)) return false;
  if (/^(英超|西甲|德甲|意甲|法甲|葡超|荷甲|苏超|挪超|挪甲|瑞典超|瑞典甲|芬超|芬甲|冰岛超|冰岛甲|美职|美职联|日职|日职乙|韩K|韩K联|韩K2联|澳超|巴甲|巴乙|阿甲|阿乙|中超|中甲|中乙|欧冠|亚冠|欧罗巴|欧协联)$/.test(text)) return false;
  if (/^\d+(?:\.\d+)?$/.test(text)) return false;
  return true;
}

function inferFixtureType(cells, rowText, headers = [], teams = {}, rowMeta = {}) {
  const headerCandidate = getFixtureTypeFromHeaders(cells, headers, teams);
  if (headerCandidate) return headerCandidate;

  if (isLikelyFixtureType(rowMeta.matchType, teams)) return rowMeta.matchType;

  const cellCandidate = cells
    .map(cleanMatchType)
    .find((cell) => isLikelyFixtureType(cell, teams));
  if (cellCandidate) return cellCandidate;

  const textCandidate = cleanMatchType(rowText.match(/((?:\d{2})?世界杯[^ ]{0,12}|[\u4e00-\u9fa5A-Za-z0-9]{2,14}(?:杯|联赛|欧冠|亚冠|超|甲|乙|丙|冠|职|联|预|锦)[^ ]{0,8})/)?.[1]);
  return isLikelyFixtureType(textCandidate, teams) ? textCandidate : "";
}

function getFixtureTypeFromHeaders(cells, headers, teams) {
  if (!Array.isArray(headers) || !headers.length) return "";

  for (let index = 0; index < headers.length; index += 1) {
    const header = cleanHeaderCell(headers[index]);
    if (!/^(赛事|联赛|赛事名称|联赛名称)$/.test(header)) continue;
    const candidate = cleanMatchType(cells[index]);
    if (isLikelyFixtureType(candidate, teams)) return candidate;
  }

  return "";
}

function isLikelyFixtureType(value, teams = {}) {
  const text = cleanMatchType(value);
  if (!text || text.length < 2 || text.length > 24) return false;
  if (normalizeTeamName(text) === normalizeTeamName(teams.homeTeam) || normalizeTeamName(text) === normalizeTeamName(teams.awayTeam)) return false;
  if (/VS|vs|\d{1,2}:\d{2}|20\d{2}[-/.年]\d{1,2}|\d+\.\d+|%/.test(text)) return false;
  if (/^(单场比分|单场|比分|竞彩|北单|胜平负|让球|让球胜平负|半全场|总进球|析|欧|亚|大|同|主|客|胜|平|负|数据|直播|阵容|排名|状态|未开赛|延期|取消)$/.test(text)) return false;
  if (/盘口|指数|赔率|让球|半球|一球|球半|两球|受让|平手|单场比分|比分玩法/.test(text)) return false;
  if (/世界杯|世界盃|世俱杯|欧洲杯|亚洲杯|美洲杯|非洲杯|金杯赛|欧冠|亚冠|欧罗巴|欧协联|解放者杯|自由杯|南俱杯|友谊赛|国际赛|世预赛|世青赛|奥运/.test(text)) return true;
  if (/^(英超|西甲|德甲|意甲|法甲|葡超|荷甲|苏超|爱超|爱甲|挪超|挪甲|瑞典超|瑞典甲|芬超|芬甲|冰岛超|冰岛甲|美职联|美公开赛|日职|日职乙|韩K联|韩K2联|澳超|巴甲|巴乙|阿甲|阿乙|中超|中甲|中乙|女世界杯|女欧杯)$/.test(text)) return true;
  return /^[\u4e00-\u9fa5A-Za-z0-9]{2,12}(?:超|甲|乙|丙|冠|职|联|杯|赛|预|锦)$/.test(text);
}

function inferFixtureBetType(cells, rowText, headers = [], baseUrl = "", pageBetType = "") {
  const headerCandidate = getHeaderCell(cells, headers, [/^(玩法|彩种|赛事类型|比赛类型|类型|投注类型|比分类型)$/]);
  if (isSingleMatchBetType(headerCandidate)) return SINGLE_MATCH_BET_TYPE;
  if (isSingleMatchBetType(pageBetType)) return SINGLE_MATCH_BET_TYPE;
  if (isSingleMatchBetType(rowText)) return SINGLE_MATCH_BET_TYPE;
  if (/\/zqdc\.php|[?&]type=zqdc\b/i.test(String(baseUrl || ""))) return SINGLE_MATCH_BET_TYPE;
  return "";
}

function inferPageBetType(payload, baseUrl = "") {
  const text = `${String(baseUrl || "")} ${String(payload || "").slice(0, 20000)}`;
  if (/\/zqdc\.php|live_type\s*=\s*["']zqdc["']|单场比分|北京单场|北单/i.test(text)) {
    return SINGLE_MATCH_BET_TYPE;
  }
  return "";
}

function isSingleMatchBetType(value) {
  const text = cleanText(value);
  return /单场比分|北京单场|北单/i.test(text);
}

function isSingleMatchFixture(fixture) {
  return isSingleMatchBetType(fixture?.betType);
}

function getScheduleDateFromUrl(value) {
  const text = String(value || "");
  const compact = text.match(/[?&](?:e|date)=(20\d{2})(\d{2})(\d{2})/)
    || text.match(/[?&](?:e|date)=(20\d{2})-(\d{2})-(\d{2})/);
  if (!compact) return null;
  const date = new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfLocalDay(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? new Date(value) : new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfLocalDay(value) {
  const date = startOfLocalDay(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function parseBookmakerRow(row, match) {
  const cid = row.id?.match(/^\d+$/)?.[0] || row.querySelector("a[href*='cid=']")?.href?.match(/[?&]cid=(\d+)/)?.[1];
  if (!cid) return null;
  if (row.getAttribute("xls") !== "row") return null;

  const companyCell = row.querySelector("td.tb_plgs, th.tb_plgs, [class~='tb_plgs']");
  if (!companyCell) return null;

  const bookmaker = getCompanyNameFromCompanyCell(companyCell);
  if (!isValidBookmakerName(bookmaker)) return null;

  const dataTime = normalizeTimeString(row.getAttribute("data-time") || "");
  const oddsTable = row.querySelectorAll("table.pl_table_data")[0];
  const returnTable = row.querySelectorAll("table.pl_table_data")[2];
  const kellyTable = row.querySelectorAll("table.pl_table_data")[3];
  const oddsPairs = readTableTriples(oddsTable);
  const returnValues = readSingleColumnValues(returnTable);
  const kellyPairs = readTableTriples(kellyTable);
  const openingOdds = oddsPairs[0] || null;
  const latestOdds = oddsPairs[1] || null;
  const openingKelly = kellyPairs[0] || null;
  const latestKelly = kellyPairs[1] || null;

  if (!openingOdds && !latestOdds) return null;

  return {
    cid,
    bookmaker,
    isMain: !!companyCell.querySelector('img[src*="oz_zhu"]'),
    dataTime,
    cutoff: isBeforeKickoff(dataTime, match?.kickoffTime),
    opening: openingOdds ? {
      homeOdds: openingOdds[0],
      drawOdds: openingOdds[1],
      awayOdds: openingOdds[2],
      returnRate: returnValues[0] ?? calculateReturnRate(openingOdds),
      kellyHome: openingKelly?.[0] ?? null,
      kellyDraw: openingKelly?.[1] ?? null,
      kellyAway: openingKelly?.[2] ?? null,
    } : null,
    latest: latestOdds ? {
      homeOdds: latestOdds[0],
      drawOdds: latestOdds[1],
      awayOdds: latestOdds[2],
      returnRate: returnValues[1] ?? calculateReturnRate(latestOdds),
      kellyHome: latestKelly?.[0] ?? null,
      kellyDraw: latestKelly?.[1] ?? null,
      kellyAway: latestKelly?.[2] ?? null,
    } : null,
  };
}

function mergeRecords(records) {
  const grouped = new Map();

  records.forEach((record) => {
    const timeKey = record.time || (record.sequence ?? "unknown");
    const key = `${record.cid || record.bookmaker}|${timeKey}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...record });
      return;
    }

    grouped.set(key, {
      ...existing,
      ...compactRecord(record),
      type: mergeType(existing.type, record.type),
    });
  });

  return [...grouped.values()].map((record) => ({
    ...record,
    returnRate: record.returnRate ?? calculateReturnRate([record.homeOdds, record.drawOdds, record.awayOdds]),
  }));
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== "")
  );
}

function mergeType(a, b) {
  if (!a) return b;
  if (!b || a === b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}+${b}`;
}

function summarizeBookmakers(records, match) {
  const groups = new Map();
  records.forEach((record) => {
    const key = record.cid || record.bookmaker;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });

  return [...groups.values()].map((items) => {
    const sorted = sortRecords(items, match);
    const weightedTimeline = buildWeightedOddsTimeline(sorted, match);
    const first = weightedTimeline[0] || sorted[0] || {};
    const last = weightedTimeline[weightedTimeline.length - 1] || sorted[sorted.length - 1] || {};

    return {
      cid: first.cid || last.cid || "",
      bookmaker: first.bookmaker || last.bookmaker || "未知公司",
      isMain: !!(first.isMain || last.isMain),
      first,
      last,
      kellyReturnScore: calculateKellyReturnScore(weightedTimeline.length ? weightedTimeline : sorted, match),
      returnDelta: numericDelta(first.returnRate, last.returnRate),
      kellyDelta: {
        home: numericDelta(first.kellyHome, last.kellyHome),
        draw: numericDelta(first.kellyDraw, last.kellyDraw),
        away: numericDelta(first.kellyAway, last.kellyAway),
      },
      count: weightedTimeline.length || items.length,
    };
  }).sort(compareBookmakerId);
}

function calculateKellyReturnScore(records, match) {
  const totals = { home: 0, draw: 0, away: 0 };
  const counts = { home: 0, draw: 0, away: 0 };
  const weightedTimeline = records.some((record) => Number.isFinite(record.weightMinutes))
    ? records
    : buildWeightedOddsTimeline(records, match);

  weightedTimeline.forEach((record) => {
    if (!Number.isFinite(record.returnRate)) return;
    const weight = Number.isFinite(record.weightMinutes) ? record.weightMinutes : 0;
    if (weight <= 0) return;
    [
      ["home", record.kellyHome],
      ["draw", record.kellyDraw],
      ["away", record.kellyAway],
    ].forEach(([key, value]) => {
      if (!Number.isFinite(value)) return;
      totals[key] += calculateKellyReturnValue(record.returnRate, value) * weight;
      counts[key] += 1;
    });
  });

  const entries = [
    { key: "home", label: "胜", value: totals.home, count: counts.home },
    { key: "draw", label: "平", value: totals.draw, count: counts.draw },
    { key: "away", label: "负", value: totals.away, count: counts.away },
  ];
  const best = entries
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.value - b.value)[0] || null;

  return {
    home: counts.home > 0 ? totals.home : null,
    draw: counts.draw > 0 ? totals.draw : null,
    away: counts.away > 0 ? totals.away : null,
    best,
  };
}

function buildOddsStateRows(records, match) {
  const orderedRecords = orderRecordsForWeight(records, match);
  const state = {};
  const rows = [];

  orderedRecords.forEach((record) => {
    const currentTimeMs = parseTimeToMs(record.time, match?.kickoffTime);
    const hasOddsUpdate = hasOddsValues(record);

    copyIdentityFields(state, record);
    copyFiniteFields(state, record, [
      "homeOdds",
      "drawOdds",
      "awayOdds",
      "returnRate",
      "kellyHome",
      "kellyDraw",
      "kellyAway",
    ]);

    if (!Number.isFinite(state.returnRate)) {
      state.returnRate = calculateReturnRate([state.homeOdds, state.drawOdds, state.awayOdds]);
    }

    if (hasOddsUpdate) {
      rows.push({
        ...state,
        time: record.time,
        cutoff: record.cutoff,
        sequence: record.sequence,
        type: record.type,
        timeMs: currentTimeMs,
      });
    }
  });

  return rows.filter((record) => record.cutoff !== false);
}

function copyIdentityFields(target, source) {
  ["cid", "bookmaker", "isMain"].forEach((key) => {
    if (source[key] !== null && source[key] !== undefined && source[key] !== "") {
      target[key] = source[key];
    }
  });
}

function copyFiniteFields(target, source, keys) {
  keys.forEach((key) => {
    if (Number.isFinite(source[key])) target[key] = source[key];
  });
}

function hasOddsValues(record) {
  return Number.isFinite(record.homeOdds)
    && Number.isFinite(record.drawOdds)
    && Number.isFinite(record.awayOdds);
}

function orderRecordsForWeight(records, match) {
  return [...records]
    .map((record, originalIndex) => ({
      record,
      originalIndex,
      timeMs: parseTimeToMs(record.time, match?.kickoffTime),
    }))
    .sort((a, b) => {
      const aTime = a.timeMs ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.timeMs ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ record }) => record);
}

function calculateKellyReturnValue(returnRate, kelly) {
  const raw = returnRate - kelly * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.abs(raw);
}

function calculateRecordWeight(records, index, windowEndMs, match) {
  const currentMs = parseTimeToMs(records[index].time, match?.kickoffTime);
  if (currentMs === null) return { holdMinutes: 0, coefficient: 0, weightMinutes: 0 };
  const nextMs = findNextLaterRecordTime(records, index, currentMs, windowEndMs, match);
  if (nextMs === null) return { holdMinutes: 0, coefficient: 0, weightMinutes: 0 };
  const kickoffMs = match?.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())
    ? match.kickoffTime.getTime()
    : null;
  const end = windowEndMs === null ? nextMs : Math.min(nextMs, windowEndMs);
  const windowStart = Number.isFinite(kickoffMs) ? kickoffMs - ODDS_WEIGHT_WINDOW_MS : null;
  const effectiveStart = Number.isFinite(windowStart) ? Math.max(currentMs, windowStart) : currentMs;
  if (end <= effectiveStart) return { holdMinutes: 0, coefficient: 0, weightMinutes: 0 };
  return calculateWeightedHold(effectiveStart, end, kickoffMs, match?.weightMode);
}

function calculateWeightedHold(startMs, endMs, kickoffMs, mode) {
  const holdMinutes = (endMs - startMs) / MINUTE_MS;
  if (!Number.isFinite(kickoffMs)) {
    return { holdMinutes, coefficient: 1, weightMinutes: holdMinutes };
  }

  const weightMode = normalizeWeightMode(mode);
  let cursor = startMs;
  let weightedMinutes = 0;

  while (cursor < endMs) {
    const minutesBeforeKickoff = Math.max(0, (kickoffMs - cursor) / MINUTE_MS);
    const nextBoundaryMinutes = getNextOddsWeightBoundaryMinutes(minutesBeforeKickoff);
    const boundaryMs = kickoffMs - nextBoundaryMinutes * MINUTE_MS;
    const segmentEnd = Math.min(endMs, Math.max(cursor + 1, boundaryMs));
    const segmentMinutes = (segmentEnd - cursor) / MINUTE_MS;
    const startCoefficient = getOddsWeightCoefficient(minutesBeforeKickoff, weightMode);
    const endMinutesBeforeKickoff = Math.max(0, (kickoffMs - segmentEnd) / MINUTE_MS);
    const endCoefficient = getOddsWeightCoefficient(endMinutesBeforeKickoff, weightMode);
    weightedMinutes += segmentMinutes * ((startCoefficient + endCoefficient) / 2);
    cursor = segmentEnd;
  }

  return {
    holdMinutes,
    coefficient: holdMinutes > 0 ? weightedMinutes / holdMinutes : 0,
    weightMinutes: weightedMinutes,
  };
}

function normalizeWeightMode(mode) {
  const key = String(mode || "normal").toLowerCase();
  return ODDS_WEIGHT_MODE_KEYS.has(key) ? key : "normal";
}

function getNextOddsWeightBoundaryMinutes(minutesBeforeKickoff) {
  const lastPoint = ODDS_WEIGHT_POINTS.at(-1);
  if (minutesBeforeKickoff <= lastPoint.minutesBeforeKickoff) return 0;
  return ODDS_WEIGHT_POINTS.find((point) => minutesBeforeKickoff > point.minutesBeforeKickoff)?.minutesBeforeKickoff
    ?? 0;
}

function getOddsWeightCoefficient(minutesBeforeKickoff, mode) {
  const lastPoint = ODDS_WEIGHT_POINTS.at(-1);
  if (minutesBeforeKickoff >= ODDS_WEIGHT_WINDOW_MINUTES) return ODDS_WEIGHT_POINTS[0][mode];
  if (minutesBeforeKickoff <= lastPoint.minutesBeforeKickoff) return lastPoint[mode];

  for (let index = 0; index < ODDS_WEIGHT_POINTS.length - 1; index += 1) {
    const upper = ODDS_WEIGHT_POINTS[index];
    const lower = ODDS_WEIGHT_POINTS[index + 1];
    if (minutesBeforeKickoff <= upper.minutesBeforeKickoff && minutesBeforeKickoff >= lower.minutesBeforeKickoff) {
      const span = upper.minutesBeforeKickoff - lower.minutesBeforeKickoff;
      const progress = span > 0 ? (upper.minutesBeforeKickoff - minutesBeforeKickoff) / span : 1;
      return upper[mode] + (lower[mode] - upper[mode]) * progress;
    }
  }

  return ODDS_WEIGHT_POINTS.at(-1)[mode];
}

function findNextLaterRecordTime(records, index, currentMs, fallbackMs, match) {
  for (let cursor = index + 1; cursor < records.length; cursor += 1) {
    const nextMs = parseTimeToMs(records[cursor]?.time, match?.kickoffTime);
    if (nextMs !== null && nextMs > currentMs) return nextMs;
  }
  return fallbackMs ?? null;
}

function getKickoffWindowEnd(records, match) {
  if (match?.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())) {
    return match.kickoffTime.getTime();
  }

  const latestRecordMs = records
    .map((record) => parseTimeToMs(record.time))
    .filter((value) => value !== null)
    .at(-1);
  return latestRecordMs ?? null;
}

function compareBookmakerId(a, b) {
  const aId = Number.parseInt(a.cid, 10);
  const bId = Number.parseInt(b.cid, 10);
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return aId - bId;
  if (Number.isFinite(aId) && !Number.isFinite(bId)) return -1;
  if (!Number.isFinite(aId) && Number.isFinite(bId)) return 1;
  return String(a.bookmaker).localeCompare(String(b.bookmaker), "zh-CN");
}

function sortRecords(records, match) {
  return [...records]
    .filter((record) => record.cutoff !== false)
    .sort((a, b) => {
      const aTime = parseTimeToMs(a.time, match?.kickoffTime) ?? Number.MAX_SAFE_INTEGER;
      const bTime = parseTimeToMs(b.time, match?.kickoffTime) ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return String(a.bookmaker).localeCompare(String(b.bookmaker), "zh-CN");
    });
}

function buildLinkCandidate(anchor, baseUrl, kickoffDate) {
  const href = absolutizeUrl(anchor.getAttribute("href"), baseUrl);
  const row = anchor.closest("tr,li,article,section,div");
  const context = cleanText([
    row?.textContent,
    anchor.textContent,
    anchor.title,
    anchor.getAttribute("aria-label"),
  ].filter(Boolean).join(" "));
  const times = extractTimes(context, kickoffDate);
  return { href, context, times };
}

function candidateToOddsUrl(candidate, match) {
  const id = candidate.href.match(/\d{5,}/)?.[0];
  const oddsUrl = buildOddsUrl(id || candidate.href);
  return {
    oddsUrl: oddsUrl || candidate.href,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
  };
}

function absolutizeUrl(href, baseUrl) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  try {
    return new URL(href, baseUrl || window.location.href).href;
  } catch {
    return href;
  }
}

function normalizeHtmlText(text) {
  let output = text;
  CHINESE_NUMERAL_MAP.forEach((value, key) => {
    output = output.replaceAll(key, value);
  });
  return output
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n");
}

function getRowCells(row) {
  return [...row.querySelectorAll("th,td")]
    .map((cell) => cleanText(cell.textContent))
    .filter(Boolean);
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

function parseHtmlDocument(html) {
  const wrapped = /<html|<body/i.test(html) ? html : `<table><tbody>${html}</tbody></table>`;
  return new DOMParser().parseFromString(wrapped, "text/html");
}

function parseJsonPayload(payload) {
  const normalized = normalizeHtmlText(payload).trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.search(/[\[{]/);
    const end = Math.max(normalized.lastIndexOf("]"), normalized.lastIndexOf("}"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(normalized.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function matchNumber(text, pattern) {
  const value = String(text || "").match(pattern)?.[1];
  if (value === undefined) return null;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function extractFixtureId(value) {
  return String(value || "").match(/(?:ouzhi-|shuju-|id=|fixtureid=|\/)(\d{5,})/i)?.[1] || "";
}

function looksLikeOddsRow(rowText, cells) {
  const numericCount = cells.filter(looksNumeric).length;
  const hasBookmaker = KNOWN_BOOKMAKER_WORDS.some((word) => rowText.includes(word)) || /公司|平均|最高|最低/.test(rowText);
  const hasOddsRange = cells.some((cell) => {
    const value = parseNumber(cell);
    return value !== null && value >= 1.01 && value < 30;
  });
  return numericCount >= 6 && hasOddsRange && (hasBookmaker || cells[0].length <= 20);
}

function getCompanyNameFromRow(row, cells) {
  const dataName = row.dataset.company || row.dataset.cid || row.getAttribute("title");
  if (dataName && !/^\d+$/.test(dataName)) return cleanText(dataName);

  const anchorName = [...row.querySelectorAll("a")]
    .map((anchor) => cleanText(anchor.textContent || anchor.title))
    .find((text) => text && !looksNumeric(text) && text.length <= 24);
  if (anchorName) return anchorName;

  const candidate = cells.find((cell) => !looksNumeric(cell) && !extractTime(cell) && cell.length <= 24);
  return candidate || "未知公司";
}

function getCompanyNameFromCompanyCell(cell) {
  const title = cleanText(cell.getAttribute("title"));
  if (title) return title;

  const fullName = cleanText(cell.querySelector(".quancheng")?.textContent);
  if (fullName) return fullName;

  const anchor = cleanText(cell.querySelector("a")?.textContent);
  if (anchor) return anchor;

  return cleanText(cell.textContent).replace(/\(.+?\)/g, "").trim();
}

function isValidBookmakerName(value) {
  const text = cleanText(value);
  if (!text || text.length > 40) return false;
  return !/^(平均值|最高值|最低值|离散值|公司|赔率公司|序号|统计)$/.test(text);
}

function readTableTriples(table) {
  if (!table) return [];
  return [...table.querySelectorAll("tr")]
    .map((row) => [...row.querySelectorAll("td")]
      .map((cell) => parseNumber(cell.textContent))
      .filter((value) => value !== null)
      .slice(0, 3))
    .filter((values) => values.length === 3);
}

function readSingleColumnValues(table) {
  if (!table) return [];
  return [...table.querySelectorAll("tr")]
    .map((row) => parseNumber(row.textContent))
    .filter((value) => value !== null);
}

function getCompanyNameFromContext(table) {
  const dataName = table.dataset.company || table.getAttribute("data-name");
  if (dataName) return cleanText(dataName);

  let cursor = table.previousElementSibling;
  let guard = 0;
  while (cursor && guard < 4) {
    const text = cleanText(cursor.textContent);
    const known = KNOWN_BOOKMAKER_WORDS.find((word) => text.includes(word));
    if (known) return text.replace(/欧赔|凯利|变化|记录|：|:/g, "").trim().slice(0, 24);
    cursor = cursor.previousElementSibling;
    guard += 1;
  }
  return "";
}

function inferCompanyFromRows(rows) {
  for (const row of rows) {
    const cells = getRowCells(row);
    const candidate = cells.find((cell) => !looksNumeric(cell) && !extractTime(cell) && cell.length <= 24);
    if (candidate && KNOWN_BOOKMAKER_WORDS.some((word) => candidate.includes(word))) return candidate;
  }
  return "";
}

function extractTeamsFromTitle(title) {
  const cleanTitle = cleanText(title).replace(/[-_].*?(500|彩票网|彩票).*$/i, "");
  const match = cleanTitle.match(/(.{1,32}?)(?:\s*VS\s*|\s*vs\s*|\s+v\s+|对阵)(.{1,32}?)(?:[（(]([^（）()]+)[）)]|[-_]|$)/i);
  if (!match) return {};
  return {
    homeTeam: cleanTeamLabel(match[1]),
    awayTeam: cleanTeamLabel(match[2]),
    matchType: cleanMatchType(match[3]),
  };
}

function inferAwayTeamFromNames(names, homeTeam) {
  return names.find((name) => name && normalizeTeamName(name) !== normalizeTeamName(homeTeam)) || "";
}

function inferMatchType(text) {
  return cleanMatchType(
    String(text || "").match(/(?:赛事|联赛|比赛类型|轮次)[:：]?\s*([^，。|\s<]{2,30})/)?.[1]
  );
}

function cleanMatchType(value) {
  return cleanText(value)
    .replace(/百家欧赔|欧赔|赔率|分析|指数/g, "")
    .replace(/[|｜_\-]+$/g, "")
    .trim();
}

function extractTeamNamesFromHtml(html) {
  return [...String(html || "").matchAll(/class=(?:"[^"]*\bhd_name\b[^"]*"|'[^']*\bhd_name\b[^']*'|[^\s>]*\bhd_name\b[^\s>]*)[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => cleanTeamLabel(stripHtml(match[1])))
    .filter(Boolean);
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function cleanTeamLabel(value) {
  return cleanText(value)
    .replace(/[（(][^（）()]*[）)]/g, "")
    .replace(/主队|客队|球队|资料|赛程|近期|历史|排名/g, "")
    .replace(/[|｜_\-]+$/g, "")
    .trim();
}

function extractKickoffDate(text) {
  const candidates = [
    ...String(text || "").matchAll(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?/g),
  ]
    .map((match) => normalizeTimeString(match[0]))
    .map((time) => parseTimeToMs(time))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);

  if (!candidates.length) return null;
  return new Date(candidates[0]);
}

function parseNumber(value) {
  const text = cleanText(value)
    .replace(/,/g, "")
    .replace(/↑|↓|升|降/g, "")
    .replace(/[^\d.+%-]/g, "");

  if (!text || text === "." || text === "-" || text === "%") return null;
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return null;
  return number;
}

function looksNumeric(value) {
  return parseNumber(value) !== null;
}

function extractTimeFromCells(cells) {
  for (const cell of cells) {
    const time = extractTime(cell);
    if (time) return time;
  }
  return null;
}

function extractTime(value) {
  const text = cleanText(value);
  const full = text.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?/);
  if (full) return normalizeTimeString(full[0]);

  const short = text.match(/\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?/);
  if (short) return normalizeTimeString(short[0]);

  const clock = text.match(/\d{1,2}:\d{2}(?::\d{2})?/);
  if (clock && /变化|更新|即时|开盘|赛前/.test(text)) return clock[0];
  return null;
}

function extractTimes(value, kickoffTime) {
  const text = cleanText(value);
  const matches = [
    ...text.matchAll(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?/g),
    ...text.matchAll(/\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?/g),
    ...text.matchAll(/\d{1,2}:\d{2}(?::\d{2})?/g),
  ];

  return [...new Set(matches.map((match) => normalizeTimeString(match[0])))]
    .map((time) => {
      if (/^\d{1,2}:\d{2}/.test(time) && kickoffTime instanceof Date) {
        return `${toDateOnly(kickoffTime)} ${time}`;
      }
      return time;
    });
}

function normalizeTimeString(value) {
  return cleanText(value)
    .replace(/[年月/.]/g, "-")
    .replace(/日/g, "")
    .replace(/-(\d)(?=-)/g, "-0$1")
    .replace(/-(\d)\s/g, "-0$1 ")
    .replace(/\s(\d):/, " 0$1:");
}

function parseTimeToMs(value, kickoffTime) {
  if (!value) return null;
  const text = cleanText(value);
  const withYear = /^20\d{2}-\d{1,2}-\d{1,2}/.test(text)
    ? text
    : inferYearForTime(text, kickoffTime);
  const normalized = withYear.replace(/\//g, "-").replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function inferYearForTime(value, kickoffTime) {
  const hasValidKickoff = kickoffTime instanceof Date && !Number.isNaN(kickoffTime.getTime());
  const baseYear = hasValidKickoff ? kickoffTime.getFullYear() : new Date().getFullYear();
  if (/^\d{1,2}-\d{1,2}/.test(value)) return `${baseYear}-${value}`;
  if (/^\d{1,2}:\d{2}/.test(value) && hasValidKickoff) {
    return `${toDateOnly(kickoffTime)} ${value}`;
  }
  return value;
}

function isBeforeKickoff(time, kickoffTime) {
  if (!(kickoffTime instanceof Date) || Number.isNaN(kickoffTime.getTime())) return true;
  const ms = parseTimeToMs(time, kickoffTime);
  if (ms === null) return true;
  return ms <= kickoffTime.getTime();
}

function isNearKickoff(time, kickoffTime) {
  const ms = parseTimeToMs(time, kickoffTime);
  if (ms === null) return false;
  return Math.abs(ms - kickoffTime.getTime()) <= 1000 * 60 * 90;
}

function inferReturnRate(cells, restNumbers, odds) {
  const percentCell = cells.find((cell) => /%/.test(cell));
  if (percentCell) return parseNumber(percentCell);

  const plausible = restNumbers.find((value) => value > 20 && value <= 100);
  return plausible ?? calculateReturnRate(odds);
}

function calculateReturnRate(odds) {
  if (!Array.isArray(odds) || odds.length < 3 || odds.some((value) => !Number.isFinite(value) || value <= 1)) return null;
  const implied = odds.reduce((sum, value) => sum + 1 / value, 0);
  if (!implied) return null;
  return 100 / implied;
}

function normalizeTeamName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[·・\s\-_.()（）[\]【】]/g, "")
    .replace(/足球俱乐部|俱乐部|fc|cf|afc|sc/g, "");
}

function toDateOnly(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function isLocalDev() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function getProxyTargetKey(hostname) {
  if (hostname === "live.500.com") return "live";
  if (hostname === "odds.500.com") return "odds";
  if (hostname === "liansai.500.com") return "liansai";
  return "";
}
