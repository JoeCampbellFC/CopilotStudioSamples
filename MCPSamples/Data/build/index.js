import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListResourcesRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getPool, sql } from "./utils/db.js";
import { timestamp } from "./utils/utils.js";
const app = express();
app.use(express.json());
/**
 * Full drop-in: Matter MCP Server
 * - Adds queryMatters tool (structured filters + optional text search across EN_US fields)
 * - Fixes ClientId/Id to be strings (table schema is VARCHAR)
 * - Supports either Full-Text Search (CONTAINS) or LIKE fallback via USE_FULLTEXT flag
 */
const MATTER_URI_PREFIX = "matter://";
/** Toggle: set true only if SQL Server Full-Text is enabled on the relevant columns */
const USE_FULLTEXT = false;
const buildMatterUri = (clientId, id) => `${MATTER_URI_PREFIX}${encodeURIComponent(clientId)}/${encodeURIComponent(id)}`;
const parseMatterUri = (uri) => {
    if (!uri.startsWith(MATTER_URI_PREFIX))
        return null;
    const parts = uri.slice(MATTER_URI_PREFIX.length).split("/");
    if (parts.length !== 2)
        return null;
    const clientId = decodeURIComponent(parts[0]);
    const id = decodeURIComponent(parts[1]);
    if (!clientId || !id)
        return null;
    return { clientId, id };
};
// Create the MCP server once (reused across requests)
const server = new Server({
    name: "imanage-matter-mcp-server",
    version: "1.1.0",
}, {
    capabilities: {
        resources: { subscribe: true },
        tools: {},
    },
});
// -------------------- Schemas --------------------
/** Legacy: simple name search */
const SearchMattersSchema = z.object({
    searchTerms: z.string().describe("keywords to search for matters by name (EN_US)"),
    limit: z.number().int().min(1).max(25).optional().describe("maximum number of results"),
});
/** New: structured + text search over EN_US fields */
const QueryMattersSchema = z.object({
    text: z
        .string()
        .optional()
        .describe("Free text to search across EN_US name + note/description fields (optional). Example: 'Sky acquisition'"),
    status: z
        .enum(["open", "closed", "any"])
        .optional()
        .default("any")
        .describe("Filter by open/closed/any. Closed uses Status='Closed' OR CloseDate not null."),
    // Date filters (YYYY-MM-DD)
    closedFrom: z.string().optional().describe("YYYY-MM-DD. Closed on/after this date"),
    closedTo: z.string().optional().describe("YYYY-MM-DD. Closed on/before this date"),
    openedFrom: z.string().optional().describe("YYYY-MM-DD. Opened on/after this date"),
    openedTo: z.string().optional().describe("YYYY-MM-DD. Opened on/before this date"),
    // Optional constraints
    clientId: z.string().optional().describe("Optional client id filter (varchar)"),
    limit: z.number().int().min(1).max(25).optional().default(10),
});
const GetMatterByIdSchema = z.object({
    clientId: z.string().describe("Matter client ID (varchar)"),
    id: z.string().describe("Matter ID (varchar)"),
});
// -------------------- Tool list --------------------
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "queryMatters",
                description: "Query matters using structured filters (open/closed, date ranges, client) plus optional free-text across EN_US name/notes/descriptions. Returns matching matter resource links.",
                inputSchema: zodToJsonSchema(QueryMattersSchema),
            },
            {
                name: "searchMatters",
                description: "Legacy: Search matters by Name_En_US only (LIKE). Returns matching matter resource links.",
                inputSchema: zodToJsonSchema(SearchMattersSchema),
            },
            {
                name: "getMatterById",
                description: "Retrieve a single matter by client ID and matter ID.",
                inputSchema: zodToJsonSchema(GetMatterByIdSchema),
            },
        ],
    };
});
// -------------------- DB helpers --------------------
const toDate = (s) => {
    if (!s)
        return null;
    // Expect YYYY-MM-DD. Date ctor treats as UTC-ish depending on runtime; good enough for filtering.
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};
const buildContainsQuery = (text) => {
    const t = text?.trim();
    if (!t)
        return null;
    // Basic prefix AND query:
    // "sky*" AND "acquisition*"
    // Remove quotes to avoid breaking the CONTAINS syntax.
    return t
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `"${w.replace(/"/g, "")}*"`)
        .join(" AND ");
};
const loadMatterSummaryLegacy = async (searchTerms, limit) => {
    const pool = await getPool();
    const result = await pool
        .request()
        .input("pattern", sql.NVarChar, `%${searchTerms}%`)
        .input("limit", sql.Int, limit)
        .query(`
      SELECT TOP (@limit)
        ClientId,
        Id,
        Name_En_US,
        Status,
        OpenDate,
        CloseDate
      FROM imanage.Matter
      WHERE Name_En_US LIKE @pattern
      ORDER BY Name_En_US ASC
    `);
    return result.recordset;
};
const loadMattersByQuery = async (args) => {
    const pool = await getPool();
    const req = pool.request();
    req.input("limit", sql.Int, args.limit ?? 10);
    req.input("clientId", sql.NVarChar, args.clientId ?? null);
    const status = args.status ?? "any";
    req.input("status", sql.NVarChar, status);
    req.input("openedFrom", sql.DateTime2, toDate(args.openedFrom));
    req.input("openedTo", sql.DateTime2, toDate(args.openedTo));
    req.input("closedFrom", sql.DateTime2, toDate(args.closedFrom));
    req.input("closedTo", sql.DateTime2, toDate(args.closedTo));
    const text = args.text?.trim() || null;
    req.input("pattern", sql.NVarChar, text ? `%${text}%` : null);
    const containsQuery = buildContainsQuery(text ?? undefined);
    req.input("containsQuery", sql.NVarChar, containsQuery);
    const textPredicate = USE_FULLTEXT
        ? `
      (
        @containsQuery IS NULL
        OR CONTAINS((
          Name_En_US,
          MarketingNote_En_US,
          ConflictNote_En_US,
          MatterDescriptionLegal1_En_US,
          MatterDescriptionLegal2_En_US,
          MatterDescriptionBusinessDevelopment_En_US
        ), @containsQuery)
      )
    `
        : `
      (
        @pattern IS NULL
        OR Name_En_US LIKE @pattern
        OR MarketingNote_En_US LIKE @pattern
        OR ConflictNote_En_US LIKE @pattern
        OR MatterDescriptionLegal1_En_US LIKE @pattern
        OR MatterDescriptionLegal2_En_US LIKE @pattern
        OR MatterDescriptionBusinessDevelopment_En_US LIKE @pattern
      )
    `;
    const q = `
    SELECT TOP (@limit)
      ClientId,
      Id,
      Name_En_US,
      Status,
      OpenDate,
      CloseDate
    FROM imanage.Matter
    WHERE 1=1
      AND (@clientId IS NULL OR ClientId = @clientId)

      AND (
        @status = 'any'
        OR (
          @status = 'closed'
          AND (Status = 'Closed' OR CloseDate IS NOT NULL)
        )
        OR (
          @status = 'open'
          AND (ISNULL(Status, '') <> 'Closed')
          AND CloseDate IS NULL
        )
      )

      AND (@openedFrom IS NULL OR OpenDate >= @openedFrom)
      AND (@openedTo   IS NULL OR OpenDate <= @openedTo)
      AND (@closedFrom IS NULL OR CloseDate >= @closedFrom)
      AND (@closedTo   IS NULL OR CloseDate <= @closedTo)

      AND ${textPredicate}

    ORDER BY
      CASE WHEN CloseDate IS NULL THEN 0 ELSE 1 END DESC,
      Name_En_US ASC;
  `;
    const result = await req.query(q);
    return result.recordset;
};
const loadMatterById = async (clientId, id) => {
    const pool = await getPool();
    const result = await pool
        .request()
        .input("clientId", sql.NVarChar, clientId)
        .input("id", sql.NVarChar, id)
        .query(`
      SELECT *
      FROM imanage.Matter
      WHERE ClientId = @clientId
        AND Id = @id
    `);
    return result.recordset[0] ?? null;
};
// -------------------- Tool call handler --------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "queryMatters") {
        const validatedArgs = QueryMattersSchema.parse(args);
        console.log(`${timestamp()} 🔍 Client called tool: queryMatters ${JSON.stringify(validatedArgs)}`);
        const records = await loadMattersByQuery(validatedArgs);
        if (records.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No matters matched your query.`,
                    },
                ],
            };
        }
        const headerText = `Found ${records.length} matter(s)` +
            (validatedArgs.text ? ` matching "${validatedArgs.text}"` : "") +
            `:\n\n` +
            records
                .map((r, i) => {
                const name = r.Name_En_US ?? "Unnamed Matter";
                const closed = r.CloseDate ? ` — Closed ${r.CloseDate.toISOString().slice(0, 10)}` : "";
                const status = r.Status ? ` — ${r.Status}` : "";
                return `${i + 1}. ${name} (Client ${r.ClientId}, Matter ${r.Id})${status}${closed}`;
            })
                .join("\n");
        const content = [
            {
                type: "text",
                text: headerText,
            },
        ];
        for (const record of records) {
            content.push({
                type: "resource_link",
                uri: buildMatterUri(record.ClientId, record.Id),
                name: record.Name_En_US ?? `Matter ${record.ClientId}/${record.Id}`,
                description: record.Status ? `Status: ${record.Status}` : "Matter record",
                mimeType: "application/json",
                annotations: {
                    audience: ["assistant"],
                    priority: 0.8,
                },
            });
        }
        return { content };
    }
    if (name === "searchMatters") {
        const validatedArgs = SearchMattersSchema.parse(args);
        const { searchTerms, limit = 5 } = validatedArgs;
        console.log(`${timestamp()} 🔍 Client called tool: searchMatters with terms '${searchTerms}'`);
        const records = await loadMatterSummaryLegacy(searchTerms, limit);
        if (records.length === 0) {
            console.log(`${timestamp()} ⚠️  No matters found for client search: "${searchTerms}"`);
            return {
                content: [
                    {
                        type: "text",
                        text: `No matters found matching: "${searchTerms}". Try a different matter name keyword.`,
                    },
                ],
            };
        }
        console.log(`${timestamp()} ✅ Returning ${records.length} matching matters to client`);
        const content = [
            {
                type: "text",
                text: `Found ${records.length} matter(s) matching "${searchTerms}":\n\n${records
                    .map((record, index) => `${index + 1}. ${record.Name_En_US ?? "Unnamed Matter"} (Client ${record.ClientId}, Matter ${record.Id})`)
                    .join("\n")}`,
            },
        ];
        records.forEach((record) => {
            content.push({
                type: "resource_link",
                uri: buildMatterUri(record.ClientId, record.Id),
                name: record.Name_En_US ?? `Matter ${record.ClientId}/${record.Id}`,
                description: record.Status ? `Status: ${record.Status}` : "Matter record",
                mimeType: "application/json",
                annotations: {
                    audience: ["assistant"],
                    priority: 0.8,
                },
            });
        });
        return { content };
    }
    if (name === "getMatterById") {
        const validatedArgs = GetMatterByIdSchema.parse(args);
        const { clientId, id } = validatedArgs;
        console.log(`${timestamp()} 📌 Client called tool: getMatterById for ${clientId}/${id}`);
        const record = await loadMatterById(clientId, id);
        if (!record) {
            return {
                content: [
                    {
                        type: "text",
                        text: `No matter found for ClientId ${clientId} and Id ${id}.`,
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(record, null, 2),
                },
            ],
        };
    }
    throw new Error(`Unknown tool: ${name}`);
});
// -------------------- Resources --------------------
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    console.log(`${timestamp()} 📋 Client requested resource list; returning empty list for database-backed resources.`);
    return { resources: [] };
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    console.log(`${timestamp()} 📖 Client reading resource: ${uri}`);
    const parsed = parseMatterUri(uri);
    if (!parsed)
        throw new Error(`Unknown resource: ${uri}`);
    const record = await loadMatterById(parsed.clientId, parsed.id);
    if (!record)
        throw new Error(`Matter not found for resource: ${uri}`);
    return {
        contents: [
            {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(record, null, 2),
            },
        ],
    };
});
// Subscribe / Unsubscribe are no-ops here (db-backed resources)
server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const { uri } = request.params;
    console.log(`${timestamp()} 🔔 Client subscribed to: ${uri}`);
    return {};
});
server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const { uri } = request.params;
    console.log(`${timestamp()} 🔕 Client unsubscribed from: ${uri}`);
    return {};
});
// -------------------- HTTP endpoint --------------------
app.post("/mcp", async (req, res) => {
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => {
            transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        console.error(`${timestamp()} Error handling MCP request:`, error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
            });
        }
    }
});
const PORT = parseInt(process.env.PORT || "3001", 10);
app
    .listen(PORT, () => {
    console.log(`${timestamp()} 🚀 Matter MCP Server running on http://localhost:${PORT}/mcp`);
    console.log(`${timestamp()} 📚 Connected to imanage.Matter in the staging-area database`);
    console.log(`${timestamp()} 🔎 queryMatters text mode: ${USE_FULLTEXT ? "FULLTEXT (CONTAINS)" : "LIKE fallback"}`);
})
    .on("error", (error) => {
    console.error(`${timestamp()} Server error:`, error);
    process.exit(1);
});
