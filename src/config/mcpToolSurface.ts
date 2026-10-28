import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * Select which tools tools/list advertises. The router surface advertises a
 * small search, schema, and call trio over the complete catalog, for local
 * models whose accuracy and context degrade with hundreds of tool schemas.
 */
export const mcpToolSurfaceSchema = z.enum(["full", "router"]);

export type McpToolSurface = z.infer<typeof mcpToolSurfaceSchema>;

const surfaceConstraint =
  'REA_MCP_TOOL_SURFACE must be "full" (default) or "router". The router surface advertises only search_tools, get_tool_schema, and call_tool; every REA tool stays callable through call_tool.';

/** Parse the advertised tool surface selection at server composition. */
export const parseMcpToolSurface = (
  value: string | undefined,
): Result<McpToolSurface | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpToolSurfaceSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(surfaceConstraint, {
          settings: [
            {
              setting: "REA_MCP_TOOL_SURFACE",
              constraint: surfaceConstraint,
            },
          ],
        }),
      );
};
