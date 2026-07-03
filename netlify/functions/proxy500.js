import {
  TARGETS,
  buildUpstreamHeaders,
  fetchProxyBatch,
  fetchUpstream,
  getProxyRequestFromUrl,
  getUpstreamUrl,
  isBatchProxyPath,
} from "../../proxy500.shared.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
};

export default async function proxy500(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (request.method === "POST" && isBatchProxyPath(request.url)) {
    try {
      return jsonResponse(200, await fetchProxyBatch(await request.json()));
    } catch (error) {
      return textResponse(400, `Invalid batch request: ${error.message}`);
    }
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return textResponse(405, "Method not allowed.");
  }

  try {
    const proxyRequest = getProxyRequestFromUrl(request.url);
    const target = TARGETS[proxyRequest.targetKey];
    if (!target) return textResponse(400, "Unknown proxy target.");

    const upstream = await fetchUpstream(
      getUpstreamUrl(proxyRequest),
      buildUpstreamHeaders(target, proxyRequest.path, proxyRequest.search),
    );
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

function jsonResponse(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
