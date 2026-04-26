import { config as loadEnv } from "dotenv";
import { Pool, RowDataPacket } from "mysql2/promise";
import { BrowserContext, chromium, Page } from "playwright";

const REPORT_URL = "https://me2link.com/job?selection=job-report&ppage=1";
const SEARCH_API_URL = "https://api.me2link.com/search";
const REPORT_TIMEZONE = "Pacific/Auckland";
const RESET_JOBS = process.argv.includes("--reset-jobs");
const DEEP_DESCRIPTION_REFETCH = process.argv.includes("--deep-description");
const ALLOW_LIVE_FALLBACK = process.argv.includes("--allow-live-fallback");

loadEnv({ path: ".env.local" });

type SearchListing = {
  title: string;
  url: string;
  short_description: string;
  classified_industry: string;
  classification: string;
  it_category: string;
  listing_date?: string;
};

type SearchApiResponse = {
  listings?: SearchListing[];
  total_pages?: number;
  total_count?: number;
};

type JobSeed = {
  title: string;
  url: string;
  shortDescription: string;
  htmlDescription: string;
  category: string;
  classification: string;
  itCategory: string;
  listingDateRaw: string;
};

type PreparedJobRecord = {
  title: string;
  category: string;
  fullDescription: string;
  sourceUrl: string;
  techKeywords: string[];
  createdAt: Date;
  listingDate: string | null;
};

const KEYWORD_PATTERNS: Array<{ keyword: string; patterns: RegExp[] }> = [
  { keyword: "React", patterns: [/\breact(?:\.js)?\b/i] },
  { keyword: "Next.js", patterns: [/\bnext(?:\.js)?\b/i] },
  { keyword: "Node.js", patterns: [/\bnode(?:\.js)?\b/i] },
  { keyword: "TypeScript", patterns: [/\btypescript\b/i, /\bts\b/i] },
  { keyword: "JavaScript", patterns: [/\bjavascript\b/i, /\bes6\b/i, /\becmascript\b/i] },
  { keyword: "C#", patterns: [/(?:^|[^a-z0-9])c#(?:$|[^a-z0-9])/i, /\bcsharp\b/i] },
  { keyword: ".NET", patterns: [/(?:^|[^a-z0-9])\.net(?:$|[^a-z0-9])/i, /\bdotnet\b/i] },
  { keyword: "SQL", patterns: [/\bsql\b/i, /\bt-sql\b/i] },
  { keyword: "MySQL", patterns: [/\bmysql\b/i] },
  { keyword: "PostgreSQL", patterns: [/\bpostgres(?:ql)?\b/i] },
  { keyword: "MongoDB", patterns: [/\bmongo(?:db)?\b/i] },
  { keyword: "AWS", patterns: [/\baws\b/i, /\bamazon web services\b/i] },
  { keyword: "Azure", patterns: [/\bazure\b/i] },
  { keyword: "GCP", patterns: [/\bgcp\b/i, /\bgoogle cloud\b/i] },
  { keyword: "Docker", patterns: [/\bdocker\b/i] },
  { keyword: "Kubernetes", patterns: [/\bkubernetes\b/i, /\bk8s\b/i] },
  { keyword: "Python", patterns: [/\bpython\b/i] },
  { keyword: "Java", patterns: [/\bjava\b/i] },
  { keyword: "Go", patterns: [/\bgolang\b/i, /\bgo\b/i] },
  { keyword: "GraphQL", patterns: [/\bgraphql\b/i] },
  { keyword: "REST API", patterns: [/\brest(?:ful)? api\b/i, /\bapi design\b/i] },
  { keyword: "CI/CD", patterns: [/\bci\/cd\b/i, /\bcontinuous integration\b/i, /\bcontinuous delivery\b/i] },
  { keyword: "Terraform", patterns: [/\bterraform\b/i] },
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeText(text);
}

function parseListingDate(raw: string): string | null {
  const value = normalizeText(raw);
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  // Keep date-only semantic using NZ local date to avoid UTC date-shift.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function isITCategory(category: string, classification = "", itCategory = ""): boolean {
  const joined = `${category} ${classification} ${itCategory}`.toLowerCase();
  return (
    joined.includes("信息与通信技术") ||
    joined.includes("information & communication technology") ||
    joined.includes("information and communication technology") ||
    joined.includes("ict")
  );
}

function extractTechKeywords(content: string): string[] {
  const normalized = normalizeText(content);
  return KEYWORD_PATTERNS.filter((item) => item.patterns.some((pattern) => pattern.test(normalized))).map(
    (item) => item.keyword,
  );
}

function dedupeSeeds(seeds: JobSeed[]): JobSeed[] {
  const unique = new Map<string, JobSeed>();
  for (const seed of seeds) {
    const title = normalizeText(seed.title);
    const url = normalizeText(seed.url);
    if (!title || !url) {
      continue;
    }
    const key = `${title}__${url}`;
    if (!unique.has(key)) {
      unique.set(key, {
        ...seed,
        title,
        url,
        category: normalizeText(seed.category),
        classification: normalizeText(seed.classification),
        itCategory: normalizeText(seed.itCategory),
      });
    }
  }
  return [...unique.values()];
}

async function loadSeedsFromJobItReport(dbPool: Pool): Promise<JobSeed[]> {
  const [tableRows] = await dbPool.query<RowDataPacket[]>(
    `
      SELECT 1 AS ok
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'job_it_report'
      LIMIT 1
    `,
  );
  if (tableRows.length === 0) {
    console.log("job_it_report table not found, skip report seeds.");
    return [];
  }

  const [rows] = await dbPool.query<RowDataPacket[]>(
    `
      SELECT
        title,
        url,
        COALESCE(short_description, '') AS short_description,
        COALESCE(description, '') AS description,
        COALESCE(classified_industry, '') AS classified_industry,
        COALESCE(classification, '') AS classification,
        COALESCE(it_category, '') AS it_category,
        COALESCE(listing_date, '') AS listing_date
      FROM job_it_report
      WHERE COALESCE(url, '') <> ''
    `,
  );

  const mapped = rows
    .map((row) => ({
      title: String(row.title ?? ""),
      url: String(row.url ?? ""),
      shortDescription: String(row.short_description ?? ""),
      htmlDescription: String(row.description ?? ""),
      category: String(row.classified_industry ?? ""),
      classification: String(row.classification ?? ""),
      itCategory: String(row.it_category ?? ""),
      listingDateRaw: String(row.listing_date ?? ""),
    }))
    .filter((seed) => isITCategory(seed.category, seed.classification, seed.itCategory));

  const deduped = dedupeSeeds(mapped);
  console.log(`Loaded IT seeds from job_it_report: ${deduped.length}`);
  return deduped;
}

async function gotoRealJobList(page: Page): Promise<void> {
  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  const targetLink = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({
        text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
        href: anchor.href,
      }))
      .filter((item) => item.href.includes("selection=jobs"));

    const preferred = candidates.find((item) => /最新职位|求职专区/.test(item.text));
    return preferred ?? candidates[0] ?? null;
  });

  if (!targetLink?.href) {
    throw new Error("Failed to locate jobs list URL.");
  }

  console.log(`Discovered list link: [${targetLink.text || "jobs"}] ${targetLink.href}`);
  await page.goto(targetLink.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
}

