/**
 * Shared helpers for MCP tool registration and responses
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Common response structures for MCP tools
export type TextContent = { type: 'text'; text: string };

export type ToolResponseStructure = {
  content: TextContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Per-request context the SDK passes to tool handlers (auth info, signal…) */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// === Tool Response Helpers ===

export function createErrorResponse(message: string): ToolResponseStructure {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function createSuccessResponse(data: unknown): ToolResponseStructure {
  const rawJsonResponse = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: rawJsonResponse }],
  };
}

// === Tool Registration Helper ===

export interface ToolConfig<Shape extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  handler: (
    params: z.objectOutputType<Shape, z.ZodTypeAny>,
    extra: ToolExtra
  ) => Promise<ToolResponseStructure>;
}

export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  config: ToolConfig<Shape>
): void {
  server.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: config.annotations,
    },
    // The SDK infers handler args from the shape; our config is already typed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config.handler as any
  );
}

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
