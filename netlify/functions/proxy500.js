const TARGETS = {
  live: "https://live.500.com",
  odds: "https://odds.500.com",
  liansai: "https://liansai.500.com",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
};

export default async function proxy500(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return textResponse(405, "Method not allowed.");
  }

  try {
    const proxyRequest = getProxyRequest(request.url);
    const target = TARGETS[proxyRequest.targetKey];
    if (!target) return textResponse(400, "Unknown proxy target.");

    const upstreamUrl = `${target}${proxyRequest.path}${proxyRequest.search}`;
    const upstream = await fetchUpstream(upstreamUrl, buildUpstreamHeaders(target, proxyRequest.path));
    const isHead = request.method === "HEAD";

    return new Response(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") || "text/html; charset=gb18030",
      },
    });
  } catch (error) {
    return textResponse(502, `Proxy request failed: ${error.message}`);
  }
}

function getProxyRequest(url) {
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

function buildUpstreamHeaders(target, path) {
  const isAjax = /\/fenxi1\//.test(path);
  const isJson = /\/fenxi1\/json\//.test(path);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    Referer: `${target}/`,
    Accept: isJson
      ? "application/json, text/javascript, */*; q=0.01"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  if (isAjax) headers["X-Requested-With"] = "XMLHttpRequest";
  return headers;
}

async function fetchUpstream(url, headers, attempts = 3) {
  let lastResponse;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers,
      });
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 350 * 2 ** attempt));
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error("Upstream request failed.");
}

function textResponse(statusCode, message) {
  return new Response(message, {
    status: statusCode,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
