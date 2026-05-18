import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const jsonRpc = (id, method, params = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a valid MCP server URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// MCP server URLs are supported.");
  }

  return parsed;
}

function parseSse(text) {
  return text
    .split(/\n\n+/)
    .map((event) =>
      event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function parseRpcResponse(response, expectedId) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`Server responded with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  if (contentType.includes("text/event-stream")) {
    payload = parseSse(text).find((item) => item.id === expectedId) || parseSse(text)[0];
  } else {
    payload = JSON.parse(text);
  }

  if (Array.isArray(payload)) {
    payload = payload.find((item) => item.id === expectedId) || payload[0];
  }

  if (!payload) {
    throw new Error("The server returned an empty response.");
  }

  if (payload.error) {
    const message = payload.error.message || "The MCP server returned an error.";
    throw new Error(message);
  }

  return payload.result;
}

async function rpcPost(endpoint, request, extraHeaders = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(request),
  });

  const result = await parseRpcResponse(response, request.id);
  return {
    result,
    sessionId: response.headers.get("mcp-session-id") || extraHeaders["mcp-session-id"] || "",
  };
}

async function inspectStreamableHttp(endpoint) {
  let id = 1;
  const init = await rpcPost(
    endpoint,
    jsonRpc(id++, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "mcp-tool-inspector",
        version: "0.1.0",
      },
    }),
  );

  const headers = init.sessionId ? { "mcp-session-id": init.sessionId } : {};

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  } catch {
    // Some implementations do not require the initialized notification.
  }

  const listed = await rpcPost(endpoint, jsonRpc(id++, "tools/list", {}), headers);

  return {
    transport: "Streamable HTTP",
    serverInfo: init.result.serverInfo || null,
    protocolVersion: init.result.protocolVersion || null,
    tools: listed.result.tools || [],
  };
}

async function inspectLegacySse(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(endpoint, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageEndpoint = "";

    while (!messageEndpoint) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split(/\n\n+/);
      buffer = events.pop() || "";

      for (const event of events) {
        const eventName = event
          .split(/\n/)
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = event
          .split(/\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();

        if (eventName === "endpoint" && data) {
          messageEndpoint = new URL(data, endpoint).toString();
        }
      }
    }

    if (!messageEndpoint) {
      throw new Error("The SSE server did not provide a message endpoint.");
    }

    let id = 1;
    await fetch(messageEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpc(id++, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "mcp-tool-inspector",
            version: "0.1.0",
          },
        }),
      ),
    });

    await fetch(messageEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    await fetch(messageEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpc(id++, "tools/list", {})),
    });

    const tools = await waitForSseResult(reader, decoder, id - 1);
    return {
      transport: "SSE",
      serverInfo: null,
      protocolVersion: null,
      tools: tools.tools || [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForSseResult(reader, decoder, expectedId) {
  let buffer = "";
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split(/\n\n+/);
    buffer = events.pop() || "";

    for (const event of events) {
      const data = event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (!data) continue;

      try {
        const payload = JSON.parse(data);
        if (payload.id === expectedId) {
          if (payload.error) {
            throw new Error(payload.error.message || "The MCP server returned an error.");
          }
          return payload.result || {};
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  throw new Error("Timed out waiting for the tools/list response from the SSE stream.");
}

async function inspectMcpServer(rawUrl) {
  const endpoint = safeUrl(rawUrl).toString();

  try {
    return await inspectStreamableHttp(endpoint);
  } catch (streamableError) {
    try {
      return await inspectLegacySse(endpoint);
    } catch (sseError) {
      throw new Error(
        `Could not inspect this MCP server. Streamable HTTP: ${streamableError.message} SSE: ${sseError.message}`,
      );
    }
  }
}

async function serveStatic(req, res) {
  const requestedPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const fileName = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const normalized = normalize(fileName).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);

  try {
    const body = await readFile(filePath);
    const type = contentTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/inspect") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await inspectMcpServer(payload.url || "");
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Something went wrong." });
  }
});

server.listen(port, host, () => {
  console.log(`MCP Tool Inspector is running at http://${host}:${port}`);
});
