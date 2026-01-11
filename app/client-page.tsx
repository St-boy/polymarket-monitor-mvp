"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Alert = {
  id: string;
  walletAddress: string;
  market: string;
  side: "BUY" | "SELL";
  amountUSD: number;
  timestamp: string;

  isNewWallet: boolean;
  firstSeen: string;
  createdAt: string | null;

  // 板块（主/子）+ tags
  category: string; // slug: politics/crypto/...
  subcategory: string; // slug: bitcoin/...
  tags: string[]; // from backend tagSlugs
};

type FilterMode = "ALL"; // ✅ 只保留 ALL
type SortMode = "TIME_DESC" | "TIME_ASC" | "AMOUNT_DESC" | "AMOUNT_ASC";
type WalletAgeMode = "ANY" | "1D" | "7D" | "30D";

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function includesCI(hay: string, needle: string) {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function safeTime(iso: string) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function toSortMode(v: string | null): SortMode {
  if (v === "TIME_DESC" || v === "TIME_ASC" || v === "AMOUNT_DESC" || v === "AMOUNT_ASC") {
    return v;
  }
  return "TIME_DESC";
}

function toWalletAgeMode(v: string | null): WalletAgeMode {
  if (v === "ANY" || v === "1D" || v === "7D" || v === "30D") return v;
  return "ANY";
}

function parseNumOrUndefined(v: string) {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseWatchlist(v: string | null): Set<string> {
  if (!v) return new Set();
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(parts);
}

function normalizeCat(raw: any): string {
  const s = String(raw ?? "other").trim().toLowerCase();
  if (!s) return "other";

  if (s === "politics") return "politics";
  if (s === "crypto") return "crypto";
  if (s === "sports") return "sports";
  if (s === "business" || s === "economy" || s === "finance") return s;
  if (s === "culture") return "culture";
  if (s === "world") return "world";
  if (s.includes("tech") || s.includes("science")) return "technology";
  if (s === "other") return "other";

  return s;
}

function catLabel(slug: string) {
  switch (slug) {
    case "politics":
      return "政治";
    case "economy":
      return "经济";
    case "finance":
      return "金融";
    case "business":
      return "商业";
    case "crypto":
      return "加密";
    case "sports":
      return "体育";
    case "culture":
      return "文化";
    case "technology":
      return "科技/科学";
    case "world":
      return "国际";
    case "other":
    default:
      return "其他";
  }
}

const TOP_CATS: { slug: string; label: string }[] = [
  { slug: "politics", label: "政治" },
  { slug: "economy", label: "经济" },
  { slug: "finance", label: "金融" },
  { slug: "business", label: "商业" },
  { slug: "crypto", label: "加密" },
  { slug: "sports", label: "体育" },
  { slug: "culture", label: "文化" },
  { slug: "technology", label: "科技/科学" },
  { slug: "world", label: "国际" },
  { slug: "other", label: "其他" },
];

const cx = (...xs: Array<string | false | undefined | null>) => xs.filter(Boolean).join(" ");

function pill(active: boolean) {
  return cx(
    "px-3 py-2 rounded-full border text-sm transition select-none",
    "hover:opacity-90",
    active ? "bg-black text-white border-black" : "bg-white/70 border-black/15"
  );
}

function ghostBtn() {
  return "px-3 py-2 rounded-full border border-black/15 text-sm bg-white/70 hover:opacity-90 transition";
}

function inputCls() {
  return "px-3 py-2 rounded-full border border-black/15 text-sm bg-white/70 outline-none focus:border-black/30 w-full";
}

function selectCls() {
  return "px-3 py-2 rounded-full border border-black/15 text-sm bg-white/70 outline-none focus:border-black/30";
}

function badgeCls() {
  return "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-black/15 text-xs bg-white/70";
}

export default function Page() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [data, setData] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [apiError, setApiError] = useState<string>("");
  const [latestTradeTime, setLatestTradeTime] = useState<string>("");

  // ✅ 只保留 ALL
  const [filter, setFilter] = useState<FilterMode>(() => "ALL");
  const [sort, setSort] = useState<SortMode>(() => toSortMode(sp.get("sort")));
  const [query, setQuery] = useState<string>(() => sp.get("q") ?? "");

  const [walletAge, setWalletAge] = useState<WalletAgeMode>(() => toWalletAgeMode(sp.get("age")));
  const [minAmount, setMinAmount] = useState<string>(() => sp.get("min") ?? "");
  const [maxAmount, setMaxAmount] = useState<string>(() => sp.get("max") ?? "");

  const [watchlist, setWatchlist] = useState<Set<string>>(() => parseWatchlist(sp.get("wl")));
  const [watchOnly, setWatchOnly] = useState<boolean>(() => sp.get("watch") === "1");

  const [cat, setCat] = useState<string>(() => sp.get("cat") ?? "ALL");
  const [sub, setSub] = useState<string>(() => sp.get("sub") ?? "ALL");

  const didInit = useRef(false);

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  async function load(force = false) {
    if (inFlight.current) {
      if (!force) return;
      abortRef.current?.abort();
    }

    inFlight.current = true;
    setLoading(true);
    setApiError("");

    const ac = new AbortController();
    abortRef.current = ac;

    const timeout = setTimeout(() => {
      try {
        ac.abort();
      } catch {}
    }, 20_000);

    try {
      const res = await fetch(`/api/alerts?t=${Date.now()}`, {
        cache: "no-store",
        signal: ac.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        setApiError(`API 返回错误：${res.status}（打开控制台看详情）`);
        console.error("API /api/alerts error:", res.status, text.slice(0, 600));
        return;
      }

      if (!text.trim()) {
        setApiError("API 返回空内容（可能被中断/超时）");
        console.error("API /api/alerts returned EMPTY body");
        return;
      }

      let raw: any[];
      try {
        raw = JSON.parse(text) as any[];
      } catch (e) {
        setApiError("解析 JSON 失败（返回内容被截断/中断）");
        console.error("JSON parse failed:", e, text.slice(0, 600));
        return;
      }

      const normalized: Alert[] = (Array.isArray(raw) ? raw : []).map((r: any) => {
        const tags: string[] = Array.isArray(r?.tagSlugs)
          ? r.tagSlugs
          : Array.isArray(r?.tags)
          ? r.tags
          : [];

        const category = normalizeCat(r?.category);

        const subcategory =
          (typeof r?.subcategory === "string" && r.subcategory.trim()) ||
          tags.find((t) => t && t !== category) ||
          "other";

        return {
          id: String(r?.id ?? ""),
          walletAddress: String(r?.walletAddress ?? ""),
          market: String(r?.market ?? ""),
          side: r?.side === "BUY" || r?.side === "SELL" ? r.side : "BUY",
          amountUSD: Number(r?.amountUSD ?? 0),
          timestamp: String(r?.timestamp ?? ""),

          isNewWallet: Boolean(r?.isNewWallet),
          firstSeen: String(r?.firstSeen ?? ""),
          createdAt: r?.createdAt ? String(r.createdAt) : null,

          category,
          subcategory: String(subcategory),
          tags: tags.map((x) => String(x)).filter(Boolean),
        };
      });

      setData(normalized);

      const now = new Date();
      setLastUpdated(now.toLocaleString());

      const newest = normalized?.[0]?.timestamp ?? "";
      setLatestTradeTime(newest ? formatDate(newest) : "");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setApiError("请求超时/被中断（20秒）");
        return;
      }
      setApiError("请求失败（打开控制台看详情）");
      console.error("load() failed:", e);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      inFlight.current = false;
    }
  }

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(false), 60_000);
    return () => {
      clearInterval(t);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL 同步（刷新不丢 / 可分享）
  useEffect(() => {
    if (!didInit.current) {
      didInit.current = true;
      return;
    }

    const p = new URLSearchParams();

    // ✅ filter 永远是 ALL，所以不写入
    if (sort !== "TIME_DESC") p.set("sort", sort);

    const q = query.trim();
    if (q) p.set("q", q);

    if (walletAge !== "ANY") p.set("age", walletAge);

    const min = parseNumOrUndefined(minAmount);
    const max = parseNumOrUndefined(maxAmount);
    if (min !== undefined) p.set("min", String(min));
    if (max !== undefined) p.set("max", String(max));

    const wl = Array.from(watchlist);
    if (wl.length > 0) p.set("wl", wl.join(","));

    if (watchOnly) p.set("watch", "1");

    if (cat !== "ALL") p.set("cat", cat);
    if (sub !== "ALL") p.set("sub", sub);

    const next = p.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [sort, query, walletAge, minAmount, maxAmount, watchlist, watchOnly, cat, sub, pathname, router]);

  const subOptions = useMemo(() => {
    if (cat === "ALL") return [];
    const base = data.filter((r) => (r.category ?? "other") === cat);
    const freq = new Map<string, number>();
    for (const r of base) {
      for (const t of r.tags ?? []) {
        if (!t) continue;
        if (t === cat) continue;
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([slug, count]) => ({ slug, count }));
  }, [data, cat]);

  const rows = useMemo(() => {
    let list = data;

    if (watchOnly) list = list.filter((r) => watchlist.has(r.walletAddress));

    if (cat !== "ALL") list = list.filter((r) => (r.category ?? "other") === cat);

    if (cat !== "ALL" && sub !== "ALL") {
      list = list.filter((r) => Array.isArray(r.tags) && r.tags.includes(sub));
    }

    if (walletAge !== "ANY") {
      const days = walletAge === "1D" ? 1 : walletAge === "7D" ? 7 : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      list = list.filter((r) => r.createdAt && safeTime(r.createdAt) >= cutoff);
    }

    const min = parseNumOrUndefined(minAmount);
    const max = parseNumOrUndefined(maxAmount);
    if (min !== undefined) list = list.filter((r) => r.amountUSD >= min);
    if (max !== undefined) list = list.filter((r) => r.amountUSD <= max);

    const q = query.trim();
    if (q) {
      list = list.filter((r) => {
        const tagsStr = Array.isArray(r.tags) ? r.tags.join(",") : "";
        return (
          includesCI(r.walletAddress, q) ||
          includesCI(r.market, q) ||
          includesCI(String(r.side), q) ||
          includesCI(String(r.category ?? ""), q) ||
          includesCI(tagsStr, q)
        );
      });
    }

    const sorted = [...list];
    sorted.sort((a, b) => {
      const aw = watchlist.has(a.walletAddress);
      const bw = watchlist.has(b.walletAddress);
      if (aw !== bw) return aw ? -1 : 1;

      if (sort === "TIME_DESC") return safeTime(b.timestamp) - safeTime(a.timestamp);
      if (sort === "TIME_ASC") return safeTime(a.timestamp) - safeTime(b.timestamp);
      if (sort === "AMOUNT_DESC") return b.amountUSD - a.amountUSD;
      if (sort === "AMOUNT_ASC") return a.amountUSD - b.amountUSD;
      return 0;
    });

    return sorted;
  }, [data, watchOnly, watchlist, cat, sub, walletAge, minAmount, maxAmount, query, sort]);

  function toggleWatch(addr: string) {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  const watchCount = watchlist.size;

  return (
    <main className="min-h-screen p-6 bg-gradient-to-b from-black/[0.03] to-transparent overflow-x-hidden">
      <div className="mx-auto w-full max-w-[1600px]">
        {/* 顶部标题 */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Polymarket 监控面板</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-80">
              <span className={badgeCls()}>自动刷新：60s</span>
              {lastUpdated ? <span className={badgeCls()}>最后更新：{lastUpdated}</span> : null}
              {latestTradeTime ? <span className={badgeCls()}>最新交易时间：{latestTradeTime}</span> : null}
              <span className={badgeCls()}>当前显示：{rows.length} 条</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => load(true)}
              className={cx(
                "px-4 py-2 rounded-full border text-sm transition",
                "border-black/15 bg-white hover:opacity-90",
                loading && "opacity-60 cursor-not-allowed"
              )}
              disabled={loading}
              title="立即刷新（强制）"
            >
              {loading ? "刷新中..." : "手动刷新"}
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {apiError ? (
          <div className="mb-4 rounded-2xl border border-black/10 bg-white p-4">
            <div className="font-semibold text-sm">请求提示</div>
            <div className="text-sm opacity-80 mt-1">{apiError}</div>
            <div className="mt-3">
              <button className={ghostBtn()} onClick={() => load(true)}>
                立即重试（强制）
              </button>
            </div>
          </div>
        ) : null}

        {/* 控制面板 */}
        <div className="rounded-2xl border border-black/10 bg-white p-4 mb-4">
          {/* 第一行：只保留“全部”，删除 High/New */}
          <div className="flex flex-wrap items-center gap-2">
            <button className={pill(true)} onClick={() => setFilter("ALL")}>
              全部 <span className="opacity-70">({data.length})</span>
            </button>

            <div className="ml-auto flex flex-wrap items-center gap-2 w-full sm:w-auto">
              {/* 主板块 */}
              <select
                value={cat}
                onChange={(e) => {
                  const next = e.target.value;
                  setCat(next);
                  setSub("ALL");
                }}
                className={selectCls()}
                title="主板块"
              >
                <option value="ALL">全部板块</option>
                {TOP_CATS.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>

              {/* 子板块 */}
              <select
                value={sub}
                onChange={(e) => setSub(e.target.value)}
                className={cx(selectCls(), "max-w-[280px]")}
                title="子板块（标签）"
                disabled={cat === "ALL"}
              >
                <option value="ALL">{cat === "ALL" ? "先选主板块" : "全部子板块"}</option>
                {subOptions.map((x) => (
                  <option key={x.slug} value={x.slug}>
                    {x.slug} ({x.count})
                  </option>
                ))}
              </select>

              {/* 排序 */}
              <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} className={selectCls()}>
                <option value="TIME_DESC">时间：最新优先</option>
                <option value="TIME_ASC">时间：最旧优先</option>
                <option value="AMOUNT_DESC">金额：从大到小</option>
                <option value="AMOUNT_ASC">金额：从小到大</option>
              </select>

              {/* 搜索 */}
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索：钱包 / 市场 / BUY/SELL / 板块 / 标签"
                  className={cx(inputCls(), "sm:w-[360px]")}
                />
                {query.trim() ? (
                  <button className={ghostBtn()} onClick={() => setQuery("")} title="清空搜索">
                    清空
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* 第二行：钱包时间 + 金额（删除 ≥10k/≥50k） + 关注 */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm opacity-70">钱包创建时间</span>
              <select
                value={walletAge}
                onChange={(e) => setWalletAge(e.target.value as WalletAgeMode)}
                className={selectCls()}
              >
                <option value="ANY">全部</option>
                <option value="1D">最近 24 小时</option>
                <option value="7D">最近 7 天</option>
                <option value="30D">最近 30 天</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm opacity-70">金额</span>
              <input
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="最小"
                inputMode="numeric"
                className={cx(inputCls(), "w-[120px]")}
              />
              <span className="text-sm opacity-50">-</span>
              <input
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="最大"
                inputMode="numeric"
                className={cx(inputCls(), "w-[120px]")}
              />

              {(minAmount.trim() || maxAmount.trim()) && (
                <button
                  className={ghostBtn()}
                  onClick={() => {
                    setMinAmount("");
                    setMaxAmount("");
                  }}
                >
                  清空金额
                </button>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button className={ghostBtn()} onClick={() => setWatchOnly((v) => !v)}>
                {watchOnly ? "✅ 只看关注" : "只看关注"}
              </button>
              <span className={badgeCls()}>关注：{watchCount}</span>
              {watchCount > 0 ? (
                <button className={ghostBtn()} onClick={() => setWatchlist(new Set())}>
                  清空关注
                </button>
              ) : null}
            </div>

            <div className="w-full text-xs opacity-70">
              提示：筛选/搜索/排序/关注/板块都会写入 URL（刷新不丢、可复制分享）
            </div>
          </div>
        </div>

        {/* 表格：✅ 不要横向滚轮 -> 不用 overflow-auto + 不设 min-w；用换行显示 */}
        <div className="rounded-2xl border border-black/10 bg-white overflow-hidden">
          <div className="p-2">
            <table className="w-full text-sm table-auto">
              <thead className="bg-black/[0.03]">
                <tr>
                  <th className="text-left p-3">关注</th>
                  <th className="text-left p-3">钱包地址</th>
                  <th className="text-left p-3">板块</th>
                  <th className="text-left p-3">子板块(标签)</th>
                  <th className="text-left p-3">市场</th>
                  <th className="text-left p-3">方向</th>
                  <th className="text-left p-3">金额(USD)</th>
                  <th className="text-left p-3">交易时间</th>
                  <th className="text-left p-3">新钱包</th>
                  <th className="text-left p-3">钱包创建时间</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((r) => {
                  const watched = watchlist.has(r.walletAddress);
                  const tags = Array.isArray(r.tags) ? r.tags : [];

                  return (
                    <tr key={r.id} className={cx("border-t border-black/5", watched && "bg-black/[0.03]")}>
                      <td className="p-3 align-top">
                        <button
                          className={cx(
                            "px-3 py-1.5 rounded-full border text-sm transition",
                            watched ? "bg-black text-white border-black" : "bg-white/70 border-black/15 hover:opacity-90"
                          )}
                          onClick={() => toggleWatch(r.walletAddress)}
                        >
                          {watched ? "★ 已关注" : "☆ 关注"}
                        </button>
                      </td>

                      {/* ✅ 地址允许换行（避免撑出横向滚动） */}
                      <td className="p-3 align-top font-mono text-xs break-all max-w-[220px]">
                        {r.walletAddress}
                      </td>

                      <td className="p-3 align-top whitespace-nowrap">{catLabel(r.category ?? "other")}</td>

                      {/* ✅ 标签允许换行 */}
                      <td className="p-3 align-top break-words max-w-[260px]">
                        {tags.length ? tags.join(", ") : "-"}
                      </td>

                      {/* ✅ 市场允许换行 */}
                      <td className="p-3 align-top break-words max-w-[520px]">{r.market}</td>

                      <td className="p-3 align-top whitespace-nowrap">
                        <span className={badgeCls()}>{r.side}</span>
                      </td>

                      {/* ✅ 去掉 High 标签，只显示金额 */}
                      <td className="p-3 align-top whitespace-nowrap">{r.amountUSD.toLocaleString()}</td>

                      <td className="p-3 align-top whitespace-nowrap">{formatDate(r.timestamp)}</td>

                      {/* ✅ 去掉 New 标签，只显示 true/false（或你想改成 是/否） */}
                      <td className="p-3 align-top whitespace-nowrap">{String(r.isNewWallet)}</td>

                      <td className="p-3 align-top whitespace-nowrap">{r.createdAt ? formatDate(r.createdAt) : "-"}</td>
                    </tr>
                  );
                })}

                {rows.length === 0 && !loading ? (
                  <tr>
                    <td className="p-8 opacity-70" colSpan={10}>
                      没有匹配的数据（调整筛选/金额/搜索/板块，或点“手动刷新”）
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 text-xs opacity-70 border-t border-black/10">
            测试接口：<span className="font-mono">/api/alerts</span>
          </div>
        </div>
      </div>
    </main>
  );
}
