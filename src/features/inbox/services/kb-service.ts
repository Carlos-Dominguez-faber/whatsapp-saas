// F7: Knowledge base service — ingest documents, chunk, embed, and search with pgvector.

import { createClient as createSbClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function getEmbeddingModel() {
  const openai = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!,
  });
  return openai.embedding("openai/text-embedding-3-small");
}

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
// The query embedding runs inside the agent's turn: a hung provider must not
// eat the time the buffer reserved for the model and the send.
const QUERY_EMBED_TIMEOUT_MS = 15_000;

/**
 * Splits text into overlapping windows of CHUNK_SIZE chars.
 * Overlap keeps semantic continuity across chunk boundaries.
 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

/**
 * Returns true when embedding calls should be skipped.
 * Graceful degradation when OPENROUTER_API_KEY is a placeholder.
 */
function isEmbeddingDisabled(): boolean {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  return !key || key === "placeholder";
}

export interface IngestDocumentResult {
  documentId: string;
  chunksCreated: number;
}

/**
 * Ingests a document into the knowledge base.
 * Steps:
 *  1. INSERT into kb_documents
 *  2. Split content into overlapping chunks
 *  3. Embed all chunks via OpenRouter (skipped when key is placeholder)
 *  4. INSERT into kb_chunks with embeddings
 */
export async function ingestDocument(opts: {
  workspaceId: string;
  title: string;
  content: string;
  sourceType?: string;
  /** Extra document metadata, e.g. { source_url } for URL sources. */
  meta?: Record<string, unknown>;
}): Promise<IngestDocumentResult> {
  const supabase = svc();
  // Default must satisfy the kb_documents CHECK (source_type IN
  // 'doc','faq','url','snippet'); the old 'manual' default raised a 23514 on any
  // caller that omitted sourceType.
  const { workspaceId, title, content, sourceType = "doc", meta } = opts;

  // 1. Insert document record
  const { data: doc, error: docError } = await supabase
    .from("kb_documents")
    .insert({
      workspace_id: workspaceId,
      title,
      content,
      source_type: sourceType,
      ...(meta ? { meta } : {}),
    })
    .select("id")
    .single();

  if (docError || !doc) {
    throw new Error(
      `[kb-service] failed to insert document: ${docError?.message}`,
    );
  }

  const documentId = doc.id as string;

  // 2. Chunk the content
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return { documentId, chunksCreated: 0 };
  }

  // 3. Embed chunks (or use empty vectors when disabled)
  let embeddings: number[][];

  if (isEmbeddingDisabled()) {
    console.warn(
      "[kb-service] OPENROUTER_API_KEY is placeholder — storing chunks without embeddings",
    );
    embeddings = chunks.map(() => new Array(1536).fill(0) as number[]);
  } else {
    const result = await embedMany({
      model: getEmbeddingModel(),
      values: chunks,
    });
    embeddings = result.embeddings;
  }

  // 4. Insert chunks with their embeddings
  const chunkRows = chunks.map((chunkContent, idx) => ({
    workspace_id: workspaceId,
    document_id: documentId,
    chunk_index: idx,
    content: chunkContent,
    embedding: embeddings[idx],
  }));

  const { error: chunkError } = await supabase
    .from("kb_chunks")
    .insert(chunkRows);

  if (chunkError) {
    console.error("[kb-service] failed to insert chunks:", chunkError);
    throw new Error(
      `[kb-service] failed to insert chunks: ${chunkError.message}`,
    );
  }

  return { documentId, chunksCreated: chunks.length };
}

export interface KbSearchResult {
  chunk: string;
  document_title: string;
  document_id: string;
  similarity: number;
}

/**
 * Semantic similarity search over the knowledge base.
 * Embeds the query, then uses pgvector cosine distance to find top-K chunks.
 * Falls back to an empty result set when embeddings are disabled.
 */
