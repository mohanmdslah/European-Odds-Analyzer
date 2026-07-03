import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
  TARGETS,
  buildUpstreamHeaders,
  fetchProxyBatch,
  fetchUpstream,
  getProxyRequestFromUrl,
  getUpstreamUrl,
  isBatchProxyPath,
} from "./netlify/shared/proxy500Shared.js";

export default defineConfig({
  plugins: [react(), proxy500Plugin()],
});

function proxy500Plugin() {
  return {
    name: "proxy500",
    configureServer(server) {
      server.middlewares.use("/proxy500", async (req, res) => {
        try {
          const requestUrl = new URL(`/proxy500${req.url || ""}`, "http://localhost");
          if (req.method === "OPTIONS") {
            sendText(res, 204, "");
            return;
          }

          if (req.method === "POST" && isBatchProxyPath(requestUrl.href)) {
            sendJson(res, 200, await fetchProxyBatch(await readJsonBody(req)));
            return;
          }

          if (!["GET", "HEAD"].includes(req.method)) {
            sendText(res, 405, "Method not allowed.");
            return;
          }

          const proxyRequest = getProxyRequestFromUrl(requestUrl.href);
          const target = TARGETS[proxyRequest.targetKey];
          if (!target) {
            sendText(res, 400, "Unknown proxy target.");
            return;
          }

          const upstream = await fetchUpstream(
            getUpstreamUrl(proxyRequest),
            buildUpstreamHeaders(target, proxyRequest.path, proxyRequest.search),
          );

          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/html; charset=gb18030");
          res.end(buffer);
        } catch (error) {
          sendText(res, 502, `Proxy request failed: ${error.message}`);
        }
      });
    },
  };
}

function sendText(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}
