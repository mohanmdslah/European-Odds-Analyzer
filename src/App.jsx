import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent } from "framer-motion";
import {
  Activity,
  CalendarClock,
  Download,
  FileJson,
  Gauge,
  Goal,
  ListFilter,
  Play,
  RefreshCcw,
  ShieldCheck,
  Search,
  Trophy,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { SAMPLE_ODDS_HTML } from "./data/sampleData";
import {
  buildScheduleScanUrls,
  buildBettingAnalysisUrls,
  buildMoreBookmakersUrl,
  buildOddsUrl,
  buildOddsHistoryUrl,
  buildRequestUrl,
  buildWeightedOddsTimeline,
  buildScheduleUrls,
  buildOddsResult,
  decodeResponse,
  extractScheduleScanUrls,
  findMatchCandidate,
  formatDisplayDate,
  formatNumber,
  formatOddsTriple,
  formatPercent,
  mergeBookmakerLists,
  parseBookmakerRows,
  parseFixtureConfig,
  parseScheduleFixtures,
  parseBettingAnalysisPayload,
  parseMatchInfo,
  parseMatchResult,
  parseOddsHistoryPayload,
  parseOddsPayload,
  toDatetimeLocal,
} from "./lib/oddsParser";
import "./styles.css";

const emptyResult = { records: [], bookmakers: [], match: null, weightMode: "" };
const emptyBettingAnalysis = {
  sourceUrl: "",
  volume: { home: null, draw: null, away: null },
  trend: [],
  largeVolume: { home: null, draw: null, away: null },
  largeDistribution: {
    home: { buy: null, sell: null },
    draw: { buy: null, sell: null },
    away: { buy: null, sell: null },
  },
  largeDetails: [],
  summaryText: "",
};
const MAIN_COMPANY_MIN_COUNT = 8;
const HISTORY_CONCURRENCY = 2;
const SCHEDULE_SCAN_CONCURRENCY = 4;
const SCHEDULE_RESULT_CONCURRENCY = 2;
const PROXY_BATCH_ENDPOINT = "/proxy500/batch";
const PROXY_BATCH_SIZE = 20;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const WEIGHT_MODE_OPTIONS = [
  { key: "hot", label: "Hot" },
  { key: "normal", label: "Normal" },
  { key: "cold", label: "Cold" },
];
const SCHEDULE_DAY_OFFSETS = Array.from({ length: 15 }, (_, index) => index - 7);
const fadeUp = {
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.26, ease: "easeOut" },
};
const cardHover = {
  y: -1,
  transition: { duration: 0.18, ease: "easeOut" },
};

