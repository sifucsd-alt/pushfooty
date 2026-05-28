const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const FEEDS = require("./feeds");

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const MAX_ITEMS = 40;
const FEED_OUTPUT = path.join(__dirname, "../public/feed.json");
const CACHE_FILE = path.join(__dirname, "../public/summary-cache.json");

// ─── HTTP helper ───────────────────────────────────────────────────────────────
function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "PushFooty/1.0 RSS Reader" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── RSS parser (no dependencies) ─────────────────────────────────────────────
function parseRSS(xml, source, league) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = strip(extract(block, "title"));
    const url = strip(extract(block, "link") || extract(block, "guid"));
    const pubDate = strip(extract(block, "pubDate"));

    // Option 3: grab RSS description as fallback summary
    const rawDesc = strip(extract(block, "description"));
    const rssDesc = rawDesc ? rawDesc.split(/[.!?]/)[0].trim() + "." : "";

    if (!title || !url || url.includes("guid")) continue;
    if (title.length < 10) continue;

    items.push({
      title,
      url: url.startsWith("http") ? url : null,
      pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      source,
      league,
      rssDesc, // fallback — first sentence of RSS description
    });
  }

  return items.filter((i) => i.url).slice(0, 5);
}

function extract(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? (m[1] || m[2] || "").trim() : "";
}

function strip(str) {
  return str.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

// ─── Summary cache (Option 1 — generate once, keep forever) ───────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Cache load failed, starting fresh:", e.message);
  }
  return {};
}

function saveCache(cache) {
  // Keep cache from growing forever — only keep last 500 entries
  const keys = Object.keys(cache);
  if (keys.length > 500) {
    const trimmed = {};
    keys.slice(-500).forEach((k) => (trimmed[k] = cache[k]));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(trimmed));
    return;
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// Stable key from headline — used to look up cached summaries
function cacheKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
}

// ─── Claude API summary (only called for truly new headlines) ──────────────────
async function callClaude(newItems) {
  if (!CLAUDE_API_KEY) {
    console.warn("No CLAUDE_API_KEY — skipping AI summaries, using RSS fallback");
    return {};
  }

  if (newItems.length === 0) {
    console.log("  No new headlines need summaries.");
    return {};
  }

  console.log(`  Calling Claude for ${newItems.length} new headline(s)...`);

  const headlines = newItems.map((item, idx) => `${idx + 1}. ${item.title}`).join("\n");

  const prompt = `You are writing ultra-short sneak peek summaries for a football news feed called PushFooty.

For each headline below, write exactly 2 lines:
Line 1: The key person, club, or entity (name only — no fluff)
Line 2: One factual sentence, max 20 words, clinical tone, no adjectives

Rules:
- If the headline is vague (e.g. "Player on the move"), name the actual player on line 1
- Never start with "The" or repeat the headline
- No punctuation on line 1
- Output ONLY a JSON array, no markdown, no preamble

Format:
[{"id":1,"summary":"Name\\nOne factual sentence."},{"id":2,...}]

Headlines:
${headlines}`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  const summaryMap = {};
  try {
    const parsed = JSON.parse(response);
    if (parsed.error) {
      console.error("Claude API error:", parsed.error.message);
      return {};
    }
    const text = parsed.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    const summaries = JSON.parse(clean);
    summaries.forEach((s, idx) => {
      const key = cacheKey(newItems[s.id - 1]?.title || newItems[idx]?.title || "");
      if (key) summaryMap[key] = s.summary;
    });
  } catch (e) {
    console.error("Summary parse error:", e.message);
  }

  return summaryMap;
}

// ─── Deduplication ─────────────────────────────────────────────────────────────
function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = cacheKey(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[${new Date().toISOString()}] PushFooty feed engine starting...`);

  // Load existing summary cache
  const cache = loadCache();
  console.log(`  Cache loaded: ${Object.keys(cache).length} stored summaries`);

  // Fetch all RSS feeds
  let allItems = [];
  for (const feed of FEEDS) {
    try {
      console.log(`  Fetching: ${feed.source} (${feed.league})`);
      const xml = await fetch(feed.url);
      const items = parseRSS(xml, feed.source, feed.league);
      allItems = allItems.concat(items);
      console.log(`    → ${items.length} items`);
    } catch (e) {
      console.error(`  ✗ Failed: ${feed.source} — ${e.message}`);
    }
  }

  // Sort, dedupe, cap
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  allItems = dedupe(allItems).slice(0, MAX_ITEMS);
  console.log(`  Total after dedupe: ${allItems.length} items`);

  // Split into cached vs genuinely new (no summary yet)
  const needsSummary = [];
  allItems.forEach((item) => {
    const key = cacheKey(item.title);
    if (!cache[key]) needsSummary.push(item);
  });

  console.log(`  Already cached: ${allItems.length - needsSummary.length} | New: ${needsSummary.length}`);

  // ── HARD CAP: never send more than 10 headlines to Claude per run ──
  // Cost protection — even if cache is empty or broken, max 10 API calls.
  // Items over the cap fall back to RSS description automatically.
  const MAX_CLAUDE_PER_RUN = 10;
  const toSummarise = needsSummary.slice(0, MAX_CLAUDE_PER_RUN);
  const overCap = needsSummary.slice(MAX_CLAUDE_PER_RUN);

  if (overCap.length > 0) {
    console.warn(`  ⚠ Cap: ${overCap.length} item(s) over limit — RSS fallback used for those`);
  }

  // Call Claude only for capped batch
  if (toSummarise.length > 0) {
    console.log(`  Sending ${toSummarise.length} headline(s) to Claude (cap: ${MAX_CLAUDE_PER_RUN})`);
    const newSummaries = await callClaude(toSummarise);
    Object.assign(cache, newSummaries);
    saveCache(cache);
    console.log(`  Cache updated with ${Object.keys(newSummaries).length} new summaries`);
  }

  // Build final items — Claude summary > RSS description fallback > nothing
  const finalItems = allItems.map((item) => {
    const key = cacheKey(item.title);
    const summary = cache[key] || (item.rssDesc ? `\n${item.rssDesc}` : "");
    return {
      title: item.title,
      url: item.url,
      pubDate: item.pubDate,
      source: item.source,
      league: item.league,
      summary,
    };
  });

  const output = {
    updated: new Date().toISOString(),
    items: finalItems,
  };

  fs.writeFileSync(FEED_OUTPUT, JSON.stringify(output, null, 2));
  console.log(`  ✓ feed.json written with ${finalItems.length} items`);
  console.log(`[${new Date().toISOString()}] Done.`);
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
