import React, { useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import * as echarts from "echarts/core";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  RadarChart,
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Gauge,
  GitCompareArrows,
  ShieldCheck,
  Target,
  Waves,
} from "lucide-react";

echarts.use([
  BarChart,
  GridComponent,
  HeatmapChart,
  LegendComponent,
  LineChart,
  RadarChart,
  RadarComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const outcomeLabels = {
  home: "主胜",
  draw: "平局",
  away: "客胜",
};

export function QuantDashboard({ engine }) {
  if (!engine?.inputs?.recordsCount) {
    return <QuantEmptyState />;
  }

  const topScores = engine.poisson.scoreMatrix
    .flatMap((row) => row)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);
  const xgCorrectionHelp = "xG 修正由大小球水位修正和亚盘强弱修正组成：前者根据大小球水位偏向调整总进球，后者根据让球盘口与水位调整主客进球分配。";

  return (
    <div className="quant-dashboard">
      <motion.section className="quant-hero" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="quant-score-panel">
          <span>AI 综合评分</span>
          <strong>{engine.ai.score}</strong>
          <p>{engine.ai.rating}</p>
        </div>
        <div className="quant-hero-copy">
          <p className="eyebrow"><BrainCircuit size={15} /> Football Quant Engine</p>
          <h3>{engine.ai.explanation.headline}</h3>
          <p>{engine.ai.explanation.conclusion}</p>
          <div className="quant-flags">
            {engine.ai.explanation.flags.map((flag) => <span key={flag}>{flag}</span>)}
          </div>
        </div>
        <div className="quant-prob-stack">
          {["home", "draw", "away"].map((key) => (
            <ProbabilityChip
              key={key}
              label={outcomeLabels[key]}
              value={engine.probability.fused[key]}
              accent={key}
            />
          ))}
        </div>
      </motion.section>

      <section className="quant-metrics">
        <QuantMetric icon={<ShieldCheck size={18} />} label="公司一致性" value={formatNumber(engine.indexes.consensus, 0)} suffix="/100" meta={engine.probability.consensus.level} />
        <QuantMetric icon={<Activity size={18} />} label="波动指数" value={formatNumber(engine.indexes.volatility, 0)} suffix="/100" meta={engine.odds.volatility.level} />
        <QuantMetric
          icon={<GitCompareArrows size={18} />}
          label="盘口偏差"
          value={formatBias(engine.handicap.bias)}
          meta={`${engine.handicap.biasLabel} · ${formatHandicap(engine.handicap.euroMappedLine)} → ${formatHandicap(engine.handicap.referenceLine)}`}
        />
        <QuantMetric icon={<Target size={18} />} label="赢盘覆盖率" value={formatPercent(engine.handicap.cover.cover)} meta={`Push ${formatPercent(engine.handicap.cover.push)}`} />
        <QuantMetric icon={<Gauge size={18} />} label="数据质量" value={engine.inputs.dataQuality} suffix="/100" meta={`${engine.inputs.bookmakerCount}家公司`} />
      </section>

      <section className="quant-pattern-grid">
        <PatternCard title="市场路径" subtitle="Path Signal" items={engine.pattern.marketPath.flags} meta={formatWindowSignal(engine.pattern.marketPath.europe.find((item) => item.hours === 3))} />
        <PatternCard title="公司组分歧" subtitle="Bookmaker Groups" items={engine.pattern.bookmakerGroups.flags} meta={`Sharp ${formatNumber(engine.pattern.bookmakerGroups.sharpDistance, 3)}`} />
        <PatternCard title="不确定性" subtitle="Uncertainty" items={engine.pattern.uncertainty.flags} meta={`${engine.pattern.uncertainty.level} · ${formatNumber(engine.pattern.uncertainty.score, 0)}/100`} />
      </section>

      <section className="quant-grid quant-grid--charts">
        <QuantChart title="欧赔变化折线" subtitle="主流公司时间加权均值">
          <EChart option={buildOddsLineOption(engine.odds.timeline)} />
        </QuantChart>
        <QuantChart title="亚盘变化时间轴" subtitle={engine.markets.asian.source}>
          <EChart option={buildMarketLineOption(engine.markets.asian.timeline, "让球")} />
        </QuantChart>
        <QuantChart title="大小球走势" subtitle={engine.markets.totals.source}>
          <EChart option={buildMarketLineOption(engine.markets.totals.timeline, "大小球")} />
        </QuantChart>
      </section>

      <section className="quant-grid quant-grid--analysis">
        <QuantChart title="泊松比分热力图" subtitle={`xG ${formatNumber(engine.poisson.expectedGoals.home, 2)} : ${formatNumber(engine.poisson.expectedGoals.away, 2)}`}>
          <EChart option={buildScoreHeatmapOption(engine.poisson.scoreMatrix)} />
        </QuantChart>
        <QuantChart title="净胜球概率矩阵" subtitle="Goal Distribution Index">
          <EChart option={buildGoalDiffOption(engine.poisson.goalDiffDistribution)} />
        </QuantChart>
        <QuantChart title="AI 风险雷达图" subtitle="越外圈风险越高">
          <EChart option={buildRiskRadarOption(engine.ai.radar)} />
        </QuantChart>
      </section>

      <section className="quant-grid quant-grid--analysis">
        <ProtectionGaugeCard indexes={engine.indexes} />
        <QuantChart title="公司一致性矩阵" subtitle={`${engine.probability.companies.length} 家公司概率距离`}>
          <EChart option={buildConsensusHeatmapOption(engine.probability.consensus.matrix)} />
        </QuantChart>
        <div className="quant-explain-card">
          <header>
            <BrainCircuit size={20} />
            <div>
              <span>AI Explain Engine</span>
              <strong>自然语言解析</strong>
            </div>
          </header>
          <div className="quant-explain-list">
            {engine.ai.explanation.bullets.map((item) => <p key={item}>{item}</p>)}
          </div>
          <div className="quant-top-scores">
            {topScores.map((item) => (
              <span key={item.score}>
                <strong>{item.score}</strong>
                {formatPercent(item.probability)}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="quant-debug">
        <header>
          <Waves size={18} />
          <strong>计算链路中间结果</strong>
        </header>
        <div className="quant-debug-grid">
          <DebugItem label="欧赔理论盘口" value={formatHandicap(engine.handicap.euroMappedLine)} />
          <DebugItem label="公平盘口" value={formatHandicap(engine.handicap.fairLine?.line ?? engine.handicap.theoreticalLine)} />
          <DebugItem label={engine.handicap.hasActualLine ? "实际盘口" : "参考盘口"} value={formatHandicap(engine.handicap.referenceLine)} />
          <DebugItem label="亚盘价值" value={engine.handicap.marketValue?.label} />
          <DebugItem label="大小球价值" value={engine.poisson.totalGoalLine.marketValue?.label} />
          <DebugItem
            label="xG 修正"
            value={`${formatSignedNumber(engine.poisson.expectedGoals.totalWaterAdjustment, 2)} / ${formatSignedNumber(engine.poisson.expectedGoals.asianDominanceAdjustment, 2)}`}
            help={xgCorrectionHelp}
          />
        </div>
      </section>
    </div>
  );
}

function QuantEmptyState() {
  return (
    <div className="quant-empty">
      <AlertTriangle size={24} />
      <strong>等待量化样本</strong>
      <p>完成欧赔采集后，系统会自动生成概率融合、泊松矩阵、盘口保护指数与 AI 解析。</p>
    </div>
  );
}

function ProbabilityChip({ label, value, accent }) {
  return (
    <div className={`quant-prob-chip quant-prob-chip--${accent}`}>
      <span>{label}</span>
      <strong>{formatPercent(value)}</strong>
      <i style={{ "--probability": `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

function QuantMetric({ icon, label, value, suffix = "", meta }) {
  return (
    <article className="quant-metric">
      <span>{icon}{label}</span>
      <strong>{value ?? "--"}{suffix}</strong>
      <p>{meta || "--"}</p>
    </article>
  );
}

function QuantChart({ title, subtitle, children }) {
  return (
    <article className="quant-chart-card">
      <header>
        <div>
          <span>{subtitle}</span>
          <strong>{title}</strong>
        </div>
      </header>
      {children}
    </article>
  );
}

const protectionGaugeItems = [
  {
    key: "drawProtection",
    label: "DPI",
    title: "平局保护",
    color: "#39f2ad",
    help: "DPI 衡量平局或一球差结果的保护强度。由泊松比分矩阵中一球以内比分差概率和当前盘口压力共同计算，数值越高代表平局保护越强。",
  },
  {
    key: "marginProtection",
    label: "MPI",
    title: "穿盘幅度",
    color: "#ffd36a",
    help: "MPI 衡量盘口下打穿所需净胜幅度的压力。盘口越深、足够净胜概率越低或一球差概率越高，穿盘压力越明显。",
  },
  {
    key: "goalDistribution",
    label: "GDI",
    title: "进球差集中",
    color: "#2ee8ff",
    help: "GDI 衡量净胜球差分布是否集中在平局和一球差附近。数值越高，代表比赛更容易落在小比分差区间。",
  },
];

function ProtectionGaugeCard({ indexes }) {
  return (
    <article className="quant-chart-card quant-gauge-card">
      <header>
        <div>
          <span>DPI / MPI / GDI</span>
          <strong>盘口保护指数</strong>
        </div>
      </header>
      <div className="quant-gauge-grid">
        {protectionGaugeItems.map((item) => (
          <div className="quant-gauge-cell has-help" key={item.label}>
            <span>{item.title}</span>
            <MiniGauge label={item.label} value={indexes[item.key]} color={item.color} />
            <p className="quant-help-popover">{item.help}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function MiniGauge({ label, value, color }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const angle = (safeValue / 100 * 180 - 180) * Math.PI / 180;
  const needle = {
    x: 60 + Math.cos(angle) * 34,
    y: 62 + Math.sin(angle) * 34,
  };
  return (
    <div className="mini-gauge" style={{ "--gauge-color": color }}>
      <svg viewBox="0 0 120 76" aria-hidden="true">
        <path className="mini-gauge__rail" d="M14 62 A46 46 0 0 1 106 62" pathLength="100" />
        <path className="mini-gauge__value" d="M14 62 A46 46 0 0 1 106 62" pathLength="100" strokeDasharray={`${safeValue} 100`} />
        <line className="mini-gauge__needle" x1="60" y1="62" x2={needle.x.toFixed(2)} y2={needle.y.toFixed(2)} />
        <circle className="mini-gauge__hub" cx="60" cy="62" r="3.5" />
      </svg>
      <strong>{formatNumber(safeValue, 3)}</strong>
      <em>{label}</em>
    </div>
  );
}

function PatternCard({ title, subtitle, items, meta }) {
  return (
    <article className="quant-pattern-card">
      <header>
        <span>{subtitle}</span>
        <strong>{title}</strong>
      </header>
      <p>{meta || "--"}</p>
      <div>
        {(items || []).slice(0, 3).map((item) => <em key={item}>{item}</em>)}
      </div>
    </article>
  );
}

function EChart({ option, className = "" }) {
  const ref = useRef(null);
  const stableOption = useMemo(() => option, [option]);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = echarts.init(ref.current, "dark", { renderer: "canvas" });
    chart.setOption(stableOption, true);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [stableOption]);

  return <div className={`quant-echart${className ? ` ${className}` : ""}`} ref={ref} />;
}

function DebugItem({ label, value, help }) {
  return (
    <div className={help ? "has-help" : ""}>
      <span>{label}</span>
      <strong>{value || "--"}</strong>
      {help && <p className="quant-help-popover">{help}</p>}
    </div>
  );
}

function buildOddsLineOption(rows) {
  const times = rows.map((row) => row.time || "--");
  return baseOption({
    tooltip: { trigger: "axis" },
    legend: { top: 6, textStyle: { color: "#dcecff" } },
    grid: chartGrid(),
    xAxis: axis("category", times),
    yAxis: axis("value"),
    series: [
      lineSeries("主胜", rows.map((row) => round(row.home)), "#ff5f7f"),
      lineSeries("平局", rows.map((row) => round(row.draw)), "#39f2ad"),
      lineSeries("客胜", rows.map((row) => round(row.away)), "#8d7cff"),
    ],
  });
}

function buildMarketLineOption(rows, label) {
  const hasRows = rows.length > 1;
  const data = hasRows ? rows : syntheticMarketRows(label);
  return baseOption({
    tooltip: { trigger: "axis" },
    grid: chartGrid(),
    xAxis: axis("category", data.map((row) => row.time || row.company || "--")),
    yAxis: axis("value"),
    series: [
      {
        name: label,
        type: "line",
        smooth: true,
        symbolSize: 7,
        data: data.map((row) => round(row.line)),
        lineStyle: { width: 3, color: "#2ee8ff" },
        itemStyle: { color: "#2ee8ff" },
        areaStyle: { color: "rgba(46, 232, 255, 0.12)" },
      },
    ],
    graphic: hasRows ? [] : [{
      type: "text",
      left: "center",
      top: "middle",
      style: {
        text: "暂无公开历史，显示理论占位",
        fill: "rgba(220,236,255,0.55)",
        fontWeight: 800,
      },
    }],
  });
}

function buildScoreHeatmapOption(matrix) {
  const xLabels = matrix[0]?.map((cell) => `${cell.awayGoals}`) || [];
  const yLabels = matrix.map((row) => `${row[0]?.homeGoals ?? 0}`);
  const data = matrix.flatMap((row, y) => row.map((cell, x) => [x, y, round(cell.probability * 100)]));
  return baseOption({
    tooltip: {
      formatter: (params) => `${yLabels[params.value[1]]}:${xLabels[params.value[0]]}<br/>${params.value[2]}%`,
    },
    grid: { top: 30, right: 22, bottom: 34, left: 42 },
    xAxis: axis("category", xLabels, "客队进球"),
    yAxis: axis("category", yLabels, "主队进球"),
    visualMap: {
      min: 0,
      max: Math.max(1, ...data.map((item) => item[2])),
      show: false,
      inRange: { color: ["rgba(46,232,255,0.05)", "#2ee8ff", "#39f2ad", "#ffd36a", "#ff5f7f"] },
    },
    series: [{ type: "heatmap", data, label: { show: true, color: "#f8fdff", fontSize: 10 } }],
  });
}

function buildGoalDiffOption(rows) {
  return baseOption({
    tooltip: { trigger: "axis" },
    grid: chartGrid(),
    xAxis: axis("category", rows.map((row) => row.diff > 0 ? `+${row.diff}` : `${row.diff}`)),
    yAxis: axis("value"),
    series: [{
      type: "bar",
      data: rows.map((row) => round(row.probability * 100)),
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: (params) => {
          const diff = rows[params.dataIndex]?.diff || 0;
          if (diff > 0) return "#ff5f7f";
          if (diff < 0) return "#8d7cff";
          return "#39f2ad";
        },
      },
    }],
  });
}

function buildRiskRadarOption(rows) {
  return baseOption({
    tooltip: {},
    radar: {
      indicator: rows.map((row) => ({ name: row.name, max: 100 })),
      radius: "64%",
      splitLine: { lineStyle: { color: "rgba(139,213,255,0.2)" } },
      splitArea: { areaStyle: { color: ["rgba(46,232,255,0.03)", "rgba(141,124,255,0.04)"] } },
      axisName: { color: "#dcecff", fontSize: 11 },
    },
    series: [{
      type: "radar",
      data: [{ value: rows.map((row) => round(row.value)), name: "风险" }],
      areaStyle: { color: "rgba(255,95,127,0.18)" },
      lineStyle: { color: "#ff5f7f", width: 3 },
      itemStyle: { color: "#ff5f7f" },
    }],
  });
}

function buildConsensusHeatmapOption(matrix) {
  const labels = matrix.slice(0, 12).map((row) => row.bookmaker);
  const data = matrix.slice(0, 12).flatMap((row, y) => row.row.slice(0, 12).map((cell, x) => [x, y, round(cell.value * 100)]));
  return baseOption({
    tooltip: { formatter: (params) => `${labels[params.value[1]]} / ${labels[params.value[0]]}<br/>一致性 ${params.value[2]}` },
    grid: { top: 24, right: 20, bottom: 54, left: 72 },
    xAxis: axis("category", labels),
    yAxis: axis("category", labels),
    visualMap: {
      min: 0,
      max: 100,
      show: false,
      inRange: { color: ["rgba(255,95,127,0.18)", "rgba(255,211,106,0.55)", "rgba(57,242,173,0.9)"] },
    },
    series: [{ type: "heatmap", data }],
  });
}

function baseOption(option) {
  return {
    backgroundColor: "transparent",
    textStyle: { color: "#dcecff", fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif" },
    ...option,
  };
}

function axis(type, data, name = "") {
  return {
    type,
    data,
    name,
    nameTextStyle: { color: "#8b9ab8" },
    axisLine: { lineStyle: { color: "rgba(139,213,255,0.26)" } },
    axisLabel: { color: "#8b9ab8", hideOverlap: true },
    splitLine: { lineStyle: { color: "rgba(139,213,255,0.12)" } },
  };
}

function chartGrid() {
  return { top: 42, right: 20, bottom: 34, left: 44 };
}

function lineSeries(name, data, color) {
  return {
    name,
    type: "line",
    smooth: true,
    symbolSize: 7,
    data,
    lineStyle: { width: 3, color },
    itemStyle: { color },
    areaStyle: { color: `${color}22` },
  };
}

function syntheticMarketRows(label) {
  return [
    { time: "初盘", line: label === "让球" ? -0.25 : 2.25 },
    { time: "即时", line: label === "让球" ? -0.5 : 2.5 },
  ];
}

function formatWindowSignal(signal) {
  if (!signal?.strongest) return "3h 样本不足";
  return `3h ${outcomeLabels[signal.strongest.key]} ${formatSignedNumber(signal.strongest.value, 3)}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toFixed(digits);
}

function formatHandicap(value) {
  if (!Number.isFinite(value)) return "--";
  if (value === 0) return "平手";
  return `${value < 0 ? "主让" : "客让"}${Math.abs(value).toFixed(2).replace(/\.00$/, "")}`;
}

function formatBias(value) {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) < 0.001) return "0球";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2).replace(/\.00$/, "")}球`;
}

function formatSignedNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}
