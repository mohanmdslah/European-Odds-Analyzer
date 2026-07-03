import {
  TARGETS,
  buildUpstreamHeaders,
  fetchProxyBatch,
  fetchUpstream,
  getProxyRequestFromUrl,
  getUpstreamUrl,
  isBatchProxyPath,
} from "../shared/proxy500Shared.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
};

export async function handler(event) {
  const method = event.httpMethod || "GET";
  const requestUrl = getEventUrl(event);

  if (method === "GET" && requestUrl.pathname.endsWith("/_health")) {
    return jsonResponse(200, {
      ok: true,
      runtime: "netlify-functions",
      path: requestUrl.pathname,
    });
  }

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  if (method === "POST" && isBatchProxyPath(requestUrl.href)) {
    try {
      return jsonResponse(200, await fetchProxyBatch(readJsonBody(event)));
    } catch (error) {
      return textResponse(400, `Invalid batch request: ${error.message}`);
    }
  }

  if (!["GET", "HEAD"].includes(method)) {
    return textResponse(405, "Method not allowed.");
  }

  try {
    const proxyRequest = getProxyRequestFromUrl(requestUrl.href);
    const target = TARGETS[proxyRequest.targetKey];
    if (!target) return textResponse(400, "Unknown proxy target.");

    const upstream = await fetchUpstream(
      getUpstreamUrl(proxyRequest),
      buildUpstreamHeaders(target, proxyRequest.path, proxyRequest.search),
    );
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const isHead = method === "HEAD";

    return {
      statusCode: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") || "text/html; charset=gb18030",
      },
      isBase64Encoded: !isHead,
      body: isHead ? "" : buffer.toString("base64"),
    };
  } catch (error) {
    return textResponse(502, `Proxy request failed: ${error.message}`);
  }
}

function getEventUrl(event) {
  if (event.rawUrl) return new URL(event.rawUrl);

  const host = event.headers?.host || event.headers?.Host || "localhost";
  const rawQuery = event.rawQuery
    || (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : "");
  const query = rawQuery ? `?${rawQuery}` : "";
  return new URL(`https://${host}${event.path || ""}${query}`);
}

function readJsonBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "{}";
  return JSON.parse(body || "{}");
}

function textResponse(statusCode, message) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: message,
  };
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}
