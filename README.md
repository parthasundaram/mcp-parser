# MCP Tool Inspector

A small local web app that accepts an MCP server URL, connects to it, calls `tools/list`, and renders each tool with its input parameters.

## Run

```bash
node server.mjs
```

Then open `http://localhost:4173`.

## Notes

- Supports Streamable HTTP MCP endpoints first.
- Falls back to legacy SSE endpoints that emit an `endpoint` event for JSON-RPC messages.
- This is a local inspection tool. It proxies the MCP request through the Node server so browser CORS does not block inspection.
# mcp-parser
