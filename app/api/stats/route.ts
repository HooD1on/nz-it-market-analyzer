import { NextResponse } from "next/server";

import { queryStats } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type CategoryRow = {
  name: string;
  value: number;
};

type DailyRow = {
  listing_date_key: string | null;
  created_at: string | Date;
};

type KeywordRow = {
  tech_keywords: string | null;
};

type TrendPoint = {
  date: string;
  value: number;
};

const REPORT_TIMEZONE = "Pacific/Auckland";

function formatDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function shiftDateKey(dateKey: string, offsetDays: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function buildRecentPostingTrend(rows: DailyRow[]): {
  trend: TrendPoint[];
  latestDate: string;
  latestCount: number;
} {
  const countByDate = new Map<string, number>();
  for (const row of rows) {
    let dateKey = (row.listing_date_key ?? "").trim();
    if (!dateKey) {
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
      if (Number.isNaN(createdAt.getTime())) {
        continue;
      }
      dateKey = formatDateKey(createdAt);
    }
    countByDate.set(dateKey, (countByDate.get(dateKey) ?? 0) + 1);
  }

  const sortedKeys = [...countByDate.keys()].sort();
  const latestDate = sortedKeys.at(-1) ?? formatDateKey(new Date());
  const latestCount = countByDate.get(latestDate) ?? 0;
  const result: TrendPoint[] = [];

  for (let i = 6; i >= 0; i -= 1) {
    const key = shiftDateKey(latestDate, -i);
    result.push({
      date: key,
      value: countByDate.get(key) ?? 0,
    });
  }

  return { trend: result, latestDate, latestCount };
}

function buildKeywordFrequency(rows: KeywordRow[]): Array<{ name: string; value: number }> {
  const frequency = new Map<string, number>();

  for (const row of rows) {
    const keywords = (row.tech_keywords ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    for (const keyword of keywords) {
      frequency.set(keyword, (frequency.get(keyword) ?? 0) + 1);
    }
  }

  return [...frequency.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

export async function GET(): Promise<NextResponse> {
  try {
    const [categoryRows, dailyRows, keywordRows] = await Promise.all([
      queryStats<CategoryRow[]>(
        `
          SELECT category AS name, COUNT(*) AS value
          FROM jobs
          GROUP BY category
          ORDER BY value DESC
        `,
      ),
      queryStats<DailyRow[]>(
        `
          SELECT DATE_FORMAT(listing_date, '%Y-%m-%d') AS listing_date_key, created_at
          FROM jobs
          WHERE COALESCE(listing_date, DATE(created_at)) >= (
            SELECT DATE_SUB(MAX(COALESCE(listing_date, DATE(created_at))), INTERVAL 10 DAY)
            FROM jobs
          )
          ORDER BY created_at ASC
        `,
      ),
      queryStats<KeywordRow[]>(
        `
          SELECT tech_keywords
          FROM jobs
          WHERE tech_keywords IS NOT NULL
            AND CHAR_LENGTH(TRIM(tech_keywords)) > 0
        `,
      ),
    ]);

    const { trend, latestDate, latestCount } = buildRecentPostingTrend(dailyRows);

    const payload = {
      techKeywordFrequency: buildKeywordFrequency(keywordRows),
      dailyNewJobs: trend,
      latestPublishedDate: latestDate,
      latestPublishedCount: latestCount,
      categoryDistribution: categoryRows.map((row) => ({
        name: row.name,
        value: Number(row.value) || 0,
      })),
    };

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("Failed to fetch stats:", error);
    return NextResponse.json(
      {
        message: "Failed to fetch stats",
      },
      { status: 500 },
    );
  }
}
