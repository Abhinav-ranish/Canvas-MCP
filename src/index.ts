#!/usr/bin/env node
/**
 * Canvas MCP server.
 *
 * Exposes Canvas LMS as MCP tools over stdio. Configure with env vars:
 *   CANVAS_BASE_URL  e.g. https://canvas.asu.edu/api/v1
 *   CANVAS_TOKEN     Canvas Personal Access Token
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CanvasClient, CanvasError } from "./canvas.js";
import { tools } from "./tools.js";

function loadConfig() {
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_TOKEN;
  if (!baseUrl || !token) {
    process.stderr.write(
      "[canvas-mcp] Missing CANVAS_BASE_URL or CANVAS_TOKEN env var. Refusing to start.\n",
    );
    process.exit(1);
  }
  return { baseUrl, token };
}

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal Zod -> JSON Schema for the shapes we use (objects with primitives,
  // arrays, enums, optionals, unions of string|number).
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

async function main() {
  const config = loadConfig();
  const client = new CanvasClient(config);

  const server = new Server(
    { name: "canvas", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          },
        ],
      };
    }
    try {
      const result = await tool.handler(parsed.data, client);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message =
        err instanceof CanvasError
          ? `Canvas API error (${err.status}): ${err.message}\n${JSON.stringify(err.body, null, 2)}`
          : err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[canvas-mcp] connected\n");
}

main().catch((err) => {
  process.stderr.write(`[canvas-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
