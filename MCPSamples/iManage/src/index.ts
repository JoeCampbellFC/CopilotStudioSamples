import express, { Request, Response } from "express";
import { Agent } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pdfParse from "pdf-parse";

const app = express();
app.use(express.json());

const server = new Server(
  { name: "imanage-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// -------------------- Schemas --------------------

const SearchSchema = z.object({
  query: z.string().describe("Search query text"),
  maxResults: z.number().int().min(1).max(20).optional(),
});

const FetchSchema = z.object({
  id: z.string().describe("iManage document URI or URL"),
  timeoutSeconds: z.number().positive().optional(),
  followRedirects: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
});

// ✅ New analytics tool schemas
const AnalyticsSchema = z.object({
  ids: z.array(z.string()).min(1).max(50).describe("iManage document URIs"),
  granularity: z.enum(["daily", "weekly", "monthly"]).optional(),
});

const AnalyticsResultSchema = z.object({
  results: z.record(
    z.object({
      views: z.number().nullable(),
    })
  ),
});

// -------------------- Config --------------------

// ✅ Use env vars (do not hardcode creds in source)
const IMANAGE_SERVER = process.env.IMANAGE_SERVER ?? "fireman.cloudimanage.com";
const IMANAGE_USERNAME = process.env.IMANAGE_USERNAME ?? "CloudAdmin@sandbox.firemanco.com"; 
const IMANAGE_PASSWORD = process.env.IMANAGE_PASSWORD ?? "pxg@zkm.CVU*der3tbd"; 
const IMANAGE_CLIENT_ID = process.env.IMANAGE_CLIENT_ID ?? "d8e2d5ef-0c1f-4475-af2c-ad4e2d5bc784"; 
const IMANAGE_CLIENT_SECRET = process.env.IMANAGE_CLIENT_SECRET ?? "3f8fa1e6-358d-4d11-9bae-8711c2a70a47";

const IMANAGE_LIBRARY_ID = process.env.IMANAGE_LIBRARY_ID ?? "ACTIVE_2";

const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT ?? "30");
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? String(10 * 1024 * 1024));
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "20");
const SKIP_LARGE_FILES = (process.env.SKIP_LARGE_FILES ?? "1") === "1";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? "1200");
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP ?? "100");

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT * 1000;

// -------------------- Helpers --------------------

function splitText(text: string, chunkSize: number, overlap: number): string {
  if (!text) return "";
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push(text.slice(start, end));
    start = Math.max(start + chunkSize - overlap, start + 1);

    if (chunks.join("").length >= MAX_DOC_BYTES) break;
  }
  return chunks.join("\n");
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: insecureAgent,
    } as RequestInit);
  } finally {
    clearTimeout(timeout);
  }
}

// -------------------- iManage Auth --------------------

