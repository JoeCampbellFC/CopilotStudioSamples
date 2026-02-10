/**
 * iManage MCP Server (Copilot Studio friendly)
 * - Tool: search
 * - Resources: read (for document text / RAG context)
 * - Clickable citations: resource_link.uri is HTTPS (iwl) with ?mcpKey=<opaqueKey>
 * - Opaque key -> real iManage URI stored in in-memory lookup with TTL
 *
 * Notes:
 * - No "fetch" tool (Copilot tends to send its own GUIDs)
 * - resource_link.mimeType is text/plain to reduce PDF grounding behaviours
 * - resources/read accepts both:
 *    - https://... ?mcpKey=<key>
 *    - imanage://<key>  (fallback, if you ever emit that scheme)
 */
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, ListResourcesRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { answerQuestionFromDocumentText, buildAskDocumentInputSchema, buildRagContext, buildSearchInputSchema, buildSummarizeDocumentInputSchema, IMANAGE_LIBRARY_ID, IMANAGE_SERVER, imanageSearch, resolveIManageDocument, SearchSchema, splitIManageUri, summarizeDocumentText, SummarizeDocumentSchema, AskDocumentSchema, } from "./utils/utils.js";
const app = express();
app.use(express.json());
const server = new Server({ name: "imanage-mcp-server", version: "1.0.0" }, { capabilities: { resources: { subscribe: true }, tools: {} } });
// -------------------- MCP handlers --------------------
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [] };
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    console.log(`📖 resources/read => ${uri}`);
    const { documentUri, query } = splitIManageUri(uri);
    console.log(`Resolving iManage document for key ${documentUri} with query "${query}"...`);
    const doc = await resolveIManageDocument(documentUri);
    const { context } = buildRagContext(query ?? "", doc.text, {
        chunking: "paragraph",
        topN: 3,
        includeContext: true,
        useCharNgrams: true,
        useSynonyms: true,
    });
    // Friendly "Sources" block: keep it human readable.
    // Clickable target: use the stored IWL if present, else fallback to doc.url.
    const sourceTitle = doc.title ?? "iManage document";
    const clickable = doc.url;
    const sourcesBlock = `\n\nSources\n` + `- [${sourceTitle}](${clickable})\n`;
    return {
        contents: [
            {
                uri,
                mimeType: "text/plain",
                text: context + sourcesBlock,
            },
        ],
    };
});
server.setRequestHandler(ListToolsRequestSchema, async () => {
    const resp = {
        tools: [
            {
                name: "search",
                description: "Search and filter iManage documents by query.",
                inputSchema: buildSearchInputSchema(),
            },
            {
                name: "get_document_summary",
                description: "Get a concise summary of an iManage document using Azure OpenAI.",
                inputSchema: buildSummarizeDocumentInputSchema(),
            },
            {
                name: "ask_document",
                description: "Answer a question from an iManage document using Azure OpenAI and chunked retrieval.",
                inputSchema: buildAskDocumentInputSchema(),
            },
        ],
    };
    console.log("TOOLS/LIST =>", JSON.stringify(resp, null, 2));
    return resp;
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "get_document_summary") {
        const { imanageUri, maxChunkChars } = SummarizeDocumentSchema.parse(args);
        const doc = await resolveIManageDocument(imanageUri);
        const summary = await summarizeDocumentText(doc.text, maxChunkChars ?? 3000);
        return {
            content: [
                {
                    type: "text",
                    text: `Summary for ${doc.title}:

${summary}

Source: ${doc.url}`,
                },
            ],
        };
    }
    if (name === "ask_document") {
        const { imanageUri, question, topChunks } = AskDocumentSchema.parse(args);
        const doc = await resolveIManageDocument(imanageUri);
        const answer = await answerQuestionFromDocumentText(question, doc.text, topChunks ?? 6);
        return {
            content: [
                {
                    type: "text",
                    text: `Answer from ${doc.title}:

${answer}

Source: ${doc.url}`,
                },
            ],
        };
    }
    if (name !== "search") {
        throw new Error(`Unknown tool: ${name}`);
    }
    const { query, maxResults, client, matter } = SearchSchema.parse(args);
    const q = query.trim();
    if (!q)
        return { content: [] };
    const results = await imanageSearch(q, client, matter, maxResults ?? 3);
    // Build a human-readable list that Copilot will always render
    const lines = results.length === 0
        ? []
        : results.map((r, i) => {
            // Prefer iwl if present; else fall back to a sensible Work URL
            const href = r.iwl && String(r.iwl).startsWith("http")
                ? String(r.iwl)
                : `https://${IMANAGE_SERVER}/work/#/document/${encodeURIComponent(r.customerId ?? "" // if you have it
                )}/${encodeURIComponent(IMANAGE_LIBRARY_ID)}/${encodeURIComponent(r.docId ?? "")}`;
            // If you don't have customerId/docId here, just fall back to /work/
            const safeHref = href.includes("undefined")
                ? `https://${IMANAGE_SERVER}/work/`
                : href;
            const title = r.title || r.imanageUri || "Untitled";
            return `${i + 1}. [${title}](${safeHref})`;
        });
    const content = [
        {
            type: "text",
            text: results.length === 0
                ? `No results for "${q}".`
                : `Found ${results.length} document(s) for "${q}":\n\n${lines.join("\n")}`,
        },
    ];
    for (const r of results) {
        // Store mapping: opaque key -> real iManage URI (+ friendly title + iwl)
        const uri = r.imanageUri + "?q=" + encodeURIComponent(q);
        // Clickable citations: prefer HTTPS uri (iwl) with ?mcpKey=<key>
        // Copilot will cite this "source", and the user can click it.
        //const baseClickable = r.iwl && r.iwl.startsWith("http") ? r.iwl : `https://${IMANAGE_SERVER}/work/`;
        //const clickableWithKey = appendQueryParam(baseClickable, "mcpKey", key);
        content.push({
            type: "resource_link",
            uri: uri,
            name: r.title,
            mimeType: "text/plain",
            annotations: { audience: ["user"], priority: 0.8 },
            _meta: {
                imanageUri: r.imanageUri,
                iwl: r.iwl,
                matter: r.matter,
                client: r.client,
            },
        });
    }
    return { content };
});
// -------------------- Express transport --------------------
app.post("/mcp", async (req, res) => {
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
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