export async function searchKb(
  workspaceId: string,
  query: string,
  topK = 3,
): Promise<KbSearchResult[]> {
  if (isEmbeddingDisabled()) {
    console.warn(
      "[kb-service] OPENROUTER_API_KEY is placeholder — KB search unavailable",
    );
    return [];
  }

  const supabase = svc();

  // Embed the query
  const { embedding: queryEmbedding } = await embed({
    model: getEmbeddingModel(),
    value: query,
    abortSignal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
  });

  // pgvector cosine distance search via RPC
  // The function `match_kb_chunks` must exist in the DB (see migration notes).
  const { data, error } = await supabase.rpc("match_kb_chunks", {
    p_workspace_id: workspaceId,
    p_query_embedding: queryEmbedding,
    p_match_count: topK,
  });

  if (error) {
    // Fallback: try raw SQL via execute if RPC doesn't exist yet
    console.error(
      "[kb-service] match_kb_chunks RPC error, attempting fallback:",
      error,
    );
    return await searchKbFallback(supabase, workspaceId, queryEmbedding, topK);
  }

  return (data ?? []).map(
    (row: {
      chunk_content: string;
      document_title: string;
      document_id: string;
      similarity: number;
    }) => ({
      chunk: row.chunk_content,
      document_title: row.document_title,
      document_id: row.document_id,
      similarity: row.similarity,
    }),
  );
}

/**
 * Fallback search using Supabase's execute_sql RPC when the dedicated
 * match_kb_chunks function is not yet deployed.
 */
async function searchKbFallback(
  supabase: ReturnType<typeof svc>,
  workspaceId: string,
  queryEmbedding: number[],
  topK: number,
): Promise<KbSearchResult[]> {
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const { data, error } = await supabase.rpc("execute_sql", {
    sql: `
      SELECT
        kc.content        AS chunk_content,
        kd.title          AS document_title,
        kc.document_id    AS document_id,
        1 - (kc.embedding <=> '${embeddingLiteral}'::vector) AS similarity
      FROM kb_chunks kc
      JOIN kb_documents kd ON kc.document_id = kd.id
      WHERE kd.workspace_id = '${workspaceId}'
      ORDER BY kc.embedding <=> '${embeddingLiteral}'::vector
      LIMIT ${topK};
    `,
  });

  if (error) {
    console.error("[kb-service] fallback search error:", error);
    return [];
  }

  return (data ?? []).map(
    (row: {
      chunk_content: string;
      document_title: string;
      document_id: string;
      similarity: number;
    }) => ({
      chunk: row.chunk_content,
      document_title: row.document_title,
      document_id: row.document_id,
      similarity: row.similarity,
    }),
  );
}

/**
 * Formats KB search results into a string block for injection
 * into the AI system prompt context.
 */
export function formatKbContext(results: KbSearchResult[]): string {
  if (results.length === 0) return "";

  const blocks = results.map(
    (r) => `[Fuente: ${r.document_title}]\n${r.chunk}`,
  );

  return `## Base de Conocimiento\n\n${blocks.join("\n\n")}`;
}

export interface KbSourceLink {
  title: string;
  url: string;
}

/**
 * Returns the source URLs of URL-type KB documents so the agent can share the
 * actual page link (semantic chunks rarely surface the URL on their own).
 */
export async function listKbSourceLinks(
  workspaceId: string,
): Promise<KbSourceLink[]> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("kb_documents")
    .select("title, meta")
    .eq("workspace_id", workspaceId)
    .eq("source_type", "url")
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  const links: KbSourceLink[] = [];
  for (const row of data) {
    const url = (row.meta as { source_url?: string } | null)?.source_url;
    if (typeof url === "string" && url.trim()) {
      links.push({ title: (row.title as string) ?? url, url: url.trim() });
    }
  }
  return links;
}

/**
 * Prompt block that lists shareable reference URLs. Injected alongside the KB
 * chunk context so the agent can hand the customer a link when asked for a
 * page or "más información".
 */
export function formatKbReferenceLinks(links: KbSourceLink[]): string {
  if (links.length === 0) return "";

  const lines = links.map((l) => `- ${l.title}: ${l.url}`);
  return (
    "## Páginas de referencia\n" +
    "Si la persona pide más información, un enlace o una página, comparte el enlace adecuado de esta lista:\n" +
    lines.join("\n")
  );
}

/**
 * Lists all documents in the knowledge base for a workspace.
 */
export async function listKbDocuments(workspaceId: string): Promise<unknown[]> {
  const supabase = svc();

  const { data, error } = await supabase
    .from("kb_documents")
    .select("id, title, source_type, meta, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`[kb-service] listKbDocuments error: ${error.message}`);
  }

  return data ?? [];
}