export default function App() {
  const [form, setForm] = useState({
    kickoffTime: "",
    homeTeam: "",
    awayTeam: "",
    matchType: "",
    matchInput: "",
    scheduleInput: "",
    proxyPrefix: "",
    weightMode: "hot",
  });
  const [result, setResult] = useState(emptyResult);
  const [bettingAnalysis, setBettingAnalysis] = useState(emptyBettingAnalysis);
  const [scheduleFixtures, setScheduleFixtures] = useState([]);
  const [logs, setLogs] = useState([
    logLine("页面已加载。可输入比赛 ID/URL 采集，也可扫描前 7 天至后 7 天单场比分赛程。"),
  ]);
  const [status, setStatus] = useState("idle");
  const [activeTab, setActiveTab] = useState("bookmakers");
  const [selectedScheduleDate, setSelectedScheduleDate] = useState(() => toDateKey(new Date()));
  const [isLoading, setIsLoading] = useState(false);
  const [isScanningSchedule, setIsScanningSchedule] = useState(false);
  const [expandedBookmakers, setExpandedBookmakers] = useState(() => new Set());
  const [controlCardHeight, setControlCardHeight] = useState(0);
  const [scheduleVisibleCount, setScheduleVisibleCount] = useState(24);
  const controlCardRef = useRef(null);
  const scheduleTabsRef = useRef(null);

  const match = useMemo(() => readMatch(form), [form]);
  const displayResult = useMemo(
    () => {
      if (!result.records.length) return result;
      const resultMatch = result.match || match;
      return {
        ...buildOddsResult(result.records, resultMatch),
        match: resultMatch,
        weightMode: result.weightMode || resultMatch.weightMode || "hot",
      };
    },
    [result, match]
  );
  const resultWeightModeLabel = displayResult.records.length
    ? getWeightModeLabel(displayResult.weightMode || displayResult.match?.weightMode)
    : "--";
  const displayMatch = displayResult.match || match;
  const heroMetrics = useMemo(() => buildHeroMetrics(displayResult), [displayResult]);
  const firstRecord = displayResult.records[0];
  const lastRecord = displayResult.records[displayResult.records.length - 1];
  const canExport = displayResult.records.length > 0;
  const scheduleDays = useMemo(() => buildScheduleDays(new Date(), scheduleFixtures), [scheduleFixtures]);
  const selectedScheduleDay = scheduleDays.find((day) => day.key === selectedScheduleDate) || scheduleDays.find((day) => day.isToday) || scheduleDays[0];
  const selectedScheduleFixtures = selectedScheduleDay?.fixtures || [];
  const visibleScheduleFixtures = selectedScheduleFixtures.slice(0, scheduleVisibleCount);
  const hasMoreScheduleFixtures = scheduleVisibleCount < selectedScheduleFixtures.length;

  useLayoutEffect(() => {
    const node = controlCardRef.current;
    if (!node || typeof window === "undefined" || !window.ResizeObserver) return;

    let frame = 0;
    const updateHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextHeight = Math.ceil(node.getBoundingClientRect().height);
        setControlCardHeight((current) => current === nextHeight ? current : nextHeight);
      });
    };

    updateHeight();
    const observer = new window.ResizeObserver(updateHeight);
    observer.observe(node);
    window.addEventListener("resize", updateHeight);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  useEffect(() => {
    const tabs = scheduleTabsRef.current;
    if (!tabs) return;

    const activeTabButton = tabs.querySelector('[data-active-schedule-day="true"]');
    const todayTabButton = tabs.querySelector('[data-schedule-today="true"]');
    const target = activeTabButton || todayTabButton;
    if (!target) return;

    const centeredLeft = target.offsetLeft - (tabs.clientWidth - target.offsetWidth) / 2;
    const maxLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    tabs.scrollTo({ left: clamp(centeredLeft, 0, maxLeft), behavior: "auto" });
  }, [selectedScheduleDay?.key, scheduleDays]);

  useEffect(() => {
    setScheduleVisibleCount(24);
  }, [selectedScheduleDay?.key]);

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function appendLog(message) {
    setLogs((current) => [...current, logLine(message)]);
  }

  function resetResult() {
    setResult(emptyResult);
    setBettingAnalysis(emptyBettingAnalysis);
    setExpandedBookmakers(new Set());
  }

  function toggleBookmaker(key) {
    setExpandedBookmakers((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleFixtureListScroll(event) {
    if (!hasMoreScheduleFixtures) return;
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 120) return;
    setScheduleVisibleCount((current) => Math.min(current + 16, selectedScheduleFixtures.length));
  }

  async function handleFetch(event) {
    event.preventDefault();
    setIsLoading(true);
    setStatus("idle");
    resetResult();
    appendLog(buildQueryLog(match));

    try {
      await collectOddsForMatch(match);
    } catch (error) {
      setStatus("warn");
      appendLog(`获取失败：${error.message}`);
      appendLog("如果仍失败，通常是目标站点反爬、接口跳转或本地代理未启动。也可直接输入比赛 ID/欧赔页 URL。");
    } finally {
      setIsLoading(false);
    }
  }

  function handleLoadDemo() {
    setForm((current) => ({
      ...current,
      homeTeam: current.homeTeam || "曼城",
      awayTeam: current.awayTeam || "利物浦",
    }));
    parseDemoPayload();
  }

  async function handleScanScheduleFixtures() {
    setIsScanningSchedule(true);
    appendLog("开始扫描前 7 天至后 7 天单场比分赛程。");

    try {
      const scanTime = new Date();
      setSelectedScheduleDate(toDateKey(scanTime));
      const pendingUrls = buildScheduleScanUrls(scanTime);
      const seenUrls = new Set();
      const chunks = [];
      appendLog(`赛程扫描源：${pendingUrls.length} 个初始页面。`);

      while (pendingUrls.length) {
        const batch = pendingUrls.splice(0, SCHEDULE_SCAN_CONCURRENCY)
          .filter((url) => {
            if (seenUrls.has(url)) return false;
            seenUrls.add(url);
            return true;
          });
        if (!batch.length) continue;

        const tasks = batch.map((url) => async () => {
          const requestUrl = buildRequestUrl(url, match.proxyPrefix);
          appendLog(`扫描赛程页：${requestUrl}`);
          try {
            const response = await fetch(requestUrl, { credentials: "omit", cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const html = await decodeResponse(response);
            const parsedFixtures = parseScheduleFixtures(html, url, scanTime);
            extractScheduleScanUrls(html, url).forEach((nextUrl) => {
              if (!seenUrls.has(nextUrl) && !pendingUrls.includes(nextUrl)) pendingUrls.push(nextUrl);
            });
            if (parsedFixtures.length) {
              appendLog(`识别赛程：${parsedFixtures.length} 场。`);
            }
            return parsedFixtures;
          } catch (error) {
            appendLog(`赛程页扫描失败：${error.message}`);
            return [];
          }
        });

        chunks.push(...(await runLimited(tasks, SCHEDULE_SCAN_CONCURRENCY)).flat());
      }

      const fixtures = dedupeFixtures(chunks)
        .sort((a, b) => a.kickoffTime - b.kickoffTime);
      setScheduleFixtures(fixtures);

      if (fixtures.length) {
        appendLog(`赛程扫描完成：${fixtures.length} 场单场比分比赛，扫描 ${seenUrls.size} 页，去重前 ${chunks.length} 条。`);
        const hydratedFixtures = await hydrateFinishedFixtures(fixtures, scanTime, match, appendLog);
        setScheduleFixtures(hydratedFixtures.sort((a, b) => a.kickoffTime - b.kickoffTime));
      } else {
        appendLog("前 7 天至后 7 天内没有识别到单场比分比赛，或页面结构发生变化。");
      }
    } finally {
      setIsScanningSchedule(false);
    }
  }

  async function handleSelectScheduleFixture(fixture) {
    const nextForm = {
      ...form,
      kickoffTime: fixture.kickoffTime ? toDatetimeLocal(fixture.kickoffTime) : form.kickoffTime,
      homeTeam: fixture.homeTeam || form.homeTeam,
      awayTeam: fixture.awayTeam || form.awayTeam,
      matchType: fixture.matchType || form.matchType,
      matchInput: fixture.oddsUrl || fixture.matchInput || form.matchInput,
    };
    setForm(nextForm);
    setIsLoading(true);
    setStatus("idle");
    resetResult();
    appendLog(`选择赛程：${fixture.homeTeam} VS ${fixture.awayTeam}，${formatDisplayDate(fixture.kickoffTime)}。`);

    try {
      await collectOddsForMatch(readMatch(nextForm));
    } catch (error) {
      setStatus("warn");
      appendLog(`获取失败：${error.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function collectOddsForMatch(targetMatch) {
    let directUrl = buildOddsUrl(targetMatch.matchInput);
    if (!directUrl) {
      if (!canDiscoverFromSchedule(targetMatch)) {
        setStatus("warn");
        appendLog("请填写比赛 ID/欧赔页 URL；如果要从赛程页自动匹配，则需要填写比赛开始时间和主客队。");
        return;
      }
      appendLog("未提供比赛 ID/URL，开始从赛程页寻找欧赔链接。");
      directUrl = await discoverOddsUrl(targetMatch, appendLog);
    }

    if (!directUrl) {
      setStatus("warn");
      appendLog("没有找到匹配的欧赔页。请填写赛程页 URL、配置代理前缀，或直接输入比赛 ID/欧赔页 URL。");
      return;
    }

    const requestUrl = buildRequestUrl(directUrl, targetMatch.proxyPrefix);
    appendLog(`读取欧赔页：${requestUrl}`);
    const response = await fetch(requestUrl, { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await decodeResponse(response);
    appendLog(`已获取页面，长度 ${html.length.toLocaleString("zh-CN")} 字符。`);
    const config = parseFixtureConfig(html, directUrl);
    const pageMatchInfo = parseMatchInfo(html, directUrl);
    const resolvedMatch = mergeMatchInfo(targetMatch, pageMatchInfo);
    syncResolvedMatch(pageMatchInfo);

    if (pageMatchInfo.homeTeam || pageMatchInfo.awayTeam || pageMatchInfo.kickoffTime) {
      appendLog(`页面识别：${resolvedMatch.homeTeam || "主队"} VS ${resolvedMatch.awayTeam || "客队"}，${resolvedMatch.matchType || "赛事未知"}，开赛 ${formatDisplayDate(resolvedMatch.kickoffTime)}。`);
    }

    const companies = parseBookmakerRows(html, resolvedMatch);

    if (!config.fixtureId || companies.length === 0) {
      appendLog("未识别到 500 欧赔公司主表，转入普通页面解析。");
      parseOddsHtmlFallback(html, directUrl, resolvedMatch);
      return;
    }

    appendLog(`识别到比赛 ID ${config.fixtureId}，首屏 ${companies.length} 家真实公司。`);
    const allCompanies = await loadAllBookmakers(config, companies, resolvedMatch, appendLog);
    const mainCompanies = pickMainCompanies(allCompanies);
    appendLog(`仅保留主流公司：${mainCompanies.length}/${allCompanies.length} 家。`);
    appendLog(`准备逐家公司拉取完整变化：${mainCompanies.length} 家公司。`);

    const historyRecords = await loadHistoryRecords(config, mainCompanies, resolvedMatch, appendLog);
    const parsed = withResultMeta(buildOddsResult(historyRecords, resolvedMatch), resolvedMatch);
    setResult(parsed);
    await loadBettingAnalysis(config, resolvedMatch);

    if (parsed.records.length === 0) {
      setStatus("warn");
      appendLog("已识别公司，但历史接口没有返回可用变化记录。");
    } else {
      setStatus("ok");
      appendLog(`采集完成：${parsed.bookmakers.length} 家公司，${parsed.records.length} 条完整变化记录。`);
    }
  }

  function parseOddsHtmlFallback(payload, sourceLabel, overrideMatch = match) {
    appendLog(`解析来源：${sourceLabel}`);
    const pageMatchInfo = parseMatchInfo(payload, sourceLabel);
    const resolvedMatch = mergeMatchInfo(overrideMatch, pageMatchInfo);
    syncResolvedMatch(pageMatchInfo);
    const parsed = withResultMeta(parseOddsPayload(payload, resolvedMatch), resolvedMatch);
    setResult(parsed);
    if (parsed.records.length === 0) {
      setStatus("warn");
      appendLog("已解析页面，但没有识别到赔率变化记录。请确认页面包含欧赔表格或历史变化数据。");
    } else {
      setStatus("ok");
      appendLog(`解析完成：${parsed.bookmakers.length} 家公司，${parsed.records.length} 条变化记录。`);
    }
  }

  function parseDemoPayload() {
    try {
      parseOddsHtmlFallback(SAMPLE_ODDS_HTML, "内置样例");
    } catch (error) {
      setStatus("error");
      appendLog(`解析失败：${error.message}`);
    }
  }

  async function loadBettingAnalysis(config, targetMatch) {
    const urls = buildBettingAnalysisUrls(config);
    if (!urls.length) return;

    for (const url of urls) {
      const requestUrl = buildRequestUrl(url, targetMatch.proxyPrefix);
      try {
        appendLog(`读取投注分析：${requestUrl}`);
        const response = await fetch(requestUrl, { credentials: "omit", cache: "no-store" });
        if (!response.ok) {
          appendLog(`投注分析返回 HTTP ${response.status}，继续尝试下一个。`);
          continue;
        }
        const payload = await decodeResponse(response);
        const parsed = parseBettingAnalysisPayload(payload, targetMatch, url);
        if (!hasBettingAnalysisData(parsed)) {
          appendLog("投注分析页未识别到必发交易模块，继续尝试下一个。");
          continue;
        }
        setBettingAnalysis(parsed);
        appendLog("投注分析数据已更新。");
        return;
      } catch (error) {
        appendLog(`投注分析读取失败：${error.message}`);
      }
    }
  }

  function exportCsv() {
    const headers = ["时间", "公司ID", "是否主流", "公司", "胜", "平", "负", "返还率", "凯利胜", "凯利平", "凯利负", "类型"];
    const rows = displayResult.records.map((record) => [
      record.time || "",
      record.cid || "",
      record.isMain ? "是" : "",
      record.bookmaker,
      valueOrEmpty(record.homeOdds),
      valueOrEmpty(record.drawOdds),
      valueOrEmpty(record.awayOdds),
      valueOrEmpty(record.returnRate),
      valueOrEmpty(record.kellyHome),
      valueOrEmpty(record.kellyDraw),
      valueOrEmpty(record.kellyAway),
      record.type || "",
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    downloadBlob(csv, `${filenameBase(match)}.csv`, "text/csv;charset=utf-8");
  }

  function exportJson() {
    const payload = {
      match,
      records: displayResult.records,
      bookmakers: displayResult.bookmakers,
      exportedAt: new Date().toISOString(),
    };
    downloadBlob(JSON.stringify(payload, null, 2), `${filenameBase(match)}.json`, "application/json;charset=utf-8");
  }

  function syncResolvedMatch(info) {
    if (!info.homeTeam && !info.awayTeam && !info.matchType && !info.kickoffTime) return;
    setForm((current) => ({
      ...current,
      homeTeam: info.homeTeam || current.homeTeam,
      awayTeam: info.awayTeam || current.awayTeam,
      matchType: info.matchType || current.matchType,
      kickoffTime: info.kickoffTime ? toDatetimeLocal(info.kickoffTime) : current.kickoffTime,
    }));
  }

  return (
    <motion.main className="page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }}>
      <div className="cyber-grid" aria-hidden="true" />
      <div className="motion-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="particle-field" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <motion.section className="scoreboard" {...fadeUp}>
        <div className="scoreboard__copy">
          <p className="eyebrow"><Trophy size={15} /> AI Football Odds Intelligence</p>
          <h1>
            {match.homeTeam || match.awayTeam ? (
              <>
                <span className="team-name team-name--home">{match.homeTeam || "待识别"}</span>
                <span className="versus-art">VS</span>
                <span className="team-name team-name--away">{match.awayTeam || "待识别"}</span>
              </>
            ) : "等待采集"}
          </h1>
          <p>{match.matchType || "输入比赛 ID 即可启动采集；开赛时间、球队名和比赛类型会优先从欧赔页自动识别。"}</p>
          <div className="hero-chips">
            <div className={`match-light match-light--${status}`}>
              <span />
              {statusLabel(status)}
            </div>
            <div className="kickoff-chip">
              <CalendarClock size={16} />
              {formatDisplayDate(match.kickoffTime)}
            </div>
            <div className="kickoff-chip">
              <Gauge size={16} />
              {resultWeightModeLabel === "--" ? getWeightModeLabel(match.weightMode) : resultWeightModeLabel}
            </div>
          </div>
        </div>

        <div className="scoreboard__side">
          <motion.div className="ai-score-card glass-card interactive-glow" whileHover={cardHover}>
            <div className="odds-shift-head">
              <span>主流公司平均欧赔变化</span>
              <strong>{heroMetrics.averageOddsMeta}</strong>
            </div>
            <div className="avg-odds-shift">
              {heroMetrics.averageOddsChange.map((item) => (
                <div className={`avg-odds-pill avg-odds-pill--${item.key}`} key={item.key}>
                  <i aria-hidden="true" />
                  <span>
                    <small>{item.label}</small>
                    <strong className={Number.isFinite(item.value) ? oddsClassByDelta(item.value) : "is-placeholder"}>
                      {formatSigned(item.value)}
                    </strong>
                  </span>
                </div>
              ))}
            </div>
            <p>即时赔率 - 初始赔率，按主流公司取平均。</p>
          </motion.div>
          <ProbabilityBars items={heroMetrics.probabilities} />
        </div>

        <div className="hero-market-grid">
          <HeroStatCard
            label="主流公司矩阵"
            value={heroMetrics.hasData ? displayResult.bookmakers.length : null}
            meta="Mainstream Bookmakers"
            tone="cyan"
          />
          <HeroStatCard
            label="赔率状态样本"
            value={heroMetrics.hasData ? displayResult.records.length : null}
            meta="Odds State Records"
            tone="violet"
          />
          <MarketMiniCard
            label="凯利指数"
            value={Number.isFinite(heroMetrics.kellyIndex) ? formatNumber(heroMetrics.kellyIndex, 3) : "--"}
            meta="Risk Pressure"
            tone="violet"
            series={heroMetrics.kellyTrend}
          />
          <MarketMiniCard
            label="资金热度"
            value={Number.isFinite(heroMetrics.heat) ? `${Math.round(heroMetrics.heat)}%` : "--"}
            meta="Market Attention"
            tone="green"
            series={heroMetrics.heatTrend}
          />
        </div>
      </motion.section>

      <motion.section
        className="command-deck"
        style={controlCardHeight ? { "--control-card-height": `${controlCardHeight}px` } : undefined}
        {...fadeUp}
        transition={{ duration: 0.26, delay: 0.04, ease: "easeOut" }}
      >
        <motion.div ref={controlCardRef} className="control-card interactive-glow" whileHover={cardHover}>
          <div className="card-title">
            <Goal size={22} />
            <div>
              <span>Command Input</span>
              <strong>采集入口</strong>
            </div>
          </div>

          <form className="query-form" onSubmit={handleFetch}>
            <Field label="比赛 ID 或欧赔页 URL" icon={<ShieldCheck size={16} />}>
              <input
                type="text"
                value={form.matchInput}
                onChange={(event) => updateForm("matchInput", event.target.value)}
                placeholder="1359169 或 https://odds.500.com/fenxi/ouzhi-1359169.shtml"
              />
            </Field>

            <div className="optional-grid">
              <Field label="比赛开始时间（可选）" icon={<CalendarClock size={16} />}>
                <input
                  type="datetime-local"
                  value={form.kickoffTime}
                  onChange={(event) => updateForm("kickoffTime", event.target.value)}
                />
              </Field>

              <Field label="赛程页 URL（可选）" icon={<ListFilter size={16} />}>
                <input
                  type="text"
                  value={form.scheduleInput}
                  onChange={(event) => updateForm("scheduleInput", event.target.value)}
                  placeholder="按赛程匹配时使用"
                />
              </Field>
            </div>

            <div className="team-row">
              <Field label="主队（可选）">
                <input
                  type="text"
                  value={form.homeTeam}
                  onChange={(event) => updateForm("homeTeam", event.target.value)}
                  placeholder="页面无法识别时填写"
                />
              </Field>
              <div className="versus">VS</div>
              <Field label="客队（可选）">
                <input
                  type="text"
                  value={form.awayTeam}
                  onChange={(event) => updateForm("awayTeam", event.target.value)}
                  placeholder="页面无法识别时填写"
                />
              </Field>
            </div>

            <Field label="比赛类型（自动识别，可选）" icon={<Trophy size={16} />}>
              <input
                type="text"
                value={form.matchType}
                onChange={(event) => updateForm("matchType", event.target.value)}
                placeholder="如：26世界杯1/16决赛"
              />
            </Field>

            <Field label="权重模型" icon={<Gauge size={16} />}>
              <div className="weight-mode-switch" role="group" aria-label="权重模型">
                {WEIGHT_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    className={form.weightMode === option.key ? "active" : ""}
                    type="button"
                    onClick={() => updateForm("weightMode", option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="代理前缀（可选）" icon={<RefreshCcw size={16} />}>
              <input
                type="url"
                value={form.proxyPrefix}
                onChange={(event) => updateForm("proxyPrefix", event.target.value)}
                placeholder="https://your-proxy.example/fetch?url="
              />
            </Field>

            <div className="action-row">
              <button className="btn btn-primary" type="submit" disabled={isLoading}>
                <RefreshCcw size={17} className={isLoading ? "spin" : ""} />
                {isLoading ? "采集中" : "启动采集"}
              </button>
              <button className="btn" type="button" onClick={handleLoadDemo}>
                <Play size={17} />
                样例
              </button>
            </div>
          </form>
        </motion.div>

        <div className="future-panel interactive-glow">
          <div className="future-panel__head">
            <div>
              <span>-7D / +7D</span>
              <strong>赛程 <em>{selectedScheduleFixtures.length}/{scheduleFixtures.length}</em></strong>
            </div>
            <button className="icon-btn" type="button" onClick={handleScanScheduleFixtures} disabled={isScanningSchedule}>
              <Search size={17} className={isScanningSchedule ? "spin" : ""} />
              {isScanningSchedule ? "扫描中" : "扫描"}
            </button>
          </div>

          <div className="schedule-day-tabs" role="tablist" aria-label="赛程日期" ref={scheduleTabsRef}>
            {scheduleDays.map((day) => (
              <button
                key={day.key}
                className={day.key === selectedScheduleDay?.key ? "active" : ""}
                type="button"
                data-active-schedule-day={day.key === selectedScheduleDay?.key}
                data-schedule-today={day.isToday}
                onClick={() => setSelectedScheduleDate(day.key)}
              >
                <span>{day.label}</span>
                <strong>{day.count}</strong>
              </button>
            ))}
          </div>

          <div className="fixture-list" onScroll={handleFixtureListScroll}>
            {selectedScheduleFixtures.length === 0 && (
              <div className="fixture-empty" key="empty">
                <CalendarClock size={22} />
                <p>{scheduleFixtures.length ? "当前日期暂无单场比分赛程。" : "一键扫描 500 单场比分，列出前后 7 天赛程。"}</p>
              </div>
            )}
            {visibleScheduleFixtures.map((fixture) => (
              <article
                className="fixture-item"
                key={fixture.key}
              >
                <div className="fixture-item__time">{formatDisplayDate(fixture.kickoffTime)}</div>
                <div className="fixture-item__teams">
                  <strong>{fixture.homeTeam || "主队"} <span>VS</span> {fixture.awayTeam || "客队"}</strong>
                  <p>
                    {fixture.matchType || "赛事未知"}
                    {fixture.resultText && <em>{fixture.resultText}</em>}
                  </p>
                </div>
                <button className="fixture-pick" type="button" onClick={() => handleSelectScheduleFixture(fixture)} disabled={isLoading}>
                  采集
                </button>
              </article>
            ))}
            {hasMoreScheduleFixtures && (
              <div className="fixture-load-more">
                继续向下滑动加载更多
              </div>
            )}
          </div>
        </div>
      </motion.section>

      <motion.section className="workspace-grid" {...fadeUp} transition={{ duration: 0.26, delay: 0.08, ease: "easeOut" }}>
        <motion.section className="data-card interactive-glow" whileHover={cardHover}>
          <header className="data-header">
            <div>
              <p className="eyebrow"><Activity size={15} /> Weighted Signal Matrix</p>
              <h2>主流公司赔率矩阵</h2>
              <p>累计值按所选模型计算赛前 72 小时内的赔率变化，展开公司可查看每次赔率状态停留权重。</p>
            </div>
            <div className="export-row">
              <button className="icon-btn" type="button" onClick={exportCsv} disabled={!canExport} title="导出 CSV">
                <Download size={18} />
                CSV
              </button>
              <button className="icon-btn" type="button" onClick={exportJson} disabled={!canExport} title="导出 JSON">
                <FileJson size={18} />
                JSON
              </button>
            </div>
          </header>

          <div className="metric-strip">
            <MetricCard label="权重模型" value={resultWeightModeLabel} icon={<Gauge size={18} />} />
            <MetricCard label="主流公司" value={displayResult.bookmakers.length} icon={<ShieldCheck size={18} />} />
            <MetricCard label="最早初盘" value={firstRecord?.time || "--"} icon={<CalendarClock size={18} />} />
            <MetricCard label="最新临盘" value={lastRecord?.time || "--"} icon={<Gauge size={18} />} />
          </div>

          <div className="tabs">
            {[
              ["bookmakers", "公司汇总"],
              ["betting", "投注分析"],
              ["log", "采集日志"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={activeTab === key ? "active" : ""}
                type="button"
                onClick={() => setActiveTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === "bookmakers" && (
            <BookmakersTable
              bookmakers={displayResult.bookmakers}
              records={displayResult.records}
              match={displayMatch}
              expanded={expandedBookmakers}
              onToggle={toggleBookmaker}
            />
          )}
          {activeTab === "betting" && <BettingAnalysisPanel analysis={bettingAnalysis} match={displayMatch} />}
          {activeTab === "log" && <pre className="log-panel">{logs.join("\n")}</pre>}
        </motion.section>
      </motion.section>
    </motion.main>
  );
}

function Field({ label, icon, children }) {
  return (
    <label className="field">
      <span>{icon}{label}</span>
      {children}
    </label>
  );
}

function MetricCard({ label, value, icon }) {
  return (
    <article className="metric-card">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AnimatedNumber({ value, digits = 0, suffix = "" }) {
  const motionValue = useMotionValue(0);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const controls = animate(motionValue, Number.isFinite(value) ? value : 0, {
      duration: 0.28,
      ease: "easeOut",
    });
    return () => controls.stop();
  }, [motionValue, value]);

  useMotionValueEvent(motionValue, "change", (latest) => {
    setDisplayValue(latest);
  });

  return `${displayValue.toFixed(digits)}${suffix}`;
}

function ProbabilityBars({ items }) {
  return (
    <div className="probability-card glass-card">
      <div className="probability-card__head">
        <span>胜平负概率</span>
        <strong>Implied Probability</strong>
      </div>
      <div className="probability-bars">
        {items.map((item) => {
          const hasValue = Number.isFinite(item.value);
          return (
            <div className={`probability-row probability-row--${item.key}${hasValue ? "" : " probability-row--empty"}`} key={item.key}>
              <span>{item.label}</span>
              <div className="probability-track">
                <motion.i
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: hasValue ? item.value / 100 : 0 }}
                  transition={{ duration: 0.26, ease: "easeOut" }}
                />
              </div>
              <strong>{hasValue ? <AnimatedNumber value={item.value} digits={1} suffix="%" /> : "--"}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarketMiniCard({ label, value, meta, tone, series }) {
  const latest = lastFinite(series);
  const hasSeries = (series || []).some((item) => Number.isFinite(item));
  return (
    <motion.article className={`market-card market-card--${tone}${hasSeries ? "" : " market-card--empty"} interactive-glow`} whileHover={cardHover}>
      <div className="market-card__copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{meta}</p>
      </div>
      <Sparkline values={series} />
      <div className="chart-tooltip">
        Latest: {Number.isFinite(latest) ? formatNumber(latest, 3) : "--"}
      </div>
    </motion.article>
  );
}

function HeroStatCard({ label, value, meta, tone }) {
  const hasValue = Number.isFinite(value);
  return (
    <motion.article className={`hero-stat-card hero-stat-card--${tone} interactive-glow`} whileHover={cardHover}>
      <span>{label}</span>
      <strong className={hasValue ? "" : "is-placeholder"}>{hasValue ? <AnimatedNumber value={value} digits={0} /> : "--"}</strong>
      <p>{meta}</p>
      <i aria-hidden="true" />
    </motion.article>
  );
}

function BettingAnalysisPanel({ analysis }) {
  const hasData = hasBettingAnalysisData(analysis);
  if (!hasData) {
    return <EmptyState text="暂无投注分析数据。采集完成后会尝试读取 500 数据分析页中的必发交易内容。" />;
  }

  return (
    <div className="betting-panel">
      <div className="betting-section-title">
        <strong>必发交易</strong>
        <p>{buildBettingInsight(analysis.volume, "成交量")}</p>
      </div>
      <div className="betting-grid betting-grid--pair">
        <BettingDonutCard
          title="必发交易"
          subtitle="成交量"
          amounts={analysis.volume}
          centerLabel="总交易"
        />
        <BettingTrendCard trend={analysis.trend} />
      </div>
      <div className="betting-section-title">
        <strong>必发大额交易</strong>
        <p>{buildLargeBettingInsight(analysis.largeVolume, analysis.largeDistribution)}</p>
      </div>
      <div className="betting-grid betting-grid--pair">
        <BettingDonutCard
          title="必发大额交易"
          subtitle="大额交易量"
          amounts={analysis.largeVolume}
          centerLabel="大额交易"
        />
        <LargeDistributionCard distribution={analysis.largeDistribution} />
      </div>
      <LargeTradeTable details={analysis.largeDetails} summary={analysis.summaryText} />
    </div>
  );
}

function BettingDonutCard({ title, subtitle, amounts, centerLabel }) {
  const total = sumOutcomeAmounts(amounts);
  const segments = buildDonutSegments(amounts);
  const leader = getOutcomeAmountEntries(amounts)[0];
  const leaderPercent = leader?.value ? leader.value / Math.max(total, 1) * 100 : null;
  return (
    <article className="betting-card">
      <header>
        <span>{title}</span>
        <strong>{subtitle}</strong>
      </header>
      <div className="betting-donut-layout">
        <div className="betting-orb">
          <BettingRingSvg segments={segments.items} />
          <div className="betting-orb__center">
            <strong>{formatMoney(total)}</strong>
            <span>{centerLabel}</span>
          </div>
          <OutcomeShareStrip amounts={amounts} total={total} />
        </div>
        <div className="betting-copy">
          <p>
            <span>主导方向</span>
            <strong>{leader?.value ? `${outcomeLabel(leader.key)} ${formatPercent(leaderPercent)}` : "等待交易结构"}</strong>
          </p>
          <OutcomeLegend amounts={amounts} />
        </div>
      </div>
    </article>
  );
}

function BettingRingSvg({ segments }) {
  return (
    <svg className="betting-ring-svg" viewBox="0 0 240 240" aria-hidden="true">
      <defs>
        <filter id="bettingRingGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle className="betting-ring-svg__rail" cx="120" cy="120" r="86" />
      <circle className="betting-ring-svg__inner" cx="120" cy="120" r="68" />
      {segments.map((segment) => (
        <circle
          className={`betting-ring-svg__arc betting-ring-svg__arc--${segment.key}`}
          cx="120"
          cy="120"
          r="86"
          key={segment.key}
          strokeDasharray={`${segment.length} ${segment.gap}`}
          strokeDashoffset={segment.offset}
        />
      ))}
    </svg>
  );
}

function OutcomeShareStrip({ amounts, total }) {
  return (
    <div className="outcome-share-strip">
      {[
        ["home", "主"],
        ["draw", "平"],
        ["away", "客"],
      ].map(([key, label]) => {
        const value = Number.isFinite(amounts?.[key]) ? amounts[key] : 0;
        const ratio = total > 0 ? value / total * 100 : 0;
        return (
          <span className={key} key={key} style={{ "--share": `${ratio}%` }}>
            <em>{label}</em>
          </span>
        );
      })}
    </div>
  );
}

function BettingTrendCard({ trend }) {
  return (
    <article className="betting-card betting-card--wide">
      <header>
        <span>成交走势</span>
        <strong>胜平负资金曲线</strong>
      </header>
      <BettingLineChart rows={trend} />
    </article>
  );
}

function BettingLineChart({ rows }) {
  const valid = rows.filter((row) => ["home", "draw", "away"].some((key) => Number.isFinite(row[key])));
  if (valid.length < 2) return <div className="chart-empty">暂无走势数据</div>;
  const max = Math.max(...valid.flatMap((row) => [row.home, row.draw, row.away].filter(Number.isFinite)), 1);
  const series = [
    ["home", "主胜", "#ff4f6e"],
    ["draw", "平局", "#39f2ad"],
    ["away", "客胜", "#5a5cff"],
  ];
  return (
    <div className="betting-chart">
      <svg viewBox="0 0 560 250" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          {series.map(([key, , color]) => (
            <linearGradient id={`bettingFill-${key}`} x1="0" x2="0" y1="0" y2="1" key={key}>
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <line key={ratio} x1="34" x2="526" y1={220 - ratio * 190} y2={220 - ratio * 190} />
        ))}
        {series.map(([key, , color]) => (
          <React.Fragment key={key}>
            <path className="betting-chart-fill" d={buildAreaPath(valid, key, max)} style={{ fill: `url(#bettingFill-${key})` }} />
            <path d={buildLinePath(valid, key, max)} style={{ stroke: color }} />
            <circle {...buildLastPoint(valid, key, max)} style={{ fill: color }} />
          </React.Fragment>
        ))}
      </svg>
      <div className="chart-legend">
        {series.map(([key, label]) => <span className={key} key={key}>{label}</span>)}
      </div>
      <div className="chart-axis">
        <span>{valid[0]?.time || "--"}</span>
        <span>{valid.at(-1)?.time || "--"}</span>
      </div>
    </div>
  );
}

function LargeDistributionCard({ distribution }) {
  const rows = [
    ["home", "主胜", distribution.home],
    ["draw", "平局", distribution.draw],
    ["away", "客胜", distribution.away],
  ];
  const max = Math.max(...rows.flatMap(([, , item]) => [item?.buy, item?.sell].filter(Number.isFinite)), 1);
  return (
    <article className="betting-card betting-card--wide">
      <header>
        <span>大额成交分布</span>
        <strong>买入 / 卖出</strong>
      </header>
      <div className="distribution-chart">
        {rows.map(([key, label, item]) => (
          <div className="distribution-group" key={key}>
            <div className="distribution-bars">
              <i className="buy" style={{ "--bar-height": `${barPercent(item?.buy, max)}%` }} />
              <i className="sell" style={{ "--bar-height": `${barPercent(item?.sell, max)}%` }} />
            </div>
            <span>{label}</span>
            <small>{formatSignedMoney((item?.buy || 0) - (item?.sell || 0))}</small>
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span className="buy">买入</span>
        <span className="sell">卖出</span>
      </div>
    </article>
  );
}

function OutcomeLegend({ amounts }) {
  return (
    <div className="outcome-legend">
      {[
        ["home", "主胜"],
        ["draw", "平局"],
        ["away", "客胜"],
      ].map(([key, label]) => (
        <div key={key} className={key}>
          <i />
          <span>{label}</span>
          <strong>{formatMoney(amounts?.[key])}</strong>
        </div>
      ))}
    </div>
  );
}

function LargeTradeTable({ details, summary }) {
  return (
    <div className="large-trade-shell">
      <header>
        <strong>大额交易明细</strong>
        {summary && <p>{summary}</p>}
      </header>
      {details.length ? (
        <table className="large-trade-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>方向</th>
              <th>投注项</th>
              <th>金额</th>
              <th>赔率</th>
              <th>比例</th>
            </tr>
          </thead>
          <tbody>
            {details.map((item, index) => (
              <tr key={`${item.time}-${item.amount}-${index}`}>
                <td>{item.time || "--"}</td>
                <td className={tradeSideClass(item.side)}>{item.side || "--"}</td>
                <td>{outcomeLabel(item.outcome)}</td>
                <td>{formatMoney(item.amount)}</td>
                <td>{formatNumber(item.price, 2)}</td>
                <td>{Number.isFinite(item.ratio) ? formatPercent(item.ratio) : "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-empty">暂无大额交易明细</div>
      )}
    </div>
  );
}

function Sparkline({ values }) {
  const path = buildSparkPath(values);
  if (!path) return <div className="sparkline sparkline--empty" aria-hidden="true" />;

  return (
    <svg className="sparkline" viewBox="0 0 180 58" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sparkGradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#24e8ff" />
          <stop offset="52%" stopColor="#8c5cff" />
          <stop offset="100%" stopColor="#27f59a" />
        </linearGradient>
      </defs>
      <path className="sparkline-fill" d={`${path} L 180 58 L 0 58 Z`} />
      <motion.path
        className="sparkline-line"
        d={path}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
      />
    </svg>
  );
}

function withResultMeta(result, match) {
  return {
    ...result,
    match,
    weightMode: match?.weightMode || "hot",
  };
}

function getWeightModeLabel(weightMode) {
  return WEIGHT_MODE_OPTIONS.find((option) => option.key === weightMode)?.label || "Normal";
}

function BookmakersTable({ bookmakers, records, match, expanded, onToggle }) {
  if (!bookmakers.length) return <EmptyState text="暂无公司汇总。" />;
  const recordsByBookmaker = groupRecordsByBookmaker(records);

  return (
    <div className="table-shell">
      <table className="bookmaker-table">
        <thead>
          <tr>
            <th>明细</th>
            <th>ID</th>
            <th>公司</th>
            <th>初始胜平负</th>
            <th>即时胜平负</th>
            <th>初始返还率</th>
            <th>即时返还率</th>
            <th>初始凯利</th>
            <th>即时凯利</th>
            <th>累计最低</th>
            <th>累计最高</th>
            <th>记录数</th>
          </tr>
        </thead>
        <tbody>
          {bookmakers.map((item) => {
            const key = item.cid || item.bookmaker;
            const isOpen = expanded.has(key);
            const detailRecords = recordsByBookmaker.get(key) || [];
            return (
              <React.Fragment key={key}>
                <tr>
                  <td>
                    <button
                      className="expand-btn"
                      type="button"
                      onClick={() => onToggle(key)}
                      title={isOpen ? "收起明细" : "展开明细"}
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                  </td>
                  <td>{item.cid || "--"}</td>
                  <td>{item.bookmaker}<span className="main-badge">主流</span></td>
                  <td>{formatOddsTriple(item.first)}</td>
                  <td><OddsTriple current={item.last} initial={item.first} /></td>
                  <td>{formatPercent(item.first.returnRate)}</td>
                  <td>{formatPercent(item.last.returnRate)}</td>
                  <td>{formatKellyTriple(item.first)}</td>
                  <td>{formatKellyTriple(item.last)}</td>
                  <td><KellyScoreDirection score={item.kellyReturnScore} mode="min" /></td>
                  <td><KellyScoreDirection score={item.kellyReturnScore} mode="max" /></td>
                  <td>{item.count}</td>
                </tr>
                {isOpen && (
                  <tr className="detail-row">
                    <td colSpan={12}>
                      <CompanyTimeline records={detailRecords} match={match} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KellyScoreDirection({ score, mode }) {
  const entries = getScoreEntries(score);
  if (!entries.length) return <span>--</span>;
  const entry = mode === "max" ? entries.at(-1) : entries[0];
  const className = mode === "max" ? "score-pill score-pill--high" : "score-pill score-pill--low";
  return (
    <span className="score-direction">
      <span className={className}>
        <strong>{entry.label}</strong>
      </span>
    </span>
  );
}

function CompanyTimeline({ records, match }) {
  if (!records.length) return <div className="timeline-empty">暂无明细记录</div>;
  const weightedRows = buildWeightedOddsTimeline(records, match);
  const rows = weightedRows
    .map((record, chronologicalIndex) => ({ record, previous: weightedRows[chronologicalIndex - 1] }))
    .reverse();
  return (
    <div className="timeline-panel">
      <table className="timeline-table">
        <thead>
          <tr>
            <th className="timeline-group-start timeline-band-time">时间</th>
            <th className="timeline-group-start timeline-band-market">胜</th>
            <th className="timeline-band-market">平</th>
            <th className="timeline-band-market">负</th>
            <th className="timeline-band-market">返还率</th>
            <th className="timeline-group-start timeline-band-kelly">凯利胜</th>
            <th className="timeline-band-kelly">凯利平</th>
            <th className="timeline-band-kelly">凯利负</th>
            <th className="timeline-group-start timeline-band-score">胜值</th>
            <th className="timeline-band-score">平值</th>
            <th className="timeline-band-score">负值</th>
            <th className="timeline-group-start timeline-band-meta">停留</th>
            <th className="timeline-band-meta">系数</th>
            <th className="timeline-band-meta">有效权重</th>
            <th className="timeline-band-meta">类型</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ record, previous }, index) => {
            const label = index === 0 ? "临盘" : index === rows.length - 1 ? "初盘" : "";
            const returnDiffs = buildReturnDiffs(record);
            const lowestDiffKey = findExtremeKey(returnDiffs, "min");
            return (
              <tr key={`${record.time || index}-${record.type}`}>
                <td className="timeline-group-start timeline-band-time">
                  <span className="timeline-time">{record.time || "--"}</span>
                  <span className="timeline-distance">{formatKickoffDistance(record, match)}</span>
                </td>
                <td className="timeline-group-start timeline-band-market">
                  <span className={oddsClass(record.homeOdds, previous?.homeOdds)}>{formatNumber(record.homeOdds)}</span>
                </td>
                <td className="timeline-band-market">
                  <span className={oddsClass(record.drawOdds, previous?.drawOdds)}>{formatNumber(record.drawOdds)}</span>
                </td>
                <td className="timeline-band-market">
                  <span className={oddsClass(record.awayOdds, previous?.awayOdds)}>{formatNumber(record.awayOdds)}</span>
                </td>
                <td className="timeline-band-market">{formatPercent(record.returnRate)}</td>
                <td className="timeline-group-start timeline-band-kelly">{formatKellyCell(record.kellyHome)}</td>
                <td className="timeline-band-kelly">{formatKellyCell(record.kellyDraw)}</td>
                <td className="timeline-band-kelly">{formatKellyCell(record.kellyAway)}</td>
                <td className="timeline-group-start timeline-band-score">{formatKellyReturnDiff(returnDiffs.find(([key]) => key === "home")?.[1], lowestDiffKey === "home")}</td>
                <td className="timeline-band-score">{formatKellyReturnDiff(returnDiffs.find(([key]) => key === "draw")?.[1], lowestDiffKey === "draw")}</td>
                <td className="timeline-band-score">{formatKellyReturnDiff(returnDiffs.find(([key]) => key === "away")?.[1], lowestDiffKey === "away")}</td>
                <td className="timeline-group-start timeline-band-meta">{formatMinutes(record.holdMinutes)}</td>
                <td className="timeline-band-meta">{Number.isFinite(record.weightCoefficient) && record.weightCoefficient > 0 ? formatNumber(record.weightCoefficient, 2) : "--"}</td>
                <td className="timeline-band-meta">{formatMinutes(record.weightMinutes)}</td>
                <td className="timeline-band-meta">{label && <span className="tag tag-soft">{label}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OddsTriple({ current, initial }) {
  const pairs = [
    ["胜", current.homeOdds, initial.homeOdds],
    ["平", current.drawOdds, initial.drawOdds],
    ["负", current.awayOdds, initial.awayOdds],
  ];
  return (
    <span className="odds-triple">
      {pairs.map(([label, value, base]) => (
        <span key={label}>
          {label} <span className={oddsClass(value, base)}>{formatNumber(value)}</span>
        </span>
      ))}
    </span>
  );
}

function oddsClass(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base)) return "";
  if (value > base) return "odds-up";
  if (value < base) return "odds-down";
  return "";
}

function formatKickoffDistance(record, match) {
  const kickoffMs = match?.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime())
    ? match.kickoffTime.getTime()
    : null;
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(record?.timeMs)) return "--";
  const diffMinutes = Math.floor((kickoffMs - record.timeMs) / 60000);
  const absMinutes = Math.abs(diffMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return diffMinutes >= 0
    ? `距开赛 ${hours}小时${minutes}分钟`
    : `已开赛 ${hours}小时${minutes}分钟`;
}

function formatKellyTriple(record) {
  return [record.kellyHome, record.kellyDraw, record.kellyAway].map((value) => formatNumber(value, 3)).join(" / ");
}

function formatKellyCell(value) {
  if (!Number.isFinite(value)) return "--";
  const className = value > 1 ? "kelly-alert" : value < 0.8 ? "kelly-low" : "";
  return <span className={className}>{formatNumber(value, 3)}</span>;
}

function formatKellyReturnDiff(value, isLowest) {
  if (!Number.isFinite(value)) return "--";
  return <span className={isLowest ? "score-low" : "score-neutral"}>{formatNumber(value)}</span>;
}

function formatMinutes(value) {
  if (!Number.isFinite(value) || value <= 0) return "--";
  return `${formatNumber(value)} 分钟`;
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function calculateKellyReturnValue(returnRate, kelly) {
  const raw = returnRate - kelly * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.abs(raw);
}

function getScoreEntries(score) {
  return [
    { key: "home", label: "胜", value: score?.home },
    { key: "draw", label: "平", value: score?.draw },
    { key: "away", label: "负", value: score?.away },
  ]
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value);
}

function buildReturnDiffs(record) {
  return [
    ["home", calculateWeightedReturnDiff(record.returnRate, record.kellyHome, record.weightMinutes)],
    ["draw", calculateWeightedReturnDiff(record.returnRate, record.kellyDraw, record.weightMinutes)],
    ["away", calculateWeightedReturnDiff(record.returnRate, record.kellyAway, record.weightMinutes)],
  ];
}

function calculateWeightedReturnDiff(returnRate, kelly, weightMinutes) {
  if (!Number.isFinite(returnRate) || !Number.isFinite(kelly)) return null;
  if (!Number.isFinite(weightMinutes) || weightMinutes <= 0) return null;
  return calculateKellyReturnValue(returnRate, kelly) * weightMinutes;
}

function findExtremeKey(entries, mode) {
  const valid = entries.filter(([, value]) => Number.isFinite(value));
  if (!valid.length) return "";
  const sorted = valid.sort((a, b) => mode === "max" ? b[1] - a[1] : a[1] - b[1]);
  return sorted[0][0];
}

function EmptyState({ text }) {
  return (
    <div className="empty-state">
      <div className="ball-mark" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

async function discoverOddsUrl(match, appendLog) {
  const scheduleUrls = buildScheduleUrls(match);
  if (!scheduleUrls.length) return "";

  for (const url of scheduleUrls) {
    try {
      const requestUrl = buildRequestUrl(url, match.proxyPrefix);
      appendLog(`尝试赛程页：${requestUrl}`);
      const response = await fetch(requestUrl, { credentials: "omit", cache: "no-store" });
      if (!response.ok) {
        appendLog(`赛程页返回 HTTP ${response.status}，继续尝试下一个。`);
        continue;
      }

      const html = await decodeResponse(response);
      const candidate = findMatchCandidate(html, match, url);
      if (candidate?.oddsUrl) {
        appendLog(`匹配到比赛欧赔页：${candidate.oddsUrl}`);
        return candidate.oddsUrl;
      }
      appendLog("该赛程页没有匹配到主客队和开赛时间。");
    } catch (error) {
      appendLog(`赛程页读取失败：${error.message}`);
    }
  }

  return "";
}

async function hydrateFinishedFixtures(fixtures, scanTime, match, appendLog) {
  const resultCandidates = fixtures.filter((fixture) => shouldHydrateFixtureResult(fixture, scanTime));
  if (!resultCandidates.length) return fixtures;
  appendLog(`开始补全已完赛结果：${resultCandidates.length} 场。`);

  const resultMap = new Map();
  const batchResults = await fetchFixtureResultsBatch(resultCandidates, match, appendLog);
  batchResults.forEach((result, key) => {
    if (result.isFinished) resultMap.set(key, result);
  });

  const remainingCandidates = resultCandidates.filter((fixture) => !resultMap.has(fixture.key));
  const tasks = remainingCandidates.map((fixture) => async () => {
    const result = await fetchFixtureResult(fixture, match);
    if (result.isFinished) resultMap.set(fixture.key, result);
    return result;
  });
  await runLimited(tasks, SCHEDULE_RESULT_CONCURRENCY);

  if (resultMap.size) appendLog(`已补全赛果：${resultMap.size}/${resultCandidates.length} 场。`);
  return fixtures.map((fixture) => resultMap.has(fixture.key) ? { ...fixture, ...resultMap.get(fixture.key) } : fixture);
}

function shouldHydrateFixtureResult(fixture, scanTime) {
  if (fixture?.isFinished || fixture?.resultText) return false;
  const kickoffMs = fixture?.kickoffTime?.getTime();
  if (!Number.isFinite(kickoffMs)) return false;
  return fixture?.isFinishedCandidate || kickoffMs + 135 * 60 * 1000 < scanTime.getTime();
}

async function fetchFixtureResult(fixture, match) {
  const resultUrls = buildFixtureResultUrls(fixture);
  for (const url of resultUrls) {
    try {
      const requestUrl = buildRequestUrl(url, match.proxyPrefix);
      const response = await fetchWithRetry(requestUrl, 2);
      if (!response.ok) continue;
      const html = await decodeResponse(response);
      const result = parseMatchResult(html, fixture, url);
      if (result.isFinished) return result;
    } catch (error) {
      // Some completed matches do not expose a detail page yet; leave the row as-is.
    }
  }
  return { resultText: "", homeScore: null, awayScore: null, isFinished: false };
}

async function fetchFixtureResultsBatch(fixtures, match, appendLog) {
  if (match.proxyPrefix) return new Map();

  const requests = fixtures.flatMap((fixture) => buildFixtureResultUrls(fixture).map((url, index) => ({
    id: `${fixture.key}::${index}`,
    url,
  })));
  if (!requests.length) return new Map();

  try {
    const payload = await fetchProxyBatch(requests, { attempts: 2, concurrency: 2 });
    const resultMap = new Map();

    for (const item of payload.items || []) {
      if (!item?.ok || !item.bodyBase64) continue;
      const [fixtureKey] = String(item.id || "").split("::");
      if (!fixtureKey || resultMap.has(fixtureKey)) continue;
      const fixture = fixtures.find((candidate) => candidate.key === fixtureKey);
      if (!fixture) continue;
      const html = decodeBase64Text(item.bodyBase64, item.contentType);
      const result = parseMatchResult(html, fixture, item.url);
      if (result.isFinished) resultMap.set(fixtureKey, result);
    }

    if (resultMap.size) appendLog(`批量补全赛果：${resultMap.size}/${fixtures.length} 场。`);
    return resultMap;
  } catch (error) {
    appendLog(`批量补全赛果失败，改用逐场补全：${error.message}`);
    return new Map();
  }
}

function buildFixtureResultUrls(fixture) {
  const id = fixture.fixtureId
    || fixture.oddsUrl?.match(/(\d{5,})/)?.[1]
    || fixture.matchInput?.match(/(\d{5,})/)?.[1];
  if (!id) return [];
  return [
    `https://odds.500.com/fenxi/shuju-${id}.shtml`,
    `https://odds.500.com/fenxi/ouzhi-${id}.shtml`,
  ];
}

function pickMainCompanies(companies) {
  const mainCompanies = companies.filter((company) => company.isMain);
  if (mainCompanies.length >= MAIN_COMPANY_MIN_COUNT) return mainCompanies;
  return mainCompanies.length ? mainCompanies : companies.slice(0, MAIN_COMPANY_MIN_COUNT);
}

async function loadAllBookmakers(config, initialCompanies, match, appendLog) {
  if (initialCompanies.filter((company) => company.isMain).length >= MAIN_COMPANY_MIN_COUNT) return initialCompanies;
  if (!config.total || initialCompanies.length >= config.total) return initialCompanies;

  let merged = initialCompanies;
  let start = config.start || initialCompanies.length;
  const maxLoops = 8;

  for (let index = 0; index < maxLoops && merged.length < config.total; index += 1) {
    const url = buildMoreBookmakersUrl(config, start);
    if (!url) break;

    try {
      const requestUrl = buildRequestUrl(url, match.proxyPrefix);
      appendLog(`补充公司列表：start=${start}`);
      const response = await fetch(requestUrl, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await decodeResponse(response);
      const more = parseBookmakerRows(html, match);
      if (!more.length) break;
      merged = mergeBookmakerLists(merged, more);
      appendLog(`公司列表已补到 ${merged.length}/${config.total} 家。`);
      start += config.limit || more.length;
    } catch (error) {
      appendLog(`补充公司列表失败：${error.message}`);
      break;
    }
  }

  return merged;
}

async function loadHistoryRecords(config, companies, match, appendLog) {
  if (!match.proxyPrefix) {
    const batchRecords = await loadHistoryRecordsBatch(config, companies, match, appendLog);
    if (batchRecords.length) return batchRecords;
  }

  let completed = 0;
  const tasks = companies.map((company) => async () => {
    const records = await loadCompanyHistory(config, company, match, appendLog);
    completed += 1;
    if (completed % 10 === 0 || completed === companies.length) {
      appendLog(`历史接口进度：${completed}/${companies.length} 家。`);
    }
    return records;
  });
  const chunks = await runLimited(tasks, HISTORY_CONCURRENCY);
  return chunks.flat();
}

async function loadHistoryRecordsBatch(config, companies, match, appendLog) {
  const requests = companies.flatMap((company) => ["europe", "kelly"].map((type) => ({
    id: `${company.cid}::${type}`,
    url: buildOddsHistoryUrl(config, company, type),
  }))).filter((request) => request.url);

  if (!requests.length) return [];

  try {
    appendLog(`线上批量拉取历史接口：${requests.length} 个请求。`);
    const payload = await fetchProxyBatch(requests, { attempts: 3, concurrency: 2 });
    const companyMap = new Map(companies.map((company) => [String(company.cid), company]));
    const records = [];
    const fetchedCompanyKeys = new Set();
    const failedCompanyKeys = new Set();

    for (const item of payload.items || []) {
      const [cid, type] = String(item.id || "").split("::");
      const company = companyMap.get(cid);
      if (!company || !type) continue;
      if (!item.ok || !item.bodyBase64) {
        failedCompanyKeys.add(cid);
        continue;
      }

      try {
        const payloadText = decodeBase64Text(item.bodyBase64, item.contentType);
        const parsed = parseOddsHistoryPayload(payloadText, company, type, match);
        records.push(...parsed);
        if (parsed.length) fetchedCompanyKeys.add(cid);
      } catch {
        failedCompanyKeys.add(cid);
      }
    }

    appendLog(`批量历史完成：${fetchedCompanyKeys.size}/${companies.length} 家成功，${failedCompanyKeys.size} 家需要兜底。`);
    if (fetchedCompanyKeys.size === 0) return [];

    companies.forEach((company) => {
      if (!fetchedCompanyKeys.has(String(company.cid))) {
        records.push(...companySummaryRecords(company));
      }
    });

    return records;
  } catch (error) {
    appendLog(`批量历史接口失败，改用逐家公司拉取：${error.message}`);
    return [];
  }
}

async function loadCompanyHistory(config, company, match, appendLog) {
  const euroResult = await settle(fetchHistoryType(config, company, "europe", match));
  await wait(140);
  const kellyResult = await settle(fetchHistoryType(config, company, "kelly", match));

  const records = [
    ...(euroResult.status === "fulfilled" ? euroResult.value : []),
    ...(kellyResult.status === "fulfilled" ? kellyResult.value : []),
  ];

  if (!records.length) {
    appendLog(`${company.bookmaker}(${company.cid}) 历史为空或读取失败。`);
    return companySummaryRecords(company);
  }
  return records;
}

function companySummaryRecords(company) {
  const records = [];
  if (company.opening) {
    records.push({
      cid: company.cid,
      bookmaker: company.bookmaker,
      time: null,
      cutoff: true,
      homeOdds: company.opening.homeOdds,
      drawOdds: company.opening.drawOdds,
      awayOdds: company.opening.awayOdds,
      returnRate: company.opening.returnRate,
      kellyHome: company.opening.kellyHome,
      kellyDraw: company.opening.kellyDraw,
      kellyAway: company.opening.kellyAway,
      type: "开盘兜底",
    });
  }

  if (company.latest) {
    records.push({
      cid: company.cid,
      bookmaker: company.bookmaker,
      time: company.dataTime || null,
      cutoff: true,
      homeOdds: company.latest.homeOdds,
      drawOdds: company.latest.drawOdds,
      awayOdds: company.latest.awayOdds,
      returnRate: company.latest.returnRate,
      kellyHome: company.latest.kellyHome,
      kellyDraw: company.latest.kellyDraw,
      kellyAway: company.latest.kellyAway,
      type: "即时兜底",
    });
  }

  return records;
}

async function fetchHistoryType(config, company, type, match) {
  const url = buildOddsHistoryUrl(config, company, type);
  if (!url) return [];
  const requestUrl = buildRequestUrl(url, match.proxyPrefix);
  const response = await fetchWithRetry(requestUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await decodeResponse(response);
  return parseOddsHistoryPayload(payload, company, type, match);
}

async function fetchWithRetry(url, attempts = 4) {
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { credentials: "omit", cache: "no-store" });
      if (!RETRYABLE_STATUS.has(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      await wait(450 * 2 ** attempt + Math.floor(Math.random() * 220));
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error("请求失败");
}

async function fetchProxyBatch(requests, options = {}) {
  const chunks = chunkArray(requests, PROXY_BATCH_SIZE);
  const items = [];

  for (const chunk of chunks) {
    const response = await fetch(PROXY_BATCH_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: chunk,
        attempts: options.attempts,
        concurrency: options.concurrency,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    items.push(...(payload.items || []));
  }

  return { items };
}

function decodeBase64Text(bodyBase64, contentType = "") {
  const bytes = Uint8Array.from(atob(bodyBase64), (char) => char.charCodeAt(0));
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim();
  const candidates = [charset, "gb18030", "gbk", "gb2312", "utf-8"].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch {
      // Try the next decoder.
    }
  }

  return new TextDecoder("utf-8").decode(bytes);
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (error) {
    return { status: "rejected", reason: error };
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function runLimited(tasks, limit) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function readMatch(form) {
  const kickoffTime = form.kickoffTime ? new Date(form.kickoffTime) : null;
  return {
    kickoffTime,
    homeTeam: form.homeTeam.trim(),
    awayTeam: form.awayTeam.trim(),
    matchType: form.matchType.trim(),
    matchInput: form.matchInput.trim(),
    scheduleInput: form.scheduleInput.trim(),
    proxyPrefix: form.proxyPrefix.trim(),
    weightMode: WEIGHT_MODE_OPTIONS.some((option) => option.key === form.weightMode) ? form.weightMode : "hot",
  };
}

function buildQueryLog(match) {
  if (match.matchInput) return `入口：${match.matchInput}。`;
  return `开球：${formatDisplayDate(match.kickoffTime)}，对阵：${match.homeTeam || "主队"} VS ${match.awayTeam || "客队"}。`;
}

function canDiscoverFromSchedule(match) {
  const hasTeams = !!(match.homeTeam && match.awayTeam);
  const hasKickoff = match.kickoffTime instanceof Date && !Number.isNaN(match.kickoffTime.getTime());
  return hasTeams && (!!match.scheduleInput || hasKickoff);
}

function mergeMatchInfo(match, info) {
  return {
    ...match,
    homeTeam: info.homeTeam || match.homeTeam || "",
    awayTeam: info.awayTeam || match.awayTeam || "",
    matchType: info.matchType || match.matchType || "",
    kickoffTime: isValidDate(info.kickoffTime) ? info.kickoffTime : match.kickoffTime,
  };
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function statusLabel(status) {
  if (status === "ok") return "数据就绪";
  if (status === "warn") return "需要处理";
  if (status === "error") return "解析异常";
  return "待开球";
}

function logLine(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  return `[${time}] ${message}`;
}

function filenameBase(match) {
  return `${match.homeTeam || "home"}-${match.awayTeam || "away"}-odds`.replace(/[^\u4e00-\u9fa5a-z0-9_-]+/gi, "-");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function valueOrEmpty(value) {
  return Number.isFinite(value) ? value : "";
}

function hasBettingAnalysisData(analysis) {
  return sumOutcomeAmounts(analysis?.volume) > 0
    || sumOutcomeAmounts(analysis?.largeVolume) > 0
    || (analysis?.trend || []).length > 0
    || (analysis?.largeDetails || []).length > 0;
}

function sumOutcomeAmounts(amounts) {
  return ["home", "draw", "away"].reduce((sum, key) => sum + (Number.isFinite(amounts?.[key]) ? amounts[key] : 0), 0);
}

function buildDonutSegments(amounts) {
  const values = [
    ["home", "#ff314f", amounts?.home],
    ["draw", "#34e36f", amounts?.draw],
    ["away", "#4b55ff", amounts?.away],
  ];
  const total = sumOutcomeAmounts(amounts);
  const circumference = 540.35;
  if (!total) return { gradient: "rgba(139, 213, 255, 0.22) 0 100%", items: [] };

  let cursor = 0;
  const stops = [];
  const items = values.map(([key, color, value]) => {
    const start = cursor;
    const end = cursor + (Number.isFinite(value) ? value / total * 100 : 0);
    cursor = end;
    stops.push(`${color} ${start}% ${end}%`);
    const ratio = Math.max(0, end - start) / 100;
    return {
      key,
      length: Math.max(0, ratio * circumference - 4).toFixed(2),
      gap: circumference.toFixed(2),
      offset: (circumference * (0.25 - start / 100)).toFixed(2),
    };
  }).filter((item) => Number.parseFloat(item.length) > 0);
  return { gradient: stops.join(", "), items };
}

function buildLinePath(rows, key, max) {
  return rows.map((row, index) => {
    const x = 34 + (rows.length === 1 ? 0 : index / (rows.length - 1) * 492);
    const value = Number.isFinite(row[key]) ? row[key] : 0;
    const y = 220 - value / max * 190;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function buildAreaPath(rows, key, max) {
  const line = buildLinePath(rows, key, max);
  if (!line) return "";
  return `${line} L 526 220 L 34 220 Z`;
}

function buildLastPoint(rows, key, max) {
  const index = rows.length - 1;
  const row = rows[index] || {};
  const value = Number.isFinite(row[key]) ? row[key] : 0;
  return {
    cx: 34 + (rows.length === 1 ? 0 : index / (rows.length - 1) * 492),
    cy: 220 - value / max * 190,
    r: 5,
  };
}

function barPercent(value, max) {
  if (!Number.isFinite(value) || !max) return 0;
  return Math.max(4, Math.min(100, value / max * 100));
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 10000) return `${formatNumber(value / 10000, 1)}万`;
  return Math.round(value).toLocaleString("zh-CN");
}

function formatSignedMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${formatMoney(value)}`;
}

function buildBettingInsight(amounts, label) {
  const total = sumOutcomeAmounts(amounts);
  if (!total) return `暂无${label}结构化数据。`;
  const leader = getOutcomeAmountEntries(amounts)[0];
  return `${label}合计 ${formatMoney(total)}，当前资金主要集中在${outcomeLabel(leader.key)}，占比 ${formatPercent(leader.value / total * 100)}。`;
}

function buildLargeBettingInsight(amounts, distribution) {
  const total = sumOutcomeAmounts(amounts);
  const leader = getOutcomeAmountEntries(amounts)[0];
  const pressure = getDistributionPressure(distribution);
  if (!total && !pressure) return "暂无大额交易结构化数据。";
  const volumeText = total && leader
    ? `大额交易合计 ${formatMoney(total)}，${outcomeLabel(leader.key)}占比最高`
    : "大额交易量待补充";
  const pressureText = pressure
    ? `，${outcomeLabel(pressure.key)}${pressure.net >= 0 ? "买入" : "卖出"}更活跃`
    : "";
  return `${volumeText}${pressureText}。`;
}

function getOutcomeAmountEntries(amounts) {
  return ["home", "draw", "away"]
    .map((key) => ({ key, value: Number.isFinite(amounts?.[key]) ? amounts[key] : 0 }))
    .sort((a, b) => b.value - a.value);
}

function getDistributionPressure(distribution) {
  const entries = ["home", "draw", "away"]
    .map((key) => {
      const item = distribution?.[key] || {};
      const buy = Number.isFinite(item.buy) ? item.buy : 0;
      const sell = Number.isFinite(item.sell) ? item.sell : 0;
      return { key, net: buy - sell, absolute: Math.abs(buy - sell) };
    })
    .filter((item) => item.absolute > 0)
    .sort((a, b) => b.absolute - a.absolute);
  return entries[0] || null;
}

function outcomeLabel(key) {
  if (key === "home") return "主胜";
  if (key === "draw") return "平局";
  if (key === "away") return "客胜";
  return "--";
}

function tradeSideClass(side) {
  const text = String(side || "");
  if (text.includes("买")) return "trade-side trade-side--buy";
  if (text.includes("卖")) return "trade-side trade-side--sell";
  return "trade-side";
}

function oddsClassByDelta(value) {
  if (!Number.isFinite(value)) return "is-placeholder";
  if (value > 0) return "odds-increase";
  if (value < 0) return "odds-decrease";
  return "";
}

function buildHeroMetrics(result) {
  const bookmakers = result.bookmakers || [];
  const records = result.records || [];
  const hasData = records.length > 0;
  if (!hasData) {
    return {
      hasData: false,
      probabilities: [
        { key: "home", label: "胜", value: null },
        { key: "draw", label: "平", value: null },
        { key: "away", label: "负", value: null },
      ],
      averageOddsChange: [
        { key: "home", label: "胜", value: null },
        { key: "draw", label: "平", value: null },
        { key: "away", label: "负", value: null },
      ],
      averageOddsMeta: "等待主流公司样本",
      kellyIndex: null,
      heat: null,
      oddsTrend: [],
      kellyTrend: [],
      heatTrend: [],
    };
  }

  const first = bookmakers[0]?.first;
  const last = bookmakers[0]?.last;
  const probabilityValues = impliedProbabilities(last || first);
  const averageOdds = buildAverageOddsChange(bookmakers);
  const oddsChange = first && last
    ? averageFinite([
      last.homeOdds - first.homeOdds,
      last.drawOdds - first.drawOdds,
      last.awayOdds - first.awayOdds,
    ])
    : null;
  const kellyIndex = averageFinite(bookmakers.map((bookmaker) => averageFinite([
    bookmaker.last?.kellyHome,
    bookmaker.last?.kellyDraw,
    bookmaker.last?.kellyAway,
  ])));
  const oddsChangeImpact = Number.isFinite(oddsChange) ? Math.abs(oddsChange) : 0;
  const heat = clamp(42 + records.length * 0.18 + bookmakers.length * 2.4 + oddsChangeImpact * 18, 18, 96);
  const oddsTrend = records.slice(-18).map((record) => averageFinite([record.homeOdds, record.drawOdds, record.awayOdds]));
  const kellyTrend = records.slice(-18).map((record) => averageFinite([record.kellyHome, record.kellyDraw, record.kellyAway]));

  return {
    hasData: true,
    probabilities: [
      { key: "home", label: "胜", value: probabilityValues.home },
      { key: "draw", label: "平", value: probabilityValues.draw },
      { key: "away", label: "负", value: probabilityValues.away },
    ],
    averageOddsChange: averageOdds.items,
    averageOddsMeta: `${averageOdds.count} 家主流公司样本`,
    kellyIndex: Number.isFinite(kellyIndex) ? kellyIndex : null,
    heat,
    oddsTrend,
    kellyTrend,
    heatTrend: buildSyntheticTrend(heat),
  };
}

function buildAverageOddsChange(bookmakers) {
  const entries = bookmakers
    .map((bookmaker) => ({
      home: numericDiff(bookmaker.last?.homeOdds, bookmaker.first?.homeOdds),
      draw: numericDiff(bookmaker.last?.drawOdds, bookmaker.first?.drawOdds),
      away: numericDiff(bookmaker.last?.awayOdds, bookmaker.first?.awayOdds),
    }));
  return {
    count: entries.filter((item) => ["home", "draw", "away"].some((key) => Number.isFinite(item[key]))).length,
    items: [
      { key: "home", label: "胜", value: averageFinite(entries.map((item) => item.home)) },
      { key: "draw", label: "平", value: averageFinite(entries.map((item) => item.draw)) },
      { key: "away", label: "负", value: averageFinite(entries.map((item) => item.away)) },
    ],
  };
}

function numericDiff(current, initial) {
  if (!Number.isFinite(current) || !Number.isFinite(initial)) return null;
  return current - initial;
}

function impliedProbabilities(record) {
  const values = [record?.homeOdds, record?.drawOdds, record?.awayOdds];
  if (values.every((value) => Number.isFinite(value) && value > 0)) {
    const raw = values.map((value) => 1 / value);
    const total = raw.reduce((sum, value) => sum + value, 0);
    return {
      home: total ? raw[0] / total * 100 : 33.3,
      draw: total ? raw[1] / total * 100 : 33.3,
      away: total ? raw[2] / total * 100 : 33.3,
    };
  }
  return { home: null, draw: null, away: null };
}

function buildSyntheticTrend(seed) {
  return Array.from({ length: 9 }, (_, index) => {
    const wave = Math.sin((index + 1) * 0.82) * 6;
    const drift = index * 1.15;
    return clamp(seed - 12 + wave + drift, 8, 98);
  });
}

function averageFinite(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lastFinite(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

function buildSparkPath(values) {
  const valid = (values || []).filter((value) => Number.isFinite(value));
  if (valid.length < 2) return "";
  const data = valid;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  return data.map((value, index) => {
    const x = data.length === 1 ? 0 : index / (data.length - 1) * 180;
    const y = 50 - ((value - min) / span) * 40;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function buildScheduleDays(baseDate, fixtures) {
  const todayKey = toDateKey(baseDate);
  const fixtureGroups = new Map();
  fixtures.forEach((fixture) => {
    const key = toDateKey(fixture.kickoffTime);
    if (!key) return;
    if (!fixtureGroups.has(key)) fixtureGroups.set(key, []);
    fixtureGroups.get(key).push(fixture);
  });

  const baseDay = startOfLocalDay(baseDate);
  return SCHEDULE_DAY_OFFSETS.map((offset) => {
    const date = new Date(baseDay.getTime() + offset * 24 * 60 * 60 * 1000);
    const key = toDateKey(date);
    const dayFixtures = (fixtureGroups.get(key) || [])
      .slice()
      .sort((a, b) => a.kickoffTime - b.kickoffTime);

    return {
      key,
      label: formatScheduleDayLabel(date, todayKey),
      count: dayFixtures.length,
      fixtures: dayFixtures,
      isToday: key === todayKey,
    };
  });
}

function formatScheduleDayLabel(date, todayKey) {
  const key = toDateKey(date);
  if (key === todayKey) return "今日";
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  return `${monthDay} 周${weekday}`;
}

function toDateKey(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function startOfLocalDay(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? new Date(value) : new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}


function groupRecordsByBookmaker(records) {
  const groups = new Map();
  records.forEach((record) => {
    const key = record.cid || record.bookmaker;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return groups;
}

function dedupeFixtures(fixtures) {
  const merged = new Map();
  fixtures.forEach((fixture) => {
    const key = fixture.fixtureId
      || fixture.oddsUrl?.match(/(\d{5,})/)?.[1]
      || fixture.matchInput?.match(/(\d{5,})/)?.[1]
      || `${fixture.homeTeam}-${fixture.awayTeam}-${fixture.kickoffTime?.getTime()}`;
    if (!key || merged.has(key)) return;
    merged.set(key, { ...fixture, key });
  });
  return [...merged.values()];
}
