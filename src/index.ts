import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { createMcpServer } from "./mcp.js";
import { env, setEnv, type Env } from "./env.js";
import { WegmansAuth } from "./tokens.js";

const app = new Hono<{ Bindings: Env }>();
const same = async (actual: string | undefined, expected: string): Promise<boolean> => {
  if (actual === undefined) return false;
  const encoder = new TextEncoder(), a = encoder.encode(actual), b = encoder.encode(expected);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean };
  return a.byteLength === b.byteLength && subtle.timingSafeEqual(a, b);
};
const bearer = (header: string | undefined) => header?.startsWith("Bearer ") ? header.slice(7) : undefined;

app.get("/", (c) => c.text("wegmans-mcp — MCP endpoint: /mcp"));
app.get("/health", async (c) => {
  setEnv(c.env);
  const history = await env().DATA.get<{ lastSyncedAt?: string }>("purchase-history", "json");
  return c.json({ ok: true, ...await c.env.WEGMANS_AUTH.getByName("owner").status(), lastSyncedAt: history?.lastSyncedAt || null });
});
app.all("/mcp", async (c) => {
  setEnv(c.env);
  if (!await same(bearer(c.req.header("Authorization")), c.env.MCP_BEARER)) return c.json({ error: "Unauthorized" }, 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = await createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export { WegmansAuth };
export default app;
