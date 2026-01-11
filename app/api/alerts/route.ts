import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ====== Polymarket trades 字段（够用即可） ====== */
type PMTrade = {
  proxyWallet: string;
  side: "BUY" | "SELL";
  title: string;
  outcome?: string;
  size: number;
  price: number;
  timestamp: number; // seconds or ms
  conditionId: string;
  transactionHash?: string;
};

type GammaMarket = {
  id?: string;
  conditionId?: string;
  events?: Array<{ id?: string | number }>;
  eventId?: string | number;
};

type GammaTag = {
  id?: string | number;
  label?: string;
  slug?: string;
};

/** ====== 你前端用的 Alert（增加 category/subcategory/tagSlugs） ====== */
type Alert = {
  id: string;
  walletAddress: string; // proxyWallet
  market: string;
  side: "BUY" | "SELL";
  amountUSD: number;
  timestamp: string;

  note: string;

  createdAt: string | null; // 合约部署时间

  // ✅ 板块信息
  category: string; // 主板块
  subcategory: string; // 子板块
  tagSlugs: string[]; // 调试用：该 event 的全部 tags slug
};

/** ====== 小工具 ====== */
function toIso(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

function cashUSD(size: number, price: number): number {
  const v = size * price;
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function tradeKey(t: PMTrade): string {
  if (t.transactionHash) return `tx:${t.transactionHash}`;
  return `f:${t.proxyWallet}|${t.timestamp}|${t.side}|${t.size}|${t.price}|${t.conditionId}`;
}

/** =========================
 *  A) 代理钱包创建时间 createdAt（你原来的逻辑）
 * ========================= */

/** ====== 缓存（内存 + 落盘） ====== */
const birthCache = new Map<string, { createdAtIso: string | null; cachedAtMs: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时
const NULL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FILE = path.join(process.cwd(), ".birthCache.json");

let cacheLoaded = false;
let flushTimer: NodeJS.Timeout | null = null;

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const text = await fs.readFile(CACHE_FILE, "utf-8");
    const obj = JSON.parse(text) as Record<
      string,
      { createdAtIso: string | null; cachedAtMs: number }
    >;
    for (const [k, v] of Object.entries(obj)) birthCache.set(k, v);
  } catch {
    // 第一次运行没有文件很正常
  }
}

function scheduleFlushCacheToDisk() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      const entries = Array.from(birthCache.entries()).slice(-5000);
      const obj: Record<string, { createdAtIso: string | null; cachedAtMs: number }> = {};
      for (const [k, v] of entries) obj[k] = v;
      await fs.writeFile(CACHE_FILE, JSON.stringify(obj), "utf-8");
    } catch (e) {
      console.error("flush cache failed:", e);
    }
  }, 800);
}

