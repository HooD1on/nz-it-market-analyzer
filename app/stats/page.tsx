"use client";

import { useEffect, useMemo, useState } from "react";
import { toPng } from "html-to-image";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ChartDatum = {
  name: string;
  value: number;
};

type DailyDatum = {
  date: string;
  value: number;
};

type StatsResponse = {
  techKeywordFrequency: ChartDatum[];
  dailyNewJobs: DailyDatum[];
  latestPublishedDate: string;
  latestPublishedCount: number;
  categoryDistribution: ChartDatum[];
};

type KeywordJobItem = {
  title: string;
  sourceUrl: string;
  category: string;
  listingDate: string;
};

type KeywordJobsResponse = {
  keyword: string;
  total: number;
  jobs: KeywordJobItem[];
};

type PosterLocale = "zh" | "en";

const BAR_COLOR = "#22d3ee";
const LINE_COLOR = "#38bdf8";
const CHART_WIDTH = 912;
const CHART_HEIGHT = 500;

const UI_COPY = {
  zh: {
    dashboardTitle: "NZ IT Market Dashboard",
    exportIdle: "准备生成海报",
    exporting: "导出中...",
    exportSuccess: (filename: string) => `导出成功：${filename}`,
    exportFailed: "海报导出失败。",
    posterTitle: "新西兰 IT 市场每日分析",
    dateLabel: "日期",
    posterRatioLabel: "海报比例",
    loadingStats: "加载统计数据中...",
    dataLoadFailedPrefix: "数据加载失败",
    top10Title: "技术热度排行 Top 10",
    clickBarHint: "点击柱子查看岗位明细",
    trendTitle: "岗位发布趋势（截至最近发布日期的近 7 天）",
    latestPublished: (date: string, count: number) => `最新发布：${date}（${count} 条）`,
    loadingDataShort: "数据加载中",
    bootstrapHint: "当前峰值可能受历史数据补录影响，后续会随每日新增发布逐步平滑。",
    drilldownTitle: "岗位明细钻取",
    keywordLabel: "关键词",
    drilldownHint: "点击上方 Top10 任意柱子，查看对应岗位明细。",
    loadingDetails: "正在加载岗位明细...",
    detailLoadFailedPrefix: "岗位明细加载失败",
    noDetailData: "该关键词暂无可展示岗位。",
    tableDate: "发布时间",
    tableTitle: "岗位标题",
    tableCategory: "分类",
    tableLink: "链接",
    viewLink: "查看",
    posterLangLabel: "海报语言",
    langZh: "中文",
    langEn: "English",
  },
  en: {
    dashboardTitle: "NZ IT Market Dashboard",
    exportIdle: "Export Poster",
    exporting: "Exporting...",
    exportSuccess: (filename: string) => `Exported: ${filename}`,
    exportFailed: "Poster export failed.",
    posterTitle: "NZ IT Market Daily Report",
    dateLabel: "Date",
    posterRatioLabel: "Poster Ratio",
    loadingStats: "Loading market stats...",
    dataLoadFailedPrefix: "Failed to load data",
    top10Title: "Top 10 Tech Keywords",
    clickBarHint: "Click a bar to drill into jobs",
    trendTitle: "Job Posting Trend (Last 7 days from latest published date)",
    latestPublished: (date: string, count: number) => `Latest: ${date} (${count})`,
    loadingDataShort: "Loading data",
    bootstrapHint:
      "The current peak may be influenced by historical backfill and should smooth out with daily updates.",
    drilldownTitle: "Job Detail Drill-Down",
    keywordLabel: "Keyword",
    drilldownHint: "Click any Top 10 bar above to view matching job details.",
    loadingDetails: "Loading job details...",
    detailLoadFailedPrefix: "Failed to load job details",
    noDetailData: "No jobs found for this keyword.",
    tableDate: "Published Date",
    tableTitle: "Job Title",
    tableCategory: "Category",
    tableLink: "Link",
    viewLink: "Open",
    posterLangLabel: "Poster Language",
    langZh: "中文",
    langEn: "English",
  },
} as const;

