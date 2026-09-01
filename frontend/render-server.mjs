import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import worker from "./dist/server/index.js";

const assetRoot = resolve("dist/client");
const port = Number(process.env.PORT || 10000);
const backendOrigin = normalizeOrigin(
  process.env.BACKEND_URL || process.env.BACKEND_HOSTPORT || "",
);

function normalizeOrigin(value) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

function contentType(pathname) {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".gif": "image/gif",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extname(pathname).toLowerCase()] || "application/octet-stream"
  );
}

function localAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(assetRoot, decoded.replace(/^\/+/, ""));
  if (candidate !== assetRoot && !candidate.startsWith(assetRoot + sep)) return null;
  return candidate;
}

async function assetResponse(request) {
  const url = new URL(request.url);
  let path = localAssetPath(url.pathname);
  if (!path) return null;
  let info;
  try {
    info = await stat(path);
    if (info.isDirectory()) {
      path = resolve(path, "index.html");
      info = await stat(path);
    }
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": contentType(path),
    "Cache-Control": url.pathname.startsWith("/_next/static/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
  });
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) start = Math.max(0, info.size - Number(match[2]));
    if (start > end || start >= info.size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    }
    end = Math.min(end, info.size - 1);
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(path, { start, end })), {
    status,
    headers,
  });
}

function requestUrl(request) {
  const protocol = String(request.headers["x-forwarded-proto"] || "http")
    .split(",")[0]
    .trim();
  const host = String(
    request.headers["x-forwarded-host"] || request.headers.host || "localhost",
  )
    .split(",")[0]
    .trim();
  return new URL(request.url || "/", `${protocol}://${host}`).toString();
}

function requestInit(request) {
  const method = request.method || "GET";
  const init = { method, headers: request.headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return init;
}

async function proxyApi(request) {
  if (!backendOrigin) {
    return new Response(
      JSON.stringify({ detail: "Ziipa API is not configured." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  const target = new URL(request.url || "/", backendOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  const method = request.method || "GET";
  const init = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return fetch(target, init);
}

async function send(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  for (const [name, value] of response.headers) nodeResponse.setHeader(name, value);
  const cookies = response.headers.getSetCookie?.();
  if (cookies?.length) nodeResponse.setHeader("set-cookie", cookies);
  if (!response.body) return nodeResponse.end();
  Readable.fromWeb(response.body).pipe(nodeResponse);
}

const assets = {
  async fetch(request) {
    return (await assetResponse(request)) || new Response("Not found", { status: 404 });
  },
};

createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") {
      return send(new Response("ok"), response);
    }
    if (request.url?.startsWith("/api/")) {
      return send(await proxyApi(request), response);
    }
    const webRequest = new Request(requestUrl(request), requestInit(request));
    const asset = await assetResponse(webRequest);
    if (asset) return send(asset, response);
    const pending = [];
    const result = await worker.fetch(webRequest, { ASSETS: assets }, {
      passThroughOnException() {},
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    });
    void Promise.allSettled(pending);
    return send(result, response);
  } catch (error) {
    console.error(error);
    return send(new Response("Internal server error", { status: 500 }), response);
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Ziipa web listening on 0.0.0.0:${port}`);
});
