import { NextResponse } from "next/server";

import { queryStats } from "@/lib/db";

type CategoryRow = {
  name: string;
  value: number;
};

type DailyRow = {
  date: string;
  count: number;
};

type KeywordRow = {
  tech_keywords: string | null;
};

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildLast7DaysTrend(rows: DailyRow[]): Array<{ date: string; value: number }> {
  const countByDate = new Map<string, number>();
  rows.forEach((row) => {
    const normalizedDate = formatDateKey(new Date(row.date));
    countByDate.set(normalizedDate, Number(row.count) || 0);
  });

  const result: Array<{ date: string; value: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i -= 1) {
    const current = new Date(today);
    current.setDate(today.getDate() - i);
    const key = formatDateKey(current);
    result.push({
      date: key,
      value: countByDate.get(key) ?? 0,
    });
  }

  return result;
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
    const categoryRows = await queryStats<CategoryRow[]>(
      `
        SELECT category AS name, COUNT(*) AS value
        FROM jobs
        GROUP BY category
        ORDER BY value DESC
      `,
    );

    const dailyRows = await queryStats<DailyRow[]>(
      `
        SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM jobs
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at) ASC
      `,
    );

    const keywordRows = await queryStats<KeywordRow[]>(
      `
        SELECT tech_keywords
        FROM jobs
        WHERE tech_keywords IS NOT NULL
          AND CHAR_LENGTH(TRIM(tech_keywords)) > 0
      `,
    );

    const payload = {
      techKeywordFrequency: buildKeywordFrequency(keywordRows),
      dailyNewJobs: buildLast7DaysTrend(dailyRows),
      categoryDistribution: categoryRows.map((row) => ({
        name: row.name,
        value: Number(row.value) || 0,
      })),
    };

    return NextResponse.json(payload);
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