async function fetchSearchPageFromBrowser(page: Page, pageNumber: number): Promise<SearchApiResponse> {
  const result = await page.evaluate(
    async ({ apiUrl, pageNumber }) => {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json, text/plain, */*",
        },
        body: new URLSearchParams({
          maxSalary: "9999",
          page: String(pageNumber),
        }),
      });

      if (!response.ok) {
        throw new Error(`search API error ${response.status}`);
      }

      return (await response.json()) as SearchApiResponse;
    },
    { apiUrl: SEARCH_API_URL, pageNumber },
  );

  return result;
}

async function fetchSearchPageWithRetry(
  page: Page,
  pageNumber: number,
  maxAttempts = 3,
): Promise<SearchApiResponse> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchSearchPageFromBrowser(page, pageNumber);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await page.waitForTimeout(1200 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch page ${pageNumber}`);
}

async function loadSeedsFromPagination(page: Page): Promise<JobSeed[]> {
  await gotoRealJobList(page);
  const seeds: JobSeed[] = [];
  const firstPage = await fetchSearchPageWithRetry(page, 1);
  const firstPageListings = firstPage.listings ?? [];
  if (firstPageListings.length === 0) {
    console.log("Search API returned no listings on page 1.");
    return [];
  }

  const reportedTotalPages = Number(firstPage.total_pages ?? 1);
  const totalPages =
    Number.isFinite(reportedTotalPages) && reportedTotalPages > 0
      ? Math.floor(reportedTotalPages)
      : 1;
  const totalCount = Number(firstPage.total_count ?? 0);
  console.log(`Search API reports total pages=${totalPages}, total count=${totalCount}`);

  const appendITSeeds = (listings: SearchListing[]): void => {
    const itListings = listings.filter((item) =>
      isITCategory(item.classified_industry, item.classification, item.it_category),
    );
    seeds.push(
      ...itListings.map((item) => ({
        title: item.title,
        url: item.url,
        shortDescription: item.short_description ?? "",
        htmlDescription: "",
        category: item.classified_industry ?? "",
        classification: item.classification ?? "",
        itCategory: item.it_category ?? "",
        listingDateRaw: item.listing_date ?? "",
      })),
    );
  };

  appendITSeeds(firstPageListings);

  const failedPages: number[] = [];
  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    try {
      const response = await fetchSearchPageWithRetry(page, pageNumber);
      const listings = response.listings ?? [];
      if (listings.length === 0) {
        console.log(`Page ${pageNumber} returned empty listings, continue scanning.`);
      } else {
        appendITSeeds(listings);
      }
    } catch (error) {
      failedPages.push(pageNumber);
      console.warn(`Page ${pageNumber} fetch failed after retries`, error);
    }

    if (pageNumber % 50 === 0 || pageNumber === totalPages) {
      console.log(`Fetched search pages: ${pageNumber}/${totalPages}`);
    }
  }

  if (failedPages.length > 0) {
    console.warn(`Retry pass for failed pages: ${failedPages.length}`);
    const retryStillFailed: number[] = [];
    for (const pageNumber of failedPages) {
      try {
        const response = await fetchSearchPageWithRetry(page, pageNumber);
        const listings = response.listings ?? [];
        if (listings.length === 0) {
          console.log(`Retry page ${pageNumber} returned empty listings.`);
          continue;
        }
        appendITSeeds(listings);
      } catch (error) {
        retryStillFailed.push(pageNumber);
        console.warn(`Retry page ${pageNumber} still failed`, error);
      }
    }

    if (retryStillFailed.length > 0) {
      throw new Error(
        `Search API pagination incomplete, failed pages: ${retryStillFailed
          .slice(0, 20)
          .join(", ")}${retryStillFailed.length > 20 ? "..." : ""}`,
      );
    }
  }

  const deduped = dedupeSeeds(seeds);
  console.log(`Loaded IT seeds from live search API: ${deduped.length}`);
  return deduped;
}

async function refetchDescriptionBySelectors(context: BrowserContext, url: string): Promise<string> {
  const detailPage = await context.newPage();

  try {
    await detailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await detailPage.waitForTimeout(4000);

    const description = await detailPage.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const selectors = [
        "[data-automation='jobAdDetails']",
        "#job-details",
        ".job-details",
        ".job-description",
        ".description",
        "article",
        "main",
      ];

      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node?.textContent) {
          const text = normalize(node.textContent);
          if (text.length >= 120) {
            return text;
          }
        }
      }

      const bodyText = normalize(document.body?.textContent ?? "");
      if (
        /just a moment|enable javascript and cookies|security verification|cloudflare/i.test(bodyText)
      ) {
        return "";
      }

      return bodyText.length >= 120 ? bodyText : "";
    });

    return description;
  } catch {
    return "";
  } finally {
    await detailPage.close();
  }
}

async function buildPreparedRecords(
  context: BrowserContext,
  seeds: JobSeed[],
): Promise<PreparedJobRecord[]> {
  const prepared: PreparedJobRecord[] = [];

  for (const seed of seeds) {
    if (!isITCategory(seed.category, seed.classification, seed.itCategory)) {
      continue;
    }

    let fullDescription = htmlToText(seed.htmlDescription);
    if (!fullDescription) {
      fullDescription = normalizeText(seed.shortDescription);
    }

    if (!fullDescription && DEEP_DESCRIPTION_REFETCH) {
      fullDescription = await refetchDescriptionBySelectors(context, seed.url);
    }

    if (!fullDescription) {
      // Keep the job record even when detail text is blocked, to avoid coverage loss.
      fullDescription = "Description unavailable from source at crawl time.";
      console.log(`Description unavailable, keep record with placeholder: ${seed.url}`);
    }

    const techKeywords = extractTechKeywords(
      `${seed.title} ${seed.category} ${seed.classification} ${seed.itCategory} ${fullDescription}`,
    );

    prepared.push({
      title: normalizeText(seed.title),
      category: normalizeText(seed.category || "信息与通信技术"),
      fullDescription,
      sourceUrl: normalizeText(seed.url),
      techKeywords,
      createdAt: new Date(),
      listingDate: parseListingDate(seed.listingDateRaw),
    });
  }

  return prepared;
}

async function ensureJobsTable(dbPool: Pool): Promise<void> {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title VARCHAR(512) NOT NULL,
      category VARCHAR(255) NOT NULL DEFAULT '',
      full_description MEDIUMTEXT NOT NULL,
      source_url VARCHAR(1024) NOT NULL,
      listing_date DATE NULL,
      tech_keywords TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_title_source (title(255), source_url(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  const [listingDateColumn] = await dbPool.query<RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jobs'
        AND COLUMN_NAME = 'listing_date'
      LIMIT 1
    `,
  );
  if (listingDateColumn.length === 0) {
    await dbPool.query(`
      ALTER TABLE jobs
      ADD COLUMN listing_date DATE NULL AFTER source_url
    `);
  }
}

async function syncMissingListingDate(dbPool: Pool): Promise<number> {
  const [tableRows] = await dbPool.query<RowDataPacket[]>(
    `
      SELECT 1 AS ok
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'job_it_report'
      LIMIT 1
    `,
  );
  if (tableRows.length === 0) {
    return 0;
  }

  const [result] = await dbPool.query(
    `
      UPDATE jobs AS j
      INNER JOIN job_it_report AS r
        ON j.source_url COLLATE utf8mb4_unicode_ci = r.url COLLATE utf8mb4_unicode_ci
      SET j.listing_date = STR_TO_DATE(LEFT(r.listing_date, 10), '%Y-%m-%d')
      WHERE j.listing_date IS NULL
        AND r.listing_date IS NOT NULL
        AND CHAR_LENGTH(TRIM(r.listing_date)) >= 10
    `,
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

async function insertJobsWithDedup(dbPool: Pool, records: PreparedJobRecord[]): Promise<number> {
  let inserted = 0;

  for (const record of records) {
    if (!isITCategory(record.category)) {
      continue;
    }

    const [existingRows] = await dbPool.query<RowDataPacket[]>(
      "SELECT id FROM jobs WHERE title = ? AND source_url = ? LIMIT 1",
      [record.title, record.sourceUrl],
    );
    if (existingRows.length > 0) {
      if (record.listingDate) {
        await dbPool.query(
          `
            UPDATE jobs
            SET listing_date = COALESCE(listing_date, ?)
            WHERE id = ?
          `,
          [record.listingDate, existingRows[0].id],
        );
      }
      continue;
    }

    await dbPool.query(
      `
        INSERT INTO jobs (
          title,
          category,
          full_description,
          source_url,
          listing_date,
          tech_keywords,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.title,
        record.category,
        record.fullDescription,
        record.sourceUrl,
        record.listingDate,
        record.techKeywords.join(", "),
        record.createdAt,
      ],
    );
    inserted += 1;
  }

  return inserted;
}

async function runScraper(): Promise<void> {
  const { closeDbPool, dbPool } = await import("../lib/db");
  const browser = await chromium.launch({ headless: true });

  try {
    await ensureJobsTable(dbPool);
    console.log(
      `Scraper mode: resetJobs=${RESET_JOBS ? "true" : "false"}, deepDescriptionRefetch=${
        DEEP_DESCRIPTION_REFETCH ? "true" : "false"
      }, allowLiveFallback=${ALLOW_LIVE_FALLBACK ? "true" : "false"}`,
    );
    if (RESET_JOBS) {
      await dbPool.query("TRUNCATE TABLE jobs");
      console.log("jobs table truncated");
    }

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-NZ",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const reportSeeds = await loadSeedsFromJobItReport(dbPool);
    let liveSeeds: JobSeed[] = [];
    let liveLoadError: unknown = null;

    try {
      liveSeeds = await loadSeedsFromPagination(page);
    } catch (error) {
      liveLoadError = error;
      console.warn("live_failed_fallback_to_report", error);
    }

    const seeds = dedupeSeeds([...reportSeeds, ...liveSeeds]);
    console.log(
      `Merged seeds report=${reportSeeds.length}, live=${liveSeeds.length}, deduped=${seeds.length}`,
    );

    if (liveLoadError) {
      if (!ALLOW_LIVE_FALLBACK) {
        throw new Error(
          "Live search API failed and strict mode is enabled. Re-run with --allow-live-fallback to permit report-only ingestion.",
        );
      }
      if (reportSeeds.length > 0) {
        console.log("Live API failed, continue with job_it_report seeds only (--allow-live-fallback).");
      }
    }

    if (seeds.length === 0) {
      throw new Error("No seeds loaded from both report table and live search API fallback.");
    }

    const records = await buildPreparedRecords(context, seeds);
    console.log(`Prepared IT records: ${records.length}`);
    const repaired = await syncMissingListingDate(dbPool);
    if (repaired > 0) {
      console.log(`Backfilled listing_date for ${repaired} existing rows`);
    }

    records.slice(0, 3).forEach((item, index) => {
      console.log(`\n----- IT Job ${index + 1} Preview -----`);
      console.log(`Title: ${item.title}`);
      console.log(`Category: ${item.category}`);
      console.log(`Source URL: ${item.sourceUrl}`);
      console.log(`Tech Keywords: ${item.techKeywords.join(", ") || "(none)"}`);
      console.log(`Full Description: ${item.fullDescription.slice(0, 500)}`);
    });

    const inserted = await insertJobsWithDedup(dbPool, records);
    console.log(`成功入库 ${inserted} 条数据`);
  } catch (error) {
    console.error("Scraper failed:", error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await closeDbPool();
  }
}

void runScraper();