/** ====== Blockscout v2：按地址查 creation tx hash（更稳） ====== */
async function blockscoutV2CreationTxHash(addr: string): Promise<string | null> {
  try {
    const url = `https://polygon.blockscout.com/api/v2/addresses/${addr}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const j: any = await res.json();

    const tx =
      j?.creation_transaction_hash ??
      j?.creationTransactionHash ??
      j?.creation_tx_hash ??
      j?.creationTxHash ??
      null;

    return typeof tx === "string" && tx.startsWith("0x") ? tx : null;
  } catch {
    return null;
  }
}

/** ====== Blockscout 老接口兜底：getcontractcreation ====== */
async function blockscoutLegacyCreationTxHash(addr: string): Promise<string | null> {
  try {
    const url = new URL("https://polygon.blockscout.com/api");
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getcontractcreation");
    url.searchParams.set("contractaddresses", addr);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;

    const j: any = await res.json();
    const arr = Array.isArray(j?.result) ? j.result : [];
    const it = arr[0];

    const tx = it?.txHash ?? it?.txhash ?? it?.transactionHash ?? null;
    return typeof tx === "string" && tx.startsWith("0x") ? tx : null;
  } catch {
    return null;
  }
}

/** ====== Polygon RPC：基础调用 ====== */
async function rpc(method: string, params: any[]) {
  const rpcUrl = "https://polygon-rpc.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const j: any = await res.json();
  return j?.result;
}

/** ====== txHash -> block timestamp -> ISO ====== */
async function getCreatedAtISOFromCreationTx(txHash: string): Promise<string | null> {
  try {
    const tx = await rpc("eth_getTransactionByHash", [txHash]);
    const blockNumberHex = tx?.blockNumber;
    if (!blockNumberHex) return null;

    const block = await rpc("eth_getBlockByNumber", [blockNumberHex, false]);
    const tsHex = block?.timestamp;
    if (!tsHex) return null;

    const tsSec = parseInt(tsHex, 16);
    if (!Number.isFinite(tsSec)) return null;

    return new Date(tsSec * 1000).toISOString();
  } catch {
    return null;
  }
}

/** ====== 批量 enrich：createdAt（冷启动更稳：低并发 + 慢节奏 + 补查） ====== */
async function enrichCreatedAt(addresses: string[], maxUnique: number) {
  const uniq = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).slice(0, maxUnique);

  const now = Date.now();
  const resultMap = new Map<string, string | null>();

  const needFetch: string[] = [];
  for (const addr of uniq) {
    const cached = birthCache.get(addr);
    const ttl = cached?.createdAtIso ? CACHE_TTL_MS : NULL_CACHE_TTL_MS;

    if (cached && now - cached.cachedAtMs < ttl) {
      resultMap.set(addr, cached.createdAtIso);
    } else {
      needFetch.push(addr);
    }
  }

  const CONCURRENCY = 2;
  let idx = 0;

  async function worker() {
    while (idx < needFetch.length) {
      const myIdx = idx++;
      const addr = needFetch[myIdx];

      try {
        birthCache.set(addr, { createdAtIso: null, cachedAtMs: now });
        resultMap.set(addr, null);

        let creationTx = await blockscoutV2CreationTxHash(addr);
        if (!creationTx) creationTx = await blockscoutLegacyCreationTxHash(addr);

        if (!creationTx) {
          scheduleFlushCacheToDisk();
          await sleep(250);
          continue;
        }

        const createdAtIso = await getCreatedAtISOFromCreationTx(creationTx);
        birthCache.set(addr, { createdAtIso, cachedAtMs: now });
        resultMap.set(addr, createdAtIso);
        scheduleFlushCacheToDisk();

        await sleep(250);
      } catch {
        birthCache.set(addr, { createdAtIso: null, cachedAtMs: now });
        resultMap.set(addr, null);
        scheduleFlushCacheToDisk();
        await sleep(250);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const missing = needFetch.filter((a) => (resultMap.get(a) ?? null) === null);
  if (missing.length > 0) {
    const retryList = missing.slice(0, 30);
    for (const addr of retryList) {
      try {
        let tx = await blockscoutV2CreationTxHash(addr);
        if (!tx) tx = await blockscoutLegacyCreationTxHash(addr);
        if (!tx) {
          await sleep(300);
          continue;
        }

        const createdAtIso = await getCreatedAtISOFromCreationTx(tx);
        birthCache.set(addr, { createdAtIso, cachedAtMs: now });
        resultMap.set(addr, createdAtIso);
        scheduleFlushCacheToDisk();

        await sleep(300);
      } catch {
        await sleep(300);
      }
    }
  }

  scheduleFlushCacheToDisk();
  return resultMap; // addr -> createdAtIso|null
}

/** =========================
 *  B) 板块分类：conditionId -> market -> eventId -> tags
 * ========================= */

/** event tags 缓存（避免每次刷新都打 gamma） */
const eventTagCache = new Map<string, { tags: GammaTag[]; cachedAtMs: number }>();
const EVENT_TAG_TTL_MS = 6 * 60 * 60 * 1000; // 6小时

/** 用重复参数的方式请求：condition_ids=...&condition_ids=... */
async function gammaFetchMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarket[]> {
  if (conditionIds.length === 0) return [];

  const url = new URL("https://gamma-api.polymarket.com/markets");
  // ✅ 关键修复：condition_ids 是 string[]，用 append 传数组参数
  for (const cid of conditionIds) url.searchParams.append("condition_ids", cid);

  // limit/offset 是可选的，但加上更稳
  url.searchParams.set("limit", String(Math.min(100, conditionIds.length)));
  url.searchParams.set("offset", "0");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("gamma /markets failed:", res.status, t.slice(0, 400));
    return [];
  }

  const j = (await res.json()) as any;
  return Array.isArray(j) ? (j as GammaMarket[]) : [];
}

async function gammaFetchEventTags(eventId: string): Promise<GammaTag[]> {
  const now = Date.now();
  const cached = eventTagCache.get(eventId);
  if (cached && now - cached.cachedAtMs < EVENT_TAG_TTL_MS) return cached.tags;

  const url = `https://gamma-api.polymarket.com/events/${eventId}/tags`; // docs endpoint :contentReference[oaicite:1]{index=1}
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("gamma /events/{id}/tags failed:", eventId, res.status, t.slice(0, 200));
    eventTagCache.set(eventId, { tags: [], cachedAtMs: now });
    return [];
  }

  const j = (await res.json()) as any;
  const tags = Array.isArray(j) ? (j as GammaTag[]) : [];

  eventTagCache.set(eventId, { tags, cachedAtMs: now });
  return tags;
}

