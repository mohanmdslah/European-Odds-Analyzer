export const TARGETS = {
  live: "https://live.500.com",
  odds: "https://odds.500.com",
  liansai: "https://liansai.500.com",
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BATCH_MAX_REQUESTS = 24;
const BATCH_CONCURRENCY = 2;

export function isBatchProxyPath(url) {
  return new URL(url).pathname.endsWith("/batch");
}

export function getProxyRequestFromUrl(url) {
  const requestUrl = new URL(url);
  const markers = ["/.netlify/functions/proxy500/", "/proxy500/"];
  const marker = markers.find((item) => requestUrl.pathname.startsWith(item));
  const rest = marker ? requestUrl.pathname.slice(marker.length) : "";
  const [targetKey = "", ...pathParts] = rest.split("/").filter(Boolean);

  return {
    targetKey,
    path: `/${pathParts.join("/")}`,
    search: requestUrl.search,
  };
}

export function getProxyRequestFromTargetUrl(url) {
  const parsed = new URL(url);
  const targetKey = Object.entries(TARGETS)
    .find(([, target]) => new URL(target).hostname === parsed.hostname)?.[0] || "";

  if (!targetKey) throw new Error("Only 500.com proxy targets are allowed.");

  return {
    targetKey,
    path: parsed.pathname || "/",
    search: parsed.search,
  };
}

export function getUpstreamUrl(proxyRequest) {
  const target = TARGETS[proxyRequest.targetKey];
  if (!target) throw new Error("Unknown proxy target.");
  return `${target}${proxyRequest.path || "/"}${proxyRequest.search || ""}`;
}

export function buildUpstreamHeaders(target, path, search = "") {
  const isAjax = /\/fenxi1\//.test(path);
  const isJson = /\/fenxi1\/json\//.test(path);
  const targetHost = new URL(target).hostname;
  const referer = buildReferer(target, path, search);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    Referer: referer,
    Accept: isJson
      ? "application/json, text/javascript, */*; q=0.01"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Sec-Fetch-Site": isAjax ? "same-origin" : "none",
    "Sec-Fetch-Mode": isAjax ? "cors" : "navigate",
    "Sec-Fetch-Dest": isAjax ? "empty" : "document",
  };

  if (targetHost === "live.500.com") {
    headers.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    headers.Referer = "https://live.500.com/";
    headers["Cache-Control"] = "no-cache";
    headers.Pragma = "no-cache";
  }

  if (isAjax) headers["X-Requested-With"] = "XMLHttpRequest";
  return headers;
}

export async function fetchUpstream(url, headers, options = {}) {
  const attempts = options.attempts ?? 3;
  const cookieJar = options.cookieJar || new Map();
  let lastResponse;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      let response = await fetchWithOptionalCookie(url, headers, cookieJar);
      if (response.status === 403 && shouldWarmReferer(headers)) {
        const cookie = await getRefererCookie(headers.Referer, cookieJar);
        if (cookie) {
          await drainResponse(response);
          response = await fetch(url, {
            redirect: "follow",
            headers: { ...headers, Cookie: cookie },
          });
        }
      }

      if (!RETRYABLE_STATUS.has(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      await wait(350 * 2 ** attempt);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error("Upstream request failed.");
}

export async function fetchProxyBatch(payload = {}) {
  const inputRequests = Array.isArray(payload.requests) ? payload.requests : [];
  const requests = inputRequests.slice(0, BATCH_MAX_REQUESTS);
  const attempts = clampInteger(payload.attempts, 1, 4, 2);
  const concurrency = clampInteger(payload.concurrency, 1, 3, BATCH_CONCURRENCY);
  const cookieJar = new Map();
  const tasks = requests.map((request) => async () => fetchProxyBatchItem(request, attempts, cookieJar));
  return {
    items: await runLimited(tasks, concurrency),
  };
}

async function fetchProxyBatchItem(request, attempts, cookieJar) {
  const id = String(request?.id || "");
  const sourceUrl = String(request?.url || "");

  try {
    const proxyRequest = getProxyRequestFromTargetUrl(sourceUrl);
    const target = TARGETS[proxyRequest.targetKey];
    const upstreamUrl = getUpstreamUrl(proxyRequest);
    const upstream = await fetchUpstream(
      upstreamUrl,
      buildUpstreamHeaders(target, proxyRequest.path, proxyRequest.search),
      { attempts, cookieJar },
    );
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") || "text/html; charset=gb18030";

    return {
      id,
      url: sourceUrl,
      status: upstream.status,
      ok: upstream.ok,
      contentType,
      bodyBase64: buffer.toString("base64"),
      preview: buffer.toString("utf8", 0, Math.min(buffer.length, 180)).replace(/\s+/g, " ").trim(),
      error: "",
    };
  } catch (error) {
    return {
      id,
      url: sourceUrl,
      status: 0,
      ok: false,
      contentType: "",
      bodyBase64: "",
      error: error.message,
    };
  }
}

function buildReferer(target, path, search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const fixtureId = params.get("fid") || params.get("id") || "";

  if (fixtureId && /\/fenxi1\/(?:json\/)?ouzhi\.php/i.test(path)) {
    return `${target}/fenxi/ouzhi-${fixtureId}.shtml`;
  }
  if (fixtureId && /\/fenxi1\/(?:json\/)?bifa\.php/i.test(path)) {
    return `${target}/fenxi/bifa-${fixtureId}.shtml`;
  }
  if (fixtureId && /\/fenxi1\/(?:json\/)?touzhu\.php/i.test(path)) {
    return `${target}/fenxi/touzhu-${fixtureId}.shtml`;
  }
  if (fixtureId && /\/fenxi1\/(?:json\/)?yazhi\.php/i.test(path)) {
    return `${target}/fenxi/yazhi-${fixtureId}.shtml`;
  }
  if (fixtureId && /\/fenxi1\/(?:json\/)?daxiao\.php/i.test(path)) {
    return `${target}/fenxi/daxiao-${fixtureId}.shtml`;
  }

  return `${target}/`;
}

async function fetchWithOptionalCookie(url, headers, cookieJar) {
  const cookie = cookieJar.get(headers.Referer);
  return fetch(url, {
    redirect: "follow",
    headers: cookie ? { ...headers, Cookie: cookie } : headers,
  });
}

function shouldWarmReferer(headers) {
  return Boolean(headers?.Referer && /odds\.500\.com\/fenxi\//i.test(headers.Referer));
}

async function getRefererCookie(referer, cookieJar) {
  if (!referer) return "";
  const cached = cookieJar.get(referer);
  if (cached) return cached;

  try {
    const refererUrl = new URL(referer);
    const response = await fetch(referer, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Referer: `${refererUrl.origin}/`,
      },
    });
    const cookie = buildCookieHeader(readSetCookies(response.headers));
    await drainResponse(response);
    if (cookie) cookieJar.set(referer, cookie);
    return cookie;
  } catch {
    return "";
  }
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? value.split(/,(?=\s*[^;,]+=)/g) : [];
}

function buildCookieHeader(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function drainResponse(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // Ignore body drain failures.
  }
}

async function runLimited(tasks, limit) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
