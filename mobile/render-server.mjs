import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const root = resolve("dist-render");
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
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".webm": "video/webm",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extname(pathname).toLowerCase()] || "application/octet-stream"
  );
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(root, decoded.replace(/^\/+/, ""));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function fileResponse(request, fallback = false) {
  const url = new URL(request.url);
  let path = safePath(url.pathname);
  if (!path) return null;
  let info;
  try {
    info = await stat(path);
    if (info.isDirectory()) {
      path = resolve(path, "index.html");
      info = await stat(path);
    }
  } catch {
    if (!fallback) return null;
    path = resolve(root, "index.html");
    try {
      info = await stat(path);
    } catch {
      return null;
    }
  }
  if (!info.isFile()) return null;

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": contentType(path),
    "Cache-Control": path.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
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

function absoluteUrl(request) {
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

async function proxy(request) {
  if (!backendOrigin) {
    return new Response(JSON.stringify({ detail: "Ziipa API is not configured." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  const method = request.method || "GET";
  const init = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return fetch(new URL(request.url || "/", backendOrigin), init);
}

async function send(fetchResponse, response) {
  response.statusCode = fetchResponse.status;
  for (const [name, value] of fetchResponse.headers) response.setHeader(name, value);
  const cookies = fetchResponse.headers.getSetCookie?.();
  if (cookies?.length) response.setHeader("set-cookie", cookies);
  if (!fetchResponse.body) return response.end();
  Readable.fromWeb(fetchResponse.body).pipe(response);
}

createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") return send(new Response("ok"), response);
    if (request.url?.startsWith("/api/")) return send(await proxy(request), response);
    const webRequest = new Request(absoluteUrl(request), {
      method: request.method,
      headers: request.headers,
    });
    return send(
      (await fileResponse(webRequest)) ||
        (await fileResponse(webRequest, true)) ||
        new Response("Not found", { status: 404 }),
      response,
    );
  } catch (error) {
    console.error(error);
    return send(new Response("Internal server error", { status: 500 }), response);
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Ziipa mobile web listening on 0.0.0.0:${port}`);
});