/** 主板块映射（你可以随时加/改） */
function pickMajorCategory(tagSlugs: string[]): string {
  const slugs = new Set(tagSlugs.map((s) => s.toLowerCase()));

  // 常见主板块（Polymarket 页面也常见这些）
  if (slugs.has("politics") || slugs.has("elections") || slugs.has("geopolitics")) return "Politics";
  if (slugs.has("crypto")) return "Crypto";
  if (slugs.has("sports")) return "Sports";
  if (slugs.has("business") || slugs.has("economy")) return "Business";
  if (slugs.has("culture") || slugs.has("entertainment")) return "Culture";
  if (slugs.has("science") || slugs.has("technology") || slugs.has("tech")) return "Tech/Science";

  return "Other";
}

/** 子板块：在 tags 里挑一个“更细的”slug */
function pickSubcategory(tagSlugs: string[], major: string): string {
  const MAJOR_SLUGS = new Set([
    "politics",
    "elections",
    "geopolitics",
    "crypto",
    "sports",
    "business",
    "economy",
    "culture",
    "entertainment",
    "science",
    "technology",
    "tech",
  ]);

  // 一些明显不适合作为“子板块”的通用标签
  const NOISE = new Set(["recurring", "monthly", "daily", "weekly", "featured", "new"]);

  const candidates = tagSlugs
    .map((s) => s.toLowerCase())
    .filter((s) => s && !MAJOR_SLUGS.has(s) && !NOISE.has(s));

  return candidates[0] ? candidates[0] : major;
}

/** conditionId -> (category/subcategory/tagSlugs) */
async function enrichCategoriesByConditionIds(conditionIds: string[]) {
  const uniq = Array.from(new Set(conditionIds.map((c) => c.toLowerCase())));
  const condTo = new Map<string, { category: string; subcategory: string; tagSlugs: string[] }>();

  // 分批请求 markets（避免 URL 过长）
  const CHUNK = 30;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);

    const markets = await gammaFetchMarketsByConditionIds(batch);

    // conditionId -> eventId
    const condToEventId = new Map<string, string>();

    for (const m of markets) {
      const cid = String(m?.conditionId ?? "").toLowerCase();
      if (!cid) continue;

      // eventId 可能在 m.events[0].id，也可能在 m.eventId
      const ev =
        m?.events?.[0]?.id ??
        m?.eventId ??
        null;

      if (ev !== null && ev !== undefined) {
        condToEventId.set(cid, String(ev));
      }
    }

    // 拉每个 event 的 tags（控制并发）
    const eventIds = Array.from(new Set(Array.from(condToEventId.values())));
    const CONCURRENCY = 4;
    let idx = 0;
    const eventIdToTagSlugs = new Map<string, string[]>();

    async function worker() {
      while (idx < eventIds.length) {
        const my = idx++;
        const eventId = eventIds[my];
        try {
          const tags = await gammaFetchEventTags(eventId);
          const slugs = tags
            .map((t) => String(t?.slug ?? "").trim())
            .filter(Boolean);

          eventIdToTagSlugs.set(eventId, slugs);
        } catch {
          eventIdToTagSlugs.set(eventId, []);
        }
        await sleep(80); // 稍微缓一缓
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // 回填到 conditionId
    for (const cid of batch) {
      const ev = condToEventId.get(cid);
      const tagSlugs = ev ? (eventIdToTagSlugs.get(ev) ?? []) : [];

      const major = pickMajorCategory(tagSlugs);
      const sub = pickSubcategory(tagSlugs, major);

      condTo.set(cid, { category: major, subcategory: sub, tagSlugs });
    }
  }

  return condTo;
}

