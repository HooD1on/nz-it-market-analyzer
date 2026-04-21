import { config as loadEnv } from "dotenv";
import { Pool, RowDataPacket } from "mysql2/promise";
import { BrowserContext, chromium, Page } from "playwright";

const REPORT_URL = "https://me2link.com/job?selection=job-report&ppage=1";
const SEARCH_API_URL = "https://api.me2link.com/search";
const MAX_PAGE_SCAN_FALLBACK = 180;
const RESET_JOBS = process.argv.includes("--reset-jobs");

loadEnv({ path: ".env.local" });

type SearchListing = {
  title: string;
  url: string;
  short_description: string;
  classified_industry: string;
  classification: string;
  it_category: string;
};

type JobSeed = {
  title: string;
  url: string;
  shortDescription: string;
  htmlDescription: string;
  category: string;
  classification: string;
  itCategory: string;
};

type PreparedJobRecord = {
  title: string;
  category: string;
  fullDescription: string;
  sourceUrl: string;
  techKeywords: string[];
  createdAt: Date;
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
  const [rows] = await dbPool.query<RowDataPacket[]>(
    `
      SELECT
        title,
        url,
        COALESCE(short_description, '') AS short_description,
        COALESCE(description, '') AS description,
        COALESCE(classified_industry, '') AS classified_industry,
        COALESCE(classification, '') AS classification,
        COALESCE(it_category, '') AS it_category
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

async function fetchSearchPageFromBrowser(page: Page, pageNumber: number): Promise<SearchListing[]> {
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

      return (await response.json()) as { listings?: SearchListing[] };
    },
    { apiUrl: SEARCH_API_URL, pageNumber },
  );

  return result.listings ?? [];
}

async function loadSeedsFromPagination(page: Page): Promise<JobSeed[]> {
  await gotoRealJobList(page);
  const seeds: JobSeed[] = [];

  for (let pageNumber = 1; pageNumber <= MAX_PAGE_SCAN_FALLBACK; pageNumber += 1) {
    const listings = await fetchSearchPageFromBrowser(page, pageNumber);
    if (listings.length === 0) {
      break;
    }

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
      })),
    );
  }

  const deduped = dedupeSeeds(seeds);
  console.log(`Loaded IT seeds from pagination fallback: ${deduped.length}`);
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

    if (!fullDescription) {
      fullDescription = await refetchDescriptionBySelectors(context, seed.url);
    }

    if (!fullDescription) {
      console.log(`Skip empty description after selector retry: ${seed.url}`);
      continue;
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
      tech_keywords TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_title_source (title(255), source_url(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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
      continue;
    }

    await dbPool.query(
      `
        INSERT INTO jobs (title, category, full_description, source_url, tech_keywords, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        record.title,
        record.category,
        record.fullDescription,
        record.sourceUrl,
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

    let seeds = await loadSeedsFromJobItReport(dbPool);
    if (seeds.length === 0) {
      console.log("job_it_report is empty, switching to pagination fallback.");
      seeds = await loadSeedsFromPagination(page);
    }

    const records = await buildPreparedRecords(context, seeds);
    console.log(`Prepared IT records: ${records.length}`);

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