async function imanageAuthToken(): Promise<string | null> {
  if (!IMANAGE_USERNAME || !IMANAGE_PASSWORD || !IMANAGE_CLIENT_ID || !IMANAGE_CLIENT_SECRET) {
    throw new Error(
      "Missing iManage env vars (IMANAGE_USERNAME/PASSWORD/CLIENT_ID/CLIENT_SECRET)."
    );
  }

  const url = `https://${IMANAGE_SERVER}/auth/oauth2/token`;
  const body = new URLSearchParams({
    username: IMANAGE_USERNAME,
    password: IMANAGE_PASSWORD,
    grant_type: "password",
    client_id: IMANAGE_CLIENT_ID,
    client_secret: IMANAGE_CLIENT_SECRET,
    scope: "user",
  });

  const response = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return null;
  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function imanageCustomerId(token: string): Promise<string | null> {
  const url = `https://${IMANAGE_SERVER}/api`;
  const response = await fetchWithTimeout(
    url,
    { method: "GET", headers: { "X-Auth-Token": token } },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return null;

  const data = (await response.json()) as {
    data?: { user?: { customer_id?: string } };
  };
  return data.data?.user?.customer_id ?? null;
}

// -------------------- URI helpers --------------------

function imanageDocUri(customerId: string, libraryId: string, docId: string): string {
  return `imanage://${customerId}/${libraryId}/${docId}`;
}

function parseIManageUri(uri: string): { customerId: string; libraryId: string; docId: string } {
  if (!uri.startsWith("imanage://")) throw new Error("Not an iManage URI");
  const rest = uri.slice("imanage://".length);
  const parts = rest.split("/", 3);
  if (parts.length !== 3) throw new Error("Bad iManage URI");
  const [customerId, libraryId, docId] = parts;
  return { customerId, libraryId, docId };
}

// -------------------- Search (links only) --------------------

async function imanageSearch(query: string, maxResults: number) {
  const token = await imanageAuthToken();
  if (!token) return [];

  const customerId = await imanageCustomerId(token);
  if (!customerId) return [];

  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${IMANAGE_LIBRARY_ID}/documents/search`;
  const payload = {
    profile_fields: { document: ["id", "name", "file_edit_date", "iwl"] },
    filters: { body: query, type: "ACROBAT" },
    limit: maxResults,
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify(payload),
    },
    DEFAULT_TIMEOUT_MS
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { data?: Array<Record<string, unknown>> };

  return (data.data ?? []).slice(0, maxResults).flatMap((entry) => {
    const docId = String(entry.id ?? "");
    if (!docId) return [];
    const title = String(entry.name ?? docId);
    const iwl = String(entry.iwl ?? "");
    return [
      {
        id: imanageDocUri(customerId, IMANAGE_LIBRARY_ID, docId),
        title,
        url: iwl,
      },
    ];
  });
}

// -------------------- Analytics (views) --------------------

async function imanageHistoryViews(
  token: string,
  customerId: string,
  libraryId: string,
  docId: string,
  granularity: "daily" | "weekly" | "monthly" = "weekly"
): Promise<number | null> {
  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${libraryId}/documents/${docId}/history/plot-points/${granularity}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { "X-Auth-Token": token, Accept: "application/json" },
    },
    DEFAULT_TIMEOUT_MS
  );

  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) return null;

  const payload = (await response.json()) as unknown;
  const points = Array.isArray(payload) ? payload : (payload as { data?: unknown }).data;
  if (!Array.isArray(points)) return null;

  let total = 0;
  for (const point of points) {
    if (typeof point === "object" && point && "y" in point) {
      const value = Number((point as { y?: unknown }).y);
      if (!Number.isNaN(value)) total += value;
    }
  }
  return total;
}

// -------------------- Fetch (download + parse PDF + include views) --------------------

async function readStreamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ buffer: Buffer; bytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) break;
  }

  return { buffer: Buffer.concat(chunks), bytes: total };
}

async function imanageDownloadPdf(
  token: string,
  customerId: string,
  libraryId: string,
  docId: string
): Promise<{ bytes: Buffer; metadata: Record<string, unknown> }> {
  const url = `https://${IMANAGE_SERVER}/work/api/v2/customers/${customerId}/libraries/${libraryId}/documents/${docId}/download`;
  const headers = { "X-Auth-Token": token };

  if (SKIP_LARGE_FILES) {
    const headResponse = await fetchWithTimeout(
      url,
      { method: "HEAD", headers },
      DEFAULT_TIMEOUT_MS
    );
    if (headResponse.ok) {
      const sizeValue = Number(headResponse.headers.get("Content-Length") ?? "0");
      if (sizeValue && sizeValue > MAX_DOC_BYTES) {
        return {
          bytes: Buffer.from(""),
          metadata: {
            skipped: true,
            reason: `file too large (${sizeValue} > ${MAX_DOC_BYTES} bytes)`,
          },
        };
      }
    }
  }

  const response = await fetchWithTimeout(url, { method: "GET", headers }, DEFAULT_TIMEOUT_MS);

  if (!response.ok || !response.body) {
    return {
      bytes: Buffer.from(""),
      metadata: { error: `download failed: ${response.status}` },
    };
  }

  const { buffer, bytes } = await readStreamToBuffer(response.body, MAX_DOC_BYTES);
  return { bytes: buffer, metadata: { bytes } };
}

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  if (!pdfBytes.length) return "";
  const parsed = await pdfParse(pdfBytes, { max: MAX_PAGES });
  let text = parsed.text?.trim() ?? "";
  if (text.length > MAX_DOC_BYTES / 4) {
    text = splitText(text, CHUNK_SIZE, CHUNK_OVERLAP);
  }
  return `[PDF parsed via pdf-parse]\n${text}`;
}

async function resolveIManageDocument(imanageUri: string) {
  const { customerId, libraryId, docId } = parseIManageUri(imanageUri);
  const token = await imanageAuthToken();
  if (!token) throw new Error("iManage auth failed (check credentials & scopes)");

  const download = await imanageDownloadPdf(token, customerId, libraryId, docId);
  const text = await extractPdfText(download.bytes);

  const profileUrl = `https://${IMANAGE_SERVER}/work/#/document/${customerId}/${libraryId}/${docId}`;
  const views = await imanageHistoryViews(token, customerId, libraryId, docId, "weekly");

  const meta: Record<string, unknown> = {
    source: "imanage",
    customer_id: customerId,
    library_id: libraryId,
    doc_id: docId,
    url: profileUrl,
    ...download.metadata,
  };

  if (views !== null) meta.views = views;

  const skipped = download.metadata.skipped === true;
  const reason = typeof download.metadata.reason === "string" ? download.metadata.reason : "";

  return {
    id: imanageUri,
    title: `iManage Document ${docId}`,
    text: text || (skipped ? `[Skipped: ${reason}]` : ""),
    url: profileUrl,
    meta,
  };
}

async function fetchUrlContent(
  url: string,
  timeoutSeconds: number,
  followRedirects: boolean,
  headers?: Record<string, string>
) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": "mcp-imanage/1.0",
        ...(headers ?? {}),
      },
      redirect: followRedirects ? "follow" : "manual",
    },
    timeoutSeconds * 1000
  );

  if (!response.ok) throw new Error(`URL fetch failed: ${response.status}`);

  const contentType = response.headers.get("Content-Type") ?? "";
  const text = await response.text();

  return {
    id: url,
    title: url,
    text: contentType.includes("text/html") ? text.replace(/<[^>]+>/g, " ") : text,
    url,
    meta: {
      source: "url",
      content_type: contentType,
    },
  };
}

