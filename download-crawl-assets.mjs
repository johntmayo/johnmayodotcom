import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { URL } from "node:url";

const REPORT_PATH = "crawl-output/site-crawl-report.json";
const OUT_ROOT = "crawl-output/mirror";
const CONCURRENCY = Number(process.argv[2] ?? 10);

const sanitize = (value) => value.replace(/[<>:"|?*]/g, "_");

const toLocalPath = (rawUrl) => {
  const url = new URL(rawUrl);
  const host = sanitize(url.host);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  if (pathname === "") pathname = "/index.html";
  const ext = extname(pathname);
  const needsHtmlFallback = !ext && !url.search;
  const filePath = needsHtmlFallback ? `${pathname}.html` : pathname;
  let finalPath = join(OUT_ROOT, host, sanitize(filePath));
  if (url.search) {
    const q = sanitize(url.search.slice(1));
    finalPath = `${finalPath}__q_${q}`;
  }
  return finalPath;
};

const workerPool = async (items, worker, limit) => {
  const queue = [...items];
  const running = new Set();

  const launch = async () => {
    if (queue.length === 0) return;
    const item = queue.shift();
    const p = worker(item).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= limit) {
      await Promise.race(running);
    }
    await launch();
  };

  await launch();
  await Promise.all(running);
};

const main = async () => {
  const reportRaw = await readFile(REPORT_PATH, "utf8");
  const report = JSON.parse(reportRaw);

  const urls = new Set();
  for (const page of report.pages ?? []) {
    urls.add(page.url);
  }
  for (const asset of report.assetInventory ?? []) {
    urls.add(asset);
  }
  for (const target of report.linkInventory?.actionTargets ?? []) {
    urls.add(target);
  }

  const entries = [...urls].sort();
  let ok = 0;
  let failed = 0;
  const errors = [];

  await workerPool(
    entries,
    async (rawUrl) => {
      try {
        const response = await fetch(rawUrl, {
          redirect: "follow",
          headers: { "user-agent": "Mozilla/5.0 (compatible; CursorCrawler/1.0)" },
        });

        const finalUrl = response.url || rawUrl;
        const path = toLocalPath(finalUrl);
        await mkdir(dirname(path), { recursive: true });

        const bytes = new Uint8Array(await response.arrayBuffer());
        await writeFile(path, bytes);
        ok += 1;
      } catch (error) {
        failed += 1;
        errors.push({ url: rawUrl, error: String(error) });
      }
    },
    Math.max(1, CONCURRENCY),
  );

  await writeFile(
    "crawl-output/mirror-download-log.json",
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        totalRequested: entries.length,
        downloaded: ok,
        failed,
        errors,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Mirror download complete. Requested: ${entries.length}, Downloaded: ${ok}, Failed: ${failed}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
