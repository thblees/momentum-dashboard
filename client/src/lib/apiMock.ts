// Intercepts /api/trpc/* fetch calls and serves them from static JSON files
// generated daily by a GitHub Action. Replaces the Express/tRPC backend so the
// site can run as a static deploy on GitHub Pages.

type PricesFile = {
  prices: Record<string, number[]>;
  fetchedAt: string;
};

type VixFile = {
  value: number | null;
  change: number | null;
  changePercent: number | null;
  fetchedAt: string | null;
  error: string | null;
};

let pricesPromise: Promise<PricesFile> | null = null;
let vixPromise: Promise<VixFile> | null = null;

function dataUrl(name: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${base.endsWith("/") ? "" : "/"}data/${name}`;
}

function loadPrices(origFetch: typeof fetch): Promise<PricesFile> {
  if (!pricesPromise) {
    pricesPromise = origFetch(dataUrl("prices.json"))
      .then((r) => {
        if (!r.ok) throw new Error(`prices.json HTTP ${r.status}`);
        return r.json() as Promise<PricesFile>;
      })
      .catch((err) => {
        pricesPromise = null;
        throw err;
      });
  }
  return pricesPromise;
}

function loadVix(origFetch: typeof fetch): Promise<VixFile> {
  if (!vixPromise) {
    vixPromise = origFetch(dataUrl("vix.json"))
      .then((r) => {
        if (!r.ok) throw new Error(`vix.json HTTP ${r.status}`);
        return r.json() as Promise<VixFile>;
      })
      .catch((err) => {
        vixPromise = null;
        throw err;
      });
  }
  return vixPromise;
}

function jsonResponse(data: unknown): Response {
  // superjson-compatible tRPC envelope: { result: { data: { json: <data> } } }
  const body = JSON.stringify({ result: { data: { json: data } } });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(
  url: URL,
  init: RequestInit | undefined,
  origFetch: typeof fetch
): Promise<Response> {
  const path = url.pathname.replace(/^.*\/api\/trpc\//, "");
  const procedure = path.split(",")[0];

  let input: any = null;
  const rawInput = url.searchParams.get("input");
  if (rawInput) {
    try {
      const parsed = JSON.parse(rawInput);
      input = parsed?.json ?? parsed;
    } catch {
      /* ignore */
    }
  } else if (init?.body && typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body);
      input = parsed?.json ?? parsed;
    } catch {
      /* ignore */
    }
  }

  if (procedure === "market.getPrices" || procedure === "market.forceRefresh") {
    const tickers: string[] = Array.isArray(input?.tickers) ? input.tickers : [];
    const file = await loadPrices(origFetch);
    const out: Record<string, number[]> = {};
    for (const t of tickers) out[t] = file.prices[t] ?? [];
    const now = Date.now();
    return jsonResponse({
      prices: out,
      fromCache: true,
      fetchedAt: file.fetchedAt,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  if (procedure === "market.getCacheStatus") {
    const file = await loadPrices(origFetch);
    const ageMinutes = Math.max(
      0,
      Math.floor((Date.now() - new Date(file.fetchedAt).getTime()) / 60000)
    );
    return jsonResponse({
      cached: true,
      fetchedAt: file.fetchedAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ageMinutes,
    });
  }

  if (procedure === "market.getVix") {
    const file = await loadVix(origFetch);
    return jsonResponse(file);
  }

  return new Response(
    JSON.stringify({ error: { message: `Unknown procedure: ${procedure}` } }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}

export function installApiMock(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr =
      input instanceof Request
        ? input.url
        : typeof input === "string"
          ? input
          : input.toString();
    if (urlStr.includes("/api/trpc/")) {
      try {
        const url = new URL(urlStr, window.location.origin);
        return await handle(url, init, origFetch);
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: { message: err?.message ?? "mock failed" } }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    return origFetch(input as any, init);
  };
}
