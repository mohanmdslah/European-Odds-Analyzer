import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const TARGETS = {
  live: "https://live.500.com",
  odds: "https://odds.500.com",
  liansai: "https://liansai.500.com",
};

export default defineConfig({
  plugins: [react(), proxy500Plugin()],
});

function proxy500Plugin() {
  return {
    name: "proxy500",
    configureServer(server) {
      server.middlewares.use("/proxy500", async (req, res) => {
        try {
          const match = req.url.match(/^\/([^/?#]+)(.*)$/);
          const target = match ? TARGETS[match[1]] : "";
          if (!target) {
            sendText(res, 400, "Unknown proxy target.");
            return;
          }

          const upstreamUrl = `${target}${match[2] || "/"}`;
          const isAjax = /\/fenxi1\//.test(match[2] || "");
          const isJson = /\/fenxi1\/json\//.test(match[2] || "");
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            Referer: target,
            Accept: isJson ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          };
          if (isAjax) headers["X-Requested-With"] = "XMLHttpRequest";

          const upstream = await fetchUpstream(upstreamUrl, headers);

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

function sendText(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}
