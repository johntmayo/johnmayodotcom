import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const reportPath = path.join(ROOT, "crawl-output", "site-crawl-report.json");
const mirrorRoot = path.join(ROOT, "crawl-output", "mirror", "johnmayo.com");
const outputDataPath = path.join(ROOT, "src", "data", "pages.json");
const outputImagesDir = path.join(ROOT, "public", "images");

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const ensureDir = async (dir) => fs.mkdir(dir, { recursive: true });

const decodeEntities = (value = "") =>
  value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const normalizePagePath = (rawUrl) => {
  const url = new URL(rawUrl);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return "/";
  }
  return url.pathname;
};

const mapMirrorFilePath = (pagePath) => {
  if (pagePath === "/") {
    return path.join(mirrorRoot, "index.html");
  }
  return path.join(mirrorRoot, pagePath.slice(1));
};

const makeExcerpt = (html) => {
  const text = decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
  return text.slice(0, 260);
};

const cleanHtml = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s(on\w+)=(".*?"|'.*?'|[^\s>]+)/gi, "");

const pickMainContent = (html) => {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const tdMatches = [...body.matchAll(/<td[^>]*valign=["']?top["']?[^>]*>([\s\S]*?)<\/td>/gi)];
  if (tdMatches.length === 0) {
    return body;
  }

  let best = tdMatches[0][1];
  let bestScore = 0;
  for (const match of tdMatches) {
    const candidate = match[1];
    const textScore = candidate.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
    if (textScore > bestScore) {
      bestScore = textScore;
      best = candidate;
    }
  }
  return best;
};

const toPublicImagePath = (assetPath) => `/images/${path.basename(assetPath)}`;

const rewriteLinks = (html, knownPages) =>
  html.replace(/(href|src)=["']([^"']+)["']/gi, (full, attr, rawValue) => {
    const value = decodeEntities(rawValue.trim());

    if (
      value.startsWith("mailto:") ||
      value.startsWith("tel:") ||
      value.startsWith("#") ||
      value.startsWith("javascript:")
    ) {
      return `${attr}="${value}"`;
    }

    const asUrl = (() => {
      try {
        return new URL(value, "http://johnmayo.com/");
      } catch {
        return null;
      }
    })();

    if (!asUrl) {
      return `${attr}="${value}"`;
    }

    const isInternal = asUrl.hostname === "johnmayo.com" || asUrl.hostname === "www.johnmayo.com";
    if (!isInternal) {
      return `${attr}="${asUrl.toString()}"`;
    }

    const pathname = asUrl.pathname === "/index.html" ? "/" : asUrl.pathname;
    const ext = path.extname(pathname).toLowerCase();

    if (attr.toLowerCase() === "src" && imageExtensions.has(ext)) {
      return `${attr}="${toPublicImagePath(pathname)}"`;
    }

    if (attr.toLowerCase() === "href") {
      if (pathname === "/" || knownPages.has(pathname)) {
        return `${attr}="${pathname}"`;
      }
      if (imageExtensions.has(ext)) {
        return `${attr}="${toPublicImagePath(pathname)}"`;
      }
    }

    return `${attr}="${pathname}"`;
  });

const copyImage = async (imageUrl) => {
  const parsed = new URL(imageUrl);
  const source = path.join(mirrorRoot, parsed.pathname.slice(1));
  const destination = path.join(outputImagesDir, path.basename(parsed.pathname));
  try {
    await fs.copyFile(source, destination);
    return path.basename(parsed.pathname);
  } catch {
    return null;
  }
};

const main = async () => {
  await ensureDir(path.join(ROOT, "src", "data"));
  await ensureDir(outputImagesDir);

  const reportRaw = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(reportRaw);
  const pages = report.pages || [];

  const knownPages = new Set(pages.map((page) => normalizePagePath(page.url)));
  const copiedImages = new Set();

  for (const page of pages) {
    for (const image of page.images || []) {
      const copied = await copyImage(image);
      if (copied) copiedImages.add(copied);
    }
  }

  for (const asset of report.assetInventory || []) {
    try {
      const ext = path.extname(new URL(asset).pathname).toLowerCase();
      if (!imageExtensions.has(ext)) continue;
      const copied = await copyImage(asset);
      if (copied) copiedImages.add(copied);
    } catch {
      // Ignore malformed asset entries.
    }
  }

  const structuredPages = [];
  for (const page of pages) {
    const pagePath = normalizePagePath(page.url);
    const mirrorPath = mapMirrorFilePath(pagePath);
    let sourceHtml = "";

    try {
      sourceHtml = await fs.readFile(mirrorPath, "utf8");
    } catch {
      sourceHtml = `<p>Content for this page was not available in the mirror archive.</p>`;
    }

    const cleaned = cleanHtml(sourceHtml);
    const mainHtml = rewriteLinks(pickMainContent(cleaned), knownPages);
    const excerpt = makeExcerpt(mainHtml);
    const gallery = (page.images || [])
      .map((imageUrl) => path.basename(new URL(imageUrl).pathname))
      .filter((filename) => copiedImages.has(filename))
      .map((filename) => `/images/${filename}`);

    structuredPages.push({
      id: pagePath === "/" ? "home" : pagePath.slice(1).replaceAll("/", "-"),
      path: pagePath,
      status: page.status,
      title: decodeEntities(page.title || "Untitled"),
      excerpt,
      contentHtml: mainHtml,
      gallery,
      internalLinks: (page.internalLinks || []).map((link) => normalizePagePath(link))
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    totals: report.totals,
    pages: structuredPages
  };

  await fs.writeFile(outputDataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