async function isLikelySolidImage(dataUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(false);
        return;
      }

      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const stepX = Math.max(1, Math.floor(width / 48));
      const stepY = Math.max(1, Math.floor(height / 48));

      let baseR = -1;
      let baseG = -1;
      let baseB = -1;
      let sampled = 0;
      let similar = 0;

      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const idx = (y * width + x) * 4;
          const alpha = data[idx + 3];
          if (alpha < 8) continue;

          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          if (baseR < 0) {
            baseR = r;
            baseG = g;
            baseB = b;
          }

          const delta = Math.abs(r - baseR) + Math.abs(g - baseG) + Math.abs(b - baseB);
          if (delta <= 9) {
            similar += 1;
          }
          sampled += 1;
        }
      }

      if (sampled === 0) {
        resolve(true);
        return;
      }

      resolve(similar / sampled > 0.985);
    };
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);
  const [keywordJobs, setKeywordJobs] = useState<KeywordJobItem[]>([]);
  const [keywordJobsLoading, setKeywordJobsLoading] = useState(false);
  const [keywordJobsError, setKeywordJobsError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [posterLocale, setPosterLocale] = useState<PosterLocale>("zh");
  const ui = UI_COPY[posterLocale];

  useEffect(() => {
    let active = true;

    async function loadStats() {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch("/api/stats", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load stats: ${response.status}`);
        }

        const data = (await response.json()) as StatsResponse;
        if (active) {
          setStats(data);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadStats();
    return () => {
      active = false;
    };
  }, []);

  const keywordTop10 = useMemo(() => (stats?.techKeywordFrequency ?? []).slice(0, 10), [stats]);
  const dailyTrend = useMemo(() => stats?.dailyNewJobs ?? [], [stats]);
  const isBootstrapLikeSpike = useMemo(() => {
    if (dailyTrend.length === 0) {
      return false;
    }
    const nonZeroDays = dailyTrend.filter((item) => item.value > 0).length;
    const total = dailyTrend.reduce((sum, item) => sum + item.value, 0);
    const maxValue = Math.max(...dailyTrend.map((item) => item.value));
    return nonZeroDays <= 2 && total > 0 && maxValue / total >= 0.8;
  }, [dailyTrend]);

  const todayLabel = useMemo(() => {
    if (posterLocale === "zh") {
      return new Date().toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
    return new Date().toLocaleDateString("en-NZ", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, [posterLocale]);
  const isStatsReady = !loading && !error && Boolean(stats);

  useEffect(() => {
    if (!exportSuccess) {
      return;
    }

    const timer = window.setTimeout(() => {
      setExportSuccess(null);
    }, 2500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [exportSuccess]);

  useEffect(() => {
    const keywordValue = selectedKeyword ?? "";
    if (!keywordValue) {
      return;
    }

    let active = true;

    async function loadKeywordJobs() {
      try {
        setKeywordJobsLoading(true);
        setKeywordJobsError(null);

        const response = await fetch(`/api/jobs?keyword=${encodeURIComponent(keywordValue)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Failed to load job details: ${response.status}`);
        }

        const data = (await response.json()) as KeywordJobsResponse;
        if (active) {
          setKeywordJobs(data.jobs);
        }
      } catch (err) {
        if (active) {
          setKeywordJobsError(err instanceof Error ? err.message : "Unknown error");
          setKeywordJobs([]);
        }
      } finally {
        if (active) {
          setKeywordJobsLoading(false);
        }
      }
    }

    void loadKeywordJobs();

    return () => {
      active = false;
    };
  }, [selectedKeyword]);

  async function waitForStableRender(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function handleExport(): Promise<void> {
    if (isExporting || !isStatsReady) return;

    let clonedNode: HTMLElement | null = null;
    try {
      setIsExporting(true);
      setExportError(null);
      setExportSuccess(null);

      const posterNode = document.getElementById("poster-area");
      if (!posterNode) throw new Error("Poster container not found.");

      await waitForStableRender();

      // Deep clone poster node to avoid exporting transformed preview tree.
      clonedNode = posterNode.cloneNode(true) as HTMLElement;

      Object.assign(clonedNode.style, {
        transform: "none",
        scale: "1",
        position: "fixed",
        left: "-9999px",
        top: "0",
        width: "1080px",
        height: "1440px",
      });

      document.body.appendChild(clonedNode);
      void clonedNode.offsetHeight;
      if ("fonts" in document) {
        await document.fonts.ready;
      }
      await waitForStableRender();
      await new Promise((r) => setTimeout(r, 300));

      const exportOptions = {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#0f172a",
        width: 1080,
        height: 1440,
        canvasWidth: 1080,
        canvasHeight: 1440,
      } as const;

      let dataUrl = await toPng(clonedNode, exportOptions);
      const blankLike = await isLikelySolidImage(dataUrl);

      if (blankLike) {
        // Fallback to live node export if cloned snapshot is nearly solid.
        dataUrl = await toPng(posterNode as HTMLElement, exportOptions);
      }

      const dateToken = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const languageSuffix = posterLocale === "zh" ? "CN" : "EN";
      const filename = `NZ_IT_Market_Report_${languageSuffix}_${dateToken}.png`;

      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
      setExportSuccess(ui.exportSuccess(filename));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : ui.exportFailed);
    } finally {
      if (clonedNode && document.body.contains(clonedNode)) {
        document.body.removeChild(clonedNode);
      }
      setIsExporting(false);
    }
  }

  function handleKeywordBarClick(item: ChartDatum): void {
    if (!item?.name) {
      return;
    }
    setKeywordJobs([]);
    setKeywordJobsError(null);
    setSelectedKeyword(item.name);
  }

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 text-slate-900">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6">
        <div
          data-export-hide
          className={`flex w-full items-center justify-between transition ${
            isExporting ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <h1 className="text-xl font-semibold sm:text-2xl">{ui.dashboardTitle}</h1>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-slate-600 sm:inline">{ui.posterLangLabel}</span>
            <button
              type="button"
              onClick={() => setPosterLocale("zh")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                posterLocale === "zh"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {ui.langZh}
            </button>
            <button
              type="button"
              onClick={() => setPosterLocale("en")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                posterLocale === "en"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {ui.langEn}
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={isExporting || !isStatsReady}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isExporting ? ui.exporting : ui.exportIdle}
            </button>
          </div>
        </div>

        {exportError ? (
          <p className="text-sm text-red-600" data-export-hide>
            {exportError}
          </p>
        ) : null}

        {exportSuccess ? (
          <div
            data-export-hide
            className="fixed right-6 top-6 z-50 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-lg"
          >
            {exportSuccess}
          </div>
        ) : null}

        <div className="h-[720px] w-[540px] max-w-full overflow-hidden rounded-2xl shadow-lg">
          <div className="h-[1440px] w-[1080px] origin-top-left scale-50">
            <div
              id="poster-area"
              className="box-border flex h-full w-full flex-col overflow-hidden bg-slate-900 p-[60px] text-white"
            >
              <div className="flex h-full flex-col">
              <div className="mb-6 border-b border-slate-700 pb-5 text-center">
                <h2 className="text-[30px] font-bold tracking-tight">{ui.posterTitle}</h2>
                <p className="mt-1 text-base font-medium text-slate-200">
                  {ui.dateLabel}: {todayLabel}
                </p>
                <p className="mt-1 text-xs text-slate-400">{ui.posterRatioLabel}: 1080 × 1440</p>
              </div>

              {loading ? (
                <div className="flex flex-1 items-center justify-center text-base text-slate-300">
                  {ui.loadingStats}
                </div>
              ) : error ? (
                <div className="flex flex-1 items-center justify-center text-base text-red-300">
                  {ui.dataLoadFailedPrefix}: {error}
                </div>
              ) : !stats ? (
                <div className="flex flex-1 items-center justify-center text-base text-slate-300">Loading...</div>
              ) : (
                <div className="flex h-full flex-col justify-between">
                  <section className="h-[600px] w-full min-w-full rounded-xl border border-slate-700 bg-slate-800/60 p-6">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold text-cyan-300">{ui.top10Title}</h3>
                      <span className="text-xs text-slate-300">{ui.clickBarHint}</span>
                    </div>
                    <div className="h-[500px] w-full min-w-full overflow-hidden">
                      <BarChart
                        width={CHART_WIDTH}
                        height={CHART_HEIGHT}
                        data={keywordTop10}
                        margin={{ top: 24, right: 36, left: 20, bottom: 42 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 14, fill: "#e2e8f0" }}
                          interval={0}
                          angle={-20}
                          height={42}
                        />
                        <YAxis tick={{ fontSize: 13, fill: "#e2e8f0" }} />
                        <Tooltip />
                        <Bar
                          dataKey="value"
                          fill={BAR_COLOR}
                          radius={[5, 5, 0, 0]}
                          cursor="pointer"
                          onClick={(data) => handleKeywordBarClick(data as ChartDatum)}
                        />
                      </BarChart>
                    </div>
                  </section>

                  <section className="h-[600px] w-full min-w-full rounded-xl border border-slate-700 bg-slate-800/60 p-6">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold text-cyan-300">{ui.trendTitle}</h3>
                      <span className="rounded-md bg-slate-700 px-3 py-1 text-xs font-medium text-slate-200">
                        {stats
                          ? ui.latestPublished(stats.latestPublishedDate, stats.latestPublishedCount)
                          : ui.loadingDataShort}
                      </span>
                    </div>
                    {isBootstrapLikeSpike ? (
                      <p className="mb-2 text-xs text-slate-300">{ui.bootstrapHint}</p>
                    ) : null}
                    <div className="h-[500px] w-full min-w-full overflow-hidden">
                      <LineChart
                        width={CHART_WIDTH}
                        height={CHART_HEIGHT}
                        data={dailyTrend}
                        margin={{ top: 24, right: 36, left: 20, bottom: 30 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="date" tick={{ fontSize: 13, fill: "#e2e8f0" }} />
                        <YAxis tick={{ fontSize: 13, fill: "#e2e8f0" }} />
                        <Tooltip />
                        <Line
                          type="linear"
                          dataKey="value"
                          stroke={LINE_COLOR}
                          strokeWidth={3}
                          dot={{ r: 3 }}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
        </div>

        <section
          data-export-hide
          className="w-full rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-slate-900">{ui.drilldownTitle}</h3>
            {selectedKeyword ? (
              <span className="rounded-md bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700">
                {ui.keywordLabel}: {selectedKeyword}
              </span>
            ) : null}
          </div>

          {!selectedKeyword ? (
            <p className="text-sm text-slate-500">{ui.drilldownHint}</p>
          ) : keywordJobsLoading ? (
            <p className="text-sm text-slate-500">{ui.loadingDetails}</p>
          ) : keywordJobsError ? (
            <p className="text-sm text-red-600">
              {ui.detailLoadFailedPrefix}: {keywordJobsError}
            </p>
          ) : keywordJobs.length === 0 ? (
            <p className="text-sm text-slate-500">{ui.noDetailData}</p>
          ) : (
            <div className="max-h-[320px] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left text-slate-600">
                    <th className="px-3 py-2 font-medium">{ui.tableDate}</th>
                    <th className="px-3 py-2 font-medium">{ui.tableTitle}</th>
                    <th className="px-3 py-2 font-medium">{ui.tableCategory}</th>
                    <th className="px-3 py-2 font-medium">{ui.tableLink}</th>
                  </tr>
                </thead>
                <tbody>
                  {keywordJobs.map((job) => (
                    <tr key={`${job.sourceUrl}__${job.title}`} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{job.listingDate}</td>
                      <td className="px-3 py-2 text-slate-800">{job.title}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{job.category}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <a
                          href={job.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:text-blue-500 hover:underline"
                        >
                          {ui.viewLink}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
