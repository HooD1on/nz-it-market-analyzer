import { NextRequest, NextResponse } from "next/server";

import { queryStats } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type JobDetailRow = {
  title: string;
  source_url: string;
  category: string;
  listing_date_key: string | null;
  created_at: string | Date;
};

type JobDetailItem = {
  title: string;
  sourceUrl: string;
  category: string;
  listingDate: string;
};

function normalizeDate(value: string | Date | null | undefined): string {
  if (!value) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const dateOnly = value.slice(0, 10);
  return dateOnly;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const keyword = request.nextUrl.searchParams.get("keyword")?.trim() ?? "";
    if (!keyword) {
      return NextResponse.json({ message: "keyword is required" }, { status: 400 });
    }

    const rows = await queryStats<JobDetailRow[]>(
      `
        SELECT
          title,
          source_url,
          category,
          DATE_FORMAT(listing_date, '%Y-%m-%d') AS listing_date_key,
          created_at
        FROM jobs
        WHERE FIND_IN_SET(?, REPLACE(COALESCE(tech_keywords, ''), ' ', '')) > 0
        ORDER BY COALESCE(listing_date, DATE(created_at)) DESC, created_at DESC
        LIMIT 120
      `,
      [keyword.replace(/\s+/g, "")],
    );

    const jobs: JobDetailItem[] = rows.map((row) => ({
      title: row.title,
      sourceUrl: row.source_url,
      category: row.category,
      listingDate: normalizeDate(row.listing_date_key) || normalizeDate(row.created_at),
    }));

    return NextResponse.json(
      {
        keyword,
        total: jobs.length,
        jobs,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      },
    );
  } catch (error) {
    console.error("Failed to fetch job details:", error);
    return NextResponse.json({ message: "Failed to fetch job details" }, { status: 500 });
  }
}
