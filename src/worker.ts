/**
 * Canvas MCP — Cloudflare Worker entry point.
 *
 * Speaks JSON-RPC 2.0 over HTTP for `tools/list` and `tools/call`. Suitable
 * for any MCP client that supports the Streamable-HTTP variant.
 *
 * Auth precedence: per-request `Authorization: Bearer <token>` header, then
 * the `CANVAS_TOKEN` secret. Multi-tenant deployments should use the header.
 */

import { z } from "zod";
import { CanvasClient, CanvasError } from "./canvas.js";
import { tools } from "./tools.js";

interface Env {
  CANVAS_BASE_URL?: string;
  CANVAS_TOKEN?: string;
  /**
   * Optional shared secret. When set, header-based requests (per-user creds
   * via Authorization / X-Canvas-Base-Url) must include
   * `X-Ada-Service-Key: <ADA_SERVICE_KEY>`. Env-only single-tenant requests
   * skip this check.
   */
  ADA_SERVICE_KEY?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options };
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((o: z.ZodTypeAny) => zodToJsonSchema(o)) };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  return {};
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-canvas-base-url, x-ada-service-key, mcp-session-id",
};

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: CORS_HEADERS });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: CORS_HEADERS });
}

function rpcToolError(id: JsonRpcRequest["id"], message: string): Response {
  return rpcResult(id, { isError: true, content: [{ type: "text", text: message }] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method === "GET") {
      return new Response("canvas-mcp: POST JSON-RPC 2.0 requests to this endpoint.\n", {
        headers: { "content-type": "text/plain", ...CORS_HEADERS },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "Parse error");
    }

    const headerAuth = request.headers.get("authorization");
    const headerToken = headerAuth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const headerBaseUrl = request.headers.get("x-canvas-base-url")?.trim();

    const token = headerToken || env.CANVAS_TOKEN;
    const baseUrl = headerBaseUrl || env.CANVAS_BASE_URL;
    const usedHeaderAuth = Boolean(headerToken || headerBaseUrl);

    if (env.ADA_SERVICE_KEY && usedHeaderAuth) {
      const provided = request.headers.get("x-ada-service-key");
      if (provided !== env.ADA_SERVICE_KEY) {
        return rpcError(body.id, -32001, "Missing or invalid X-Ada-Service-Key");
      }
    }

    if (!baseUrl || !token) {
      return rpcError(
        body.id,
        -32603,
        "No Canvas credentials. Provide Authorization + X-Canvas-Base-Url headers or set CANVAS_* secrets.",
      );
    }
    const client = new CanvasClient({ baseUrl, token });

    if (body.method === "initialize") {
      return rpcResult(body.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "canvas", version: "0.1.0" },
      });
    }

    if (body.method === "tools/list") {
      return rpcResult(body.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.schema),
        })),
      });
    }

    if (body.method === "tools/call") {
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name;
      const args = params.arguments ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return rpcToolError(body.id, `Unknown tool: ${name}`);
      }
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return rpcToolError(
          body.id,
          `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      try {
        const result = await tool.handler(parsed.data, client);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return rpcResult(body.id, { content: [{ type: "text", text }] });
      } catch (err) {
        const message =
          err instanceof CanvasError
            ? `Canvas API error (${err.status}): ${err.message}`
            : err instanceof Error
              ? `${err.name}: ${err.message}`
              : String(err);
        return rpcToolError(body.id, message);
      }
    }

    return rpcError(body.id, -32601, `Method not found: ${body.method}`);
  },
};
