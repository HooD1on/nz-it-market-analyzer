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
  categoryDistribution: ChartDatum[];
};

const BAR_COLOR = "#22d3ee";
const LINE_COLOR = "#38bdf8";
const CHART_WIDTH = 912;
const CHART_HEIGHT = 500;

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fillLast7Days(data: DailyDatum[]): DailyDatum[] {
  const map = new Map<string, number>();
  for (const item of data) {
    const key = formatDateKey(new Date(item.date));
    map.set(key, Number(item.value) || 0);
  }

  const result: DailyDatum[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i -= 1) {
    const current = new Date(today);
    current.setDate(today.getDate() - i);
    const key = formatDateKey(current);
    result.push({
      date: key,
      value: map.get(key) ?? 0,
    });
  }

  return result;
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

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
  const dailyTrend = useMemo(() => fillLast7Days(stats?.dailyNewJobs ?? []), [stats]);

  const todayLabel = useMemo(() => {
    return new Date().toLocaleDateString("en-NZ", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, []);
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
        left: "-20000px",
        top: "0",
        width: "1080px",
        height: "1440px",
        boxSizing: "border-box",
        margin: "0",
        zIndex: "-1",
        backgroundColor: "#0f172a",
      });

      document.body.appendChild(clonedNode);

      const dataUrl = await toPng(clonedNode, {
        cacheBust: true,
        pixelRatio: 2,
        width: 1080,
        height: 1440,
      });

      const dateToken = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const filename = `NZ_IT_Market_Report_${dateToken}.png`;

      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
      setExportSuccess(`导出成功：${filename}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "海报导出失败。");
    } finally {
      if (clonedNode && document.body.contains(clonedNode)) {
        document.body.removeChild(clonedNode);
      }
      setIsExporting(false);
    }
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
          <h1 className="text-xl font-semibold sm:text-2xl">NZ IT Market Dashboard</h1>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={isExporting || !isStatsReady}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isExporting ? "导出中..." : "准备生成海报"}
          </button>
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
                <h2 className="text-[30px] font-bold tracking-tight">新西兰 IT 市场每日分析</h2>
                <p className="mt-1 text-base font-medium text-slate-200">日期：{todayLabel}</p>
                <p className="mt-1 text-xs text-slate-400">海报比例：1080 × 1440</p>
              </div>

              {loading ? (
                <div className="flex flex-1 items-center justify-center text-base text-slate-300">
                  加载统计数据中...
                </div>
              ) : error ? (
                <div className="flex flex-1 items-center justify-center text-base text-red-300">
                  数据加载失败：{error}
                </div>
              ) : !stats ? (
                <div className="flex flex-1 items-center justify-center text-base text-slate-300">Loading...</div>
              ) : (
                <div className="flex h-full flex-col justify-between">
                  <section className="h-[600px] w-full min-w-full rounded-xl border border-slate-700 bg-slate-800/60 p-6">
                    <h3 className="mb-3 text-lg font-semibold text-cyan-300">技术热度排行 Top 10</h3>
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
                        <Bar dataKey="value" fill={BAR_COLOR} radius={[5, 5, 0, 0]} />
                      </BarChart>
                    </div>
                  </section>

                  <section className="h-[600px] w-full min-w-full rounded-xl border border-slate-700 bg-slate-800/60 p-6">
                    <h3 className="mb-3 text-lg font-semibold text-cyan-300">岗位增长趋势（近 7 天）</h3>
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
                          type="monotone"
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
      </div>
    </div>
  );
}