/** =========================
 *  GET /api/alerts
 * ========================= */
export async function GET(req: Request) {
  try {
    await ensureCacheLoaded();

    const url = new URL(req.url);

    // ✅ 只拉 >= 10000 的现金成交；最多 30 条
    const MIN_CASH_USD = Number(url.searchParams.get("minCash") ?? 10000);
    const LIMIT = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") ?? 30)));

    // 1) 拉 Polymarket 真实 trades
    const pmUrl = new URL("https://data-api.polymarket.com/trades");
    pmUrl.searchParams.set("limit", String(LIMIT));
    pmUrl.searchParams.set("offset", "0");
    pmUrl.searchParams.set("takerOnly", "true");
    pmUrl.searchParams.set("filterType", "CASH");
    pmUrl.searchParams.set("filterAmount", String(MIN_CASH_USD));

    const res = await fetch(pmUrl.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Polymarket Data API error: ${res.status}`, detail: text.slice(0, 300) },
        { status: 502 }
      );
    }

    const trades = (await res.json()) as PMTrade[];
    if (!Array.isArray(trades) || trades.length === 0) {
      return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
    }

    const seen = new Set<string>();
    const uniqTrades: PMTrade[] = [];
    for (const t of trades) {
      const key = tradeKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqTrades.push(t);
    }

    if (uniqTrades.length === 0) {
      return NextResponse.json([], { headers: { "Cache-Control": "no-store" } });
    }

    // 2) 先映射成 Alert（createdAt / category 先占位）
    const rawAlerts: Alert[] = uniqTrades.map((t, i) => {
      const tsIso = toIso(t.timestamp);
      const marketLabel = t.outcome ? `${t.title} — ${t.outcome}` : t.title;

      const id = t.transactionHash
        ? `${t.transactionHash}-${i}`
        : `${t.proxyWallet}-${t.timestamp}-${i}`;

      return {
        id,
        walletAddress: t.proxyWallet,
        market: marketLabel,
        side: t.side,
        amountUSD: cashUSD(t.size, t.price),
        timestamp: tsIso,

        note: `cond:${t.conditionId}`,

        createdAt: null,

        category: "Other",
        subcategory: "Other",
        tagSlugs: [],
      };
    });

    // 3) 批量查 代理钱包创建时间 createdAt
    const addrList = rawAlerts.map((a) => a.walletAddress);
    const conditionIds = uniqTrades.map((t) => t.conditionId);
    const [createdMap, condToCat] = await Promise.all([
      enrichCreatedAt(addrList, 100),
      enrichCategoriesByConditionIds(conditionIds),
    ]);

    const enriched = rawAlerts.map((a, idx) => {
      const trade = uniqTrades[idx];
      const createdAt = createdMap.get(a.walletAddress.toLowerCase()) ?? null;

      const catInfo = condToCat.get(String(trade.conditionId).toLowerCase());

      return {
        ...a,
        createdAt,

        category: catInfo?.category ?? "Other",
        subcategory: catInfo?.subcategory ?? "Other",
        tagSlugs: catInfo?.tagSlugs ?? [],
      };
    });

    return NextResponse.json(enriched, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    console.error("GET /api/alerts crashed:", e);
    return NextResponse.json(
      { error: "Internal error in /api/alerts", detail: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