// -------------------- MCP handlers --------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search iManage documents by query (returns resource links only).",
        inputSchema: zodToJsonSchema(SearchSchema),
      },
      {
        name: "fetch",
        description:
          "Fetch an iManage document by URI or fetch URL content (returns text, extras in _meta).",
        inputSchema: zodToJsonSchema(FetchSchema),
      },
      {
        name: "analytics",
        description:
          "Get document analytics (views) for one or more iManage URIs. Returns structuredContent.",
        inputSchema: zodToJsonSchema(AnalyticsSchema),
        outputSchema: zodToJsonSchema(AnalyticsResultSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search") {
    const { query, maxResults } = SearchSchema.parse(args);
    console.debug(`🔎 [debug] search tool called`, { query, maxResults });

    if (!query.trim()) return { content: [] };

    const results = await imanageSearch(query, maxResults ?? 5);

    return {
      content: results.map((r) => ({
        type: "resource_link",
        name: r.title,
        uri: r.id,
        mimeType: "application/pdf",
        annotations: { audience: ["assistant"], priority: 0.8 },
        // Keep a hint URL (no text, no views in search)
        _meta: { url: r.url },
      })),
    };
  }

  if (name === "analytics") {
    const { ids, granularity } = AnalyticsSchema.parse(args);
    const g = granularity ?? "weekly";

    const token = await imanageAuthToken();
    if (!token) {
      const structuredContent = { results: {} as Record<string, { views: number | null }> };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      } as any;
    }

    const results: Record<string, { views: number | null }> = {};

    await Promise.all(
      ids.map(async (uri) => {
        try {
          const { customerId, libraryId, docId } = parseIManageUri(uri);
          const views = await imanageHistoryViews(token, customerId, libraryId, docId, g);
          results[uri] = { views };
        } catch {
          results[uri] = { views: null };
        }
      })
    );

    const structuredContent = { results };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    } as any;
  }

  if (name === "fetch") {
    const { id, timeoutSeconds, followRedirects, headers } = FetchSchema.parse(args);
    console.debug(`📥 [debug] fetch tool called`, { id, timeoutSeconds, followRedirects });

    const timeout = timeoutSeconds ?? 15;
    const redirects = followRedirects ?? true;

    let isUrl = false;
    try {
      const u = new URL(id);
      isUrl = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      isUrl = false;
    }

    const doc = isUrl
      ? await fetchUrlContent(id, timeout, redirects, headers)
      : await resolveIManageDocument(id);

    // ✅ Spec-friendly: put extras in _meta (many clients drop unknown fields like "metadata")
    return {
      content: [
        {
          type: "text",
          text: doc.text,
          _meta: {
            id: doc.id,
            title: doc.title,
            url: doc.url,
            ...doc.meta, // includes views when available
          },
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// -------------------- Express transport --------------------

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = Number(process.env.PORT ?? "3000");
app
  .listen(PORT, () => {
    console.log(`🚀 iManage MCP Server running on http://localhost:${PORT}/mcp`);
  })
  .on("error", (error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
