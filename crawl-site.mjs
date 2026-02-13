import { mkdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const START_URL = process.argv[2] ?? "http://johnmayo.com";
const MAX_PAGES = Number(process.argv[3] ?? 2000);

const start = new URL(START_URL);
const origin = start.origin;

const normalizeUrl = (input, base) => {
  try {
    const url = new URL(input, base);
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    return url.toString();
  } catch {
    return null;
  }
};

const isHttp = (url) => url.startsWith("http://") || url.startsWith("https://");
const isInternal = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

const shouldIgnore = (value) => {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return v === "" || v.startsWith("#") || v.startsWith("javascript:") || v.startsWith("mailto:") || v.startsWith("tel:");
};

const uniq = (arr) => Array.from(new Set(arr)).sort();

const extractAttrUrls = (html, attrNames, baseUrl) => {
  const results = [];
  for (const attr of attrNames) {
    const re = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
    let match;
    while ((match = re.exec(html)) !== null) {
      const raw = match[2] ?? match[3] ?? match[4] ?? "";
      if (shouldIgnore(raw)) continue;
      const normalized = normalizeUrl(raw, baseUrl);
      if (normalized && isHttp(normalized)) {
        results.push(normalized);
      }
    }
  }
  return results;
};

const extractSrcsetUrls = (html, attrName, baseUrl) => {
  const results = [];
  const re = new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`, "gi");
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[2] ?? match[3] ?? "";
    const candidates = raw
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const candidate of candidates) {
      if (shouldIgnore(candidate)) continue;
      const normalized = normalizeUrl(candidate, baseUrl);
      if (normalized && isHttp(normalized)) {
        results.push(normalized);
      }
    }
  }
  return results;
};

const extractOnclickUrls = (html, baseUrl) => {
  const results = [];
  const onclickRe = /onclick\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = onclickRe.exec(html)) !== null) {
    const script = match[2] ?? match[3] ?? "";
    const urlRe = /(location(?:\.href)?\s*=\s*|window\.open\s*\(|document\.location\s*=\s*)["']([^"']+)["']/gi;
    let m2;
    while ((m2 = urlRe.exec(script)) !== null) {
      const raw = m2[2];
      if (shouldIgnore(raw)) continue;
      const normalized = normalizeUrl(raw, baseUrl);
      if (normalized && isHttp(normalized)) {
        results.push(normalized);
      }
    }
  }
  return results;
};

const extractClickableElements = (html) => {
  const counts = {
    anchorTags: 0,
    buttonTags: 0,
    roleButton: 0,
    onclickHandlers: 0,
    formTags: 0,
  };

  counts.anchorTags = (html.match(/<a\b/gi) ?? []).length;
  counts.buttonTags = (html.match(/<button\b/gi) ?? []).length;
  counts.roleButton = (html.match(/\brole\s*=\s*("button"|'button'|button)/gi) ?? []).length;
  counts.onclickHandlers = (html.match(/\bonclick\s*=/gi) ?? []).length;
  counts.formTags = (html.match(/<form\b/gi) ?? []).length;
  return counts;
};

const crawl = async () => {
  const toVisit = [normalizeUrl(start.toString(), start.toString())];
  const visited = new Set();

  const pages = [];
  const allInternalLinks = new Set();
  const allExternalLinks = new Set();
  const allImages = new Set();
  const allAssets = new Set();
  const allActionTargets = new Set();
  const failures = [];

  while (toVisit.length > 0 && visited.size < MAX_PAGES) {
    const current = toVisit.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let response;
    try {
      response = await fetch(current, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; CursorCrawler/1.0)" },
      });
    } catch (error) {
      failures.push({ url: current, error: String(error) });
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const finalUrl = normalizeUrl(response.url, current) ?? current;

    if (!contentType.toLowerCase().includes("text/html")) {
      allAssets.add(finalUrl);
      continue;
    }

    let html = "";
    try {
      html = await response.text();
    } catch (error) {
      failures.push({ url: finalUrl, error: String(error) });
      continue;
    }

    const linkTargets = [
      ...extractAttrUrls(html, ["href"], finalUrl),
      ...extractAttrUrls(html, ["action", "formaction"], finalUrl),
      ...extractAttrUrls(html, ["data-href", "data-url"], finalUrl),
      ...extractOnclickUrls(html, finalUrl),
    ];

    const imageTargets = [
      ...extractAttrUrls(html, ["src", "data-src", "poster"], finalUrl),
      ...extractSrcsetUrls(html, "srcset", finalUrl),
      ...extractSrcsetUrls(html, "data-srcset", finalUrl),
    ];

    const clickableCounts = extractClickableElements(html);

    const internalLinks = [];
    const externalLinks = [];

    for (const link of uniq(linkTargets)) {
      allActionTargets.add(link);
      if (isInternal(link)) {
        internalLinks.push(link);
        allInternalLinks.add(link);
        if (!visited.has(link) && !toVisit.includes(link)) {
          toVisit.push(link);
        }
      } else {
        externalLinks.push(link);
        allExternalLinks.add(link);
      }
    }

    const images = [];
    for (const asset of uniq(imageTargets)) {
      if (/\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?|heic|heif)(\?|$)/i.test(asset)) {
        images.push(asset);
        allImages.add(asset);
      }
      allAssets.add(asset);
    }

    pages.push({
      url: finalUrl,
      status: response.status,
      title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim(),
      internalLinks: uniq(internalLinks),
      externalLinks: uniq(externalLinks),
      images: uniq(images),
      assets: uniq(imageTargets),
      clickableCounts,
    });
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));

  const report = {
    startedAt: new Date().toISOString(),
    startUrl: start.toString(),
    origin,
    totals: {
      pagesCrawled: pages.length,
      internalLinksDiscovered: allInternalLinks.size,
      externalLinksDiscovered: allExternalLinks.size,
      actionTargetsDiscovered: allActionTargets.size,
      uniqueImagesDiscovered: allImages.size,
      uniqueAssetsDiscovered: allAssets.size,
      failures: failures.length,
    },
    pages,
    linkInventory: {
      internal: uniq([...allInternalLinks]),
      external: uniq([...allExternalLinks]),
      actionTargets: uniq([...allActionTargets]),
    },
    imageInventory: uniq([...allImages]),
    assetInventory: uniq([...allAssets]),
    failures,
  };

  await mkdir("crawl-output", { recursive: true });
  await writeFile("crawl-output/site-crawl-report.json", JSON.stringify(report, null, 2), "utf8");

  const markdown = [
    `# Crawl Report: ${start.toString()}`,
    "",
    `- Pages crawled: ${report.totals.pagesCrawled}`,
    `- Internal links discovered: ${report.totals.internalLinksDiscovered}`,
    `- External links discovered: ${report.totals.externalLinksDiscovered}`,
    `- Action targets discovered: ${report.totals.actionTargetsDiscovered}`,
    `- Unique images discovered: ${report.totals.uniqueImagesDiscovered}`,
    `- Unique assets discovered: ${report.totals.uniqueAssetsDiscovered}`,
    `- Failures: ${report.totals.failures}`,
    "",
    "## Pages",
    ...pages.map((p) => `- ${p.url} (${p.status}) - ${p.title || "No title"}`),
    "",
    "## Image Inventory",
    ...uniq([...allImages]).map((i) => `- ${i}`),
    "",
  ].join("\n");

  await writeFile("crawl-output/site-crawl-report.md", markdown, "utf8");
  console.log(`Crawl complete. Pages: ${pages.length}, Images: ${allImages.size}, Assets: ${allAssets.size}`);
};

crawl().catch((error) => {
  console.error(error);
  process.exit(1);
});
