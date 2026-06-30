import mongoose from "mongoose";

import { callDeepSeekChat, readDeepSeekApiKey } from "../deepseek/callDeepSeekChat.js";
import { callOllamaChat, readOllamaEnv } from "../ollama/callOllamaChat.js";
import { resolveEmbedBackendModel } from "../constants/taskCatalog.js";
import { callOllamaEmbed } from "../ollama/callOllamaEmbed.js";
import { resolveBackendModel } from "../constants/taskCatalog.js";
import { FAQ_ANSWERABLE_VALUES, FAQ_INTENT_VALUES } from "../constants/faqDocument.js";
import { ChatJobModel, type ChatJobDocument } from "../models/ChatJob.js";
import { FaqConstantModel } from "../models/faqConstant.js";
import { classifyRagJobAnalysis } from "./classifyRagJobAnalysis.js";
import { routeMcpTools } from "./mcpRouter.js";
import { releaseStaleRunningChatJobs } from "./releaseStaleRunningChatJobs.js";
import { getPlanBySlugFromRegistry } from "../services/planRegistry.js";
import type { FaqChunkHit } from "../qdrant/faqChunks.js";
import { searchFaqChunks } from "../qdrant/faqChunks.js";
import { searchFaqChunksText } from "../services/faqTextSearch.js";
import { getMcpSettings } from "../services/mcpSettingsService.js";
import { callMcpTool, listMcpTools, withMcpClient } from "../services/mcpClient.js";
import { appendSessionAssistantMessage } from "../services/chatSessionService.js";
import { DEFAULT_CHAT_SYSTEM_GUARDRAILS } from "../constants/chatSystemGuardrails.js";
import { resolveRagSystemLayers } from "../services/faqConstantsCore.js";

type ChatJobRunnerContext = {
  doc: ChatJobDocument;
  jobObjectId: mongoose.Types.ObjectId;
};

type RunnerMessage = { role: string; content: string; images?: string[] };

type CompletionOut = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  useDeepSeek: boolean;
};

/**
 * Whether main chat should use DeepSeek and the resolved overload threshold.
 * **`useDeepSeek`** is true only when **`DEEPSEEK_API_KEY`** is set, the job's plan has **`isPriority`**,
 * and **`runningCount` > `threshold`**, where **`threshold`** comes from **`CHAT_JOB_MAX_RUNNING_LOCAL_OLLAMA`**
 * (default **8**).
 */
function resolveDeepSeekMainChatRouting(params: {
  runningCount: number;
  jobPlanSlug: string;
}): { useDeepSeek: boolean; threshold: number } {
  const raw = process.env.CHAT_JOB_MAX_RUNNING_LOCAL_OLLAMA?.trim();
  const threshold = !raw ? 8 : (() => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 8;
  })();

  if (readDeepSeekApiKey() == null) {
    return { useDeepSeek: false, threshold };
  }
  const plan = getPlanBySlugFromRegistry(params.jobPlanSlug);
  if (!plan?.isPriority) {
    return { useDeepSeek: false, threshold };
  }
  return { useDeepSeek: params.runningCount > threshold, threshold };
}

function runErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapJobInputToMessages(doc: ChatJobDocument): RunnerMessage[] {
  return doc.input.map((m) => {
    const msg: RunnerMessage = { role: m.role, content: m.content };
    const images = (m as { images?: string[] }).images;
    if (Array.isArray(images) && images.length > 0) {
      msg.images = images;
    }
    return msg;
  });
}

function resolveJobBackendModel(doc: ChatJobDocument): string {
  const taskType = String(doc.taskType ?? "").trim();
  const label = String(doc.get("model") ?? "").trim();
  return resolveBackendModel(taskType, label);
}

function logDeepSeekRoutingWarnings(
  logPrefix: string,
  runningCount: number,
  threshold: number,
  useDeepSeek: boolean,
  jobPlanSlug: string,
): void {
  if (runningCount <= threshold) return;

  if (useDeepSeek) {
    console.warn(
      `${logPrefix} ${runningCount} jobs running (>${threshold}), plan=${jobPlanSlug}   routing main completion to DeepSeek`,
    );
  } else if (!readDeepSeekApiKey()) {
    console.warn(
      `${logPrefix} ${runningCount} jobs running (>${threshold}); DEEPSEEK_API_KEY unset   using Ollama for main completion`,
    );
  } else {
    console.warn(
      `${logPrefix} ${runningCount} jobs running (>${threshold}); plan=${jobPlanSlug}   DeepSeek overflow requires priority plan, using Ollama`,
    );
  }
}

function withGuardrails(messages: RunnerMessage[]): RunnerMessage[] {
  const out = [...messages];
  out.unshift({ role: "system", content: DEFAULT_CHAT_SYSTEM_GUARDRAILS });
  return out;
}

function withRagSystemLayers(
  messages: RunnerMessage[],
  guardrails: string,
  tone: string | null,
): RunnerMessage[] {
  const out = [...messages];
  out.unshift({ role: "system", content: guardrails });
  if (tone) {
    out.splice(1, 0, { role: "system", content: tone });
  }
  return out;
}

async function runRoutedMainCompletion(
  ctx: ChatJobRunnerContext,
  messages: RunnerMessage[],
  logPrefix: string,
): Promise<CompletionOut> {
  const { doc } = ctx;
  const resolvedModelId = resolveJobBackendModel(doc);
  const { baseUrl, temperature, think } = readOllamaEnv();

  const runningCount = await ChatJobModel.countDocuments({ status: "running" });
  const jobPlanSlug = String(doc.get("plan") ?? "unknown");
  const { useDeepSeek, threshold } = resolveDeepSeekMainChatRouting({ runningCount, jobPlanSlug });
  logDeepSeekRoutingWarnings(logPrefix, runningCount, threshold, useDeepSeek, jobPlanSlug);

  return runMainCompletion({
    doc,
    messages,
    resolvedModelId,
    useDeepSeek,
    baseUrl,
    temperature,
    think,
    logPrefix,
  });
}

async function runMainCompletion(params: {
  doc: ChatJobDocument;
  messages: RunnerMessage[];
  resolvedModelId: string;
  useDeepSeek: boolean;
  baseUrl: string;
  temperature: number;
  think: boolean;
  logPrefix?: string;
}): Promise<CompletionOut> {
  const maxTokens = params.doc.maxTokens ?? 500;
  if (params.useDeepSeek) {
    try {
      const out = await callDeepSeekChat({
        messages: params.messages,
        temperature: params.temperature,
        maxTokens,
      });
      return { ...out, useDeepSeek: true };
    } catch (err) {
      const prefix = params.logPrefix ?? "[runMainCompletion]";
      console.warn(`${prefix} DeepSeek failed, falling back to Ollama:`, err);
    }
  }
  const out = await callOllamaChat({
    baseUrl: params.baseUrl,
    model: params.resolvedModelId,
    messages: params.messages,
    temperature: params.temperature,
    maxTokens,
    think: params.think,
  });
  return { ...out, useDeepSeek: false };
}

async function persistCompletedFull(
  jobObjectId: mongoose.Types.ObjectId,
  out: CompletionOut,
  logPrefix: string,
): Promise<void> {
  const doneRes = await ChatJobModel.updateOne(
    { _id: jobObjectId, status: "running" },
    {
      $set: {
        status: "completed_full",
        finishedAt: new Date(),
        useDeepSeek: out.useDeepSeek,
        result: {
          text: out.text,
          json: null,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          totalTokens: out.promptTokens + out.completionTokens,
        },
      },
    },
  );
  if (doneRes.matchedCount === 0) {
    console.warn(`${logPrefix} completed_full persist skipped (job not running); id=${String(jobObjectId)}`);
  }
}

function appendSessionAssistantIfPresent(doc: ChatJobDocument, text: string | undefined | null): void {
  const trimmed = text?.trim();
  const sessionId = doc.sessionId ? String(doc.sessionId) : "";
  if (!sessionId || !trimmed) return;
  void appendSessionAssistantMessage(sessionId, trimmed).catch((err) => {
    console.warn("[runChatJobById] appendSessionAssistantMessage failed:", runErrorMessage(err));
  });
}

async function markJobFailedFromRunning(
  jobId: mongoose.Types.ObjectId,
  err: unknown,
  code: string,
): Promise<void> {
  await ChatJobModel.updateOne(
    { _id: jobId, status: "running" },
    {
      $set: {
        status: "failed",
        finishedAt: new Date(),
        error: {
          message: runErrorMessage(err),
          code,
        },
      },
    },
  );
}

/** If the job is still `running`, mark failed (e.g. `catch` path could not persist). */
async function finalizeStillRunningFromWorker(jobId: mongoose.Types.ObjectId): Promise<void> {
  try {
    await ChatJobModel.updateOne(
      { _id: jobId, status: "running" },
      {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          error: {
            message:
              "Runner exited without completing the job; another worker may have reclaimed it or persistence failed.",
            code: "RUN_ABORTED",
          },
        },
      },
    );
  } catch {
    /* best-effort */
  }
}

async function runChatTaskJob(ctx: ChatJobRunnerContext): Promise<void> {
  const { jobObjectId } = ctx;
  const logPrefix = "[runChatTaskJob]";

  const messages = withGuardrails(mapJobInputToMessages(ctx.doc));
  const out = await runRoutedMainCompletion(ctx, messages, logPrefix);
  await persistCompletedFull(jobObjectId, out, logPrefix);
  appendSessionAssistantIfPresent(ctx.doc, out.text);
}

const RAG_CONTEXT_LIMIT = 5;
const RAG_RETRIEVAL_POOL = 20;
const RAG_RRF_K = 60;

function ragChunkHitKey(hit: FaqChunkHit): string {
  const id = hit.chunkId?.trim();
  if (id) return id;
  return hit.text.trim().slice(0, 512);
}

/** Reciprocal rank fusion of dense (Qdrant) and sparse (BM25) lists. */
function mergeRagRetrievalHits(denseHits: FaqChunkHit[], bm25Hits: FaqChunkHit[]): FaqChunkHit[] {
  const fused = new Map<string, { hit: FaqChunkHit; score: number }>();

  const addList = (list: FaqChunkHit[]) => {
    list.forEach((hit, rank) => {
      const key = ragChunkHitKey(hit);
      if (!key) return;
      const rrf = 1 / (RAG_RRF_K + rank + 1);
      const prev = fused.get(key);
      if (prev) {
        prev.score += rrf;
        if (!prev.hit.text.trim() && hit.text.trim()) prev.hit = hit;
      } else {
        fused.set(key, { hit, score: rrf });
      }
    });
  };

  addList(denseHits);
  addList(bm25Hits);

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, RAG_CONTEXT_LIMIT)
    .map(({ hit, score }) => ({ ...hit, score }));
}

function findLastUserMessage(messages: RunnerMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return (lastUser?.content || messages[messages.length - 1]?.content || "").trim();
}

function lastUserMessageIndex(messages: RunnerMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return messages.length - 1;
}

async function retrieveRagHits(
  apiKeyId: string,
  question: string,
  baseUrl: string,
): Promise<FaqChunkHit[]> {
  const embedModel = resolveEmbedBackendModel();
  let denseHits: FaqChunkHit[] = [];
  let bm25Hits: FaqChunkHit[] = [];

  try {
    const emb = await callOllamaEmbed({ baseUrl, model: embedModel, input: question });
    const qvec = emb.embeddings?.[0];
    if (Array.isArray(qvec) && qvec.length > 0) {
      denseHits = await searchFaqChunks({
        apiKeyId,
        vector: qvec,
        limit: RAG_RETRIEVAL_POOL,
      });
    }
  } catch (e) {
    console.warn("[RAG] dense retrieval failed:", e);
  }

  try {
    bm25Hits = await searchFaqChunksText({
      apiKeyId,
      query: question,
      limit: RAG_RETRIEVAL_POOL,
    });
  } catch (e) {
    console.warn("[RAG] BM25 retrieval failed:", e);
  }

  const merged = mergeRagRetrievalHits(denseHits, bm25Hits);
  console.log(`[RAG] dense=${denseHits.length} bm25=${bm25Hits.length} merged=${merged.length}`);
  return merged;
}

function injectRagContext(messages: RunnerMessage[], hits: FaqChunkHit[]): void {
  if (hits.length === 0) return;

  const context = hits
    .map((h, i) => `[#${i + 1} score=${h.score.toFixed(3)}]\n${h.text}`)
    .join("\n\n---\n\n");

  const userIdx = lastUserMessageIndex(messages);
  messages.splice(userIdx, 0, {
    role: "system",
    content:
      "You are a helpful FAQ assistant. Answer short, clear, and helpful using the FAQ context below when relevant. " +
      "If the context does not contain the answer, say you don't know.\n\n" +
      `FAQ context:\n\n${context}`,
  });
}

function injectMcpContext(messages: RunnerMessage[], toolName: string, result: string): void {
  const trimmed = result.trim();
  if (!trimmed) return;
  const userIdx = lastUserMessageIndex(messages);
  messages.splice(userIdx, 0, {
    role: "system",
    content:
      `External tool result (${toolName}):\n${trimmed}\n\n` +
      "Use this together with FAQ context when answering. Prefer the tool result for live or account-specific data.",
  });
}

async function persistRagPartial(
  jobObjectId: mongoose.Types.ObjectId,
  out: CompletionOut,
  logPrefix: string,
): Promise<boolean> {
  const chatTotalTokens = out.promptTokens + out.completionTokens;
  const partialRes = await ChatJobModel.updateOne(
    { _id: jobObjectId, status: "running" },
    {
      $set: {
        status: "completed_partial",
        finishedAt: new Date(),
        useDeepSeek: out.useDeepSeek,
        result: {
          text: out.text,
          json: null,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          totalTokens: chatTotalTokens,
        },
      },
    },
  );
  if (partialRes.matchedCount === 0) {
    console.warn(`${logPrefix} RAG partial persist skipped (job not running); id=${String(jobObjectId)}`);
    return false;
  }
  console.log("[RAG dev] persisted answer (chat tokens only); running classifier");
  return true;
}

async function loadRagClassifierContext(doc: ChatJobDocument) {
  const faqConst = await FaqConstantModel.findOne({
    userId: doc.userId,
    apiKeyId: doc.apiKeyId,
  })
    .select("categories")
    .lean()
    .exec();
  const allowedCategories = Array.isArray(faqConst?.categories)
    ? faqConst.categories.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  return {
    allowedCategories,
    allowedAnswerable: [...FAQ_ANSWERABLE_VALUES],
    allowedIntent: [...FAQ_INTENT_VALUES],
  };
}

async function finalizeRagJob(params: {
  jobObjectId: mongoose.Types.ObjectId;
  doc: ChatJobDocument;
  out: CompletionOut;
  ragQuestion: string;
  ragRetrievalHits: FaqChunkHit[];
  resolvedModelId: string;
  baseUrl: string;
  temperature: number;
  logPrefix: string;
}): Promise<void> {
  const { jobObjectId, doc, out, ragQuestion, ragRetrievalHits, resolvedModelId, baseUrl, temperature, logPrefix } =
    params;

  let promptTokensTotal = out.promptTokens;
  let completionTokensTotal = out.completionTokens;

  const { allowedCategories, allowedAnswerable, allowedIntent } = await loadRagClassifierContext(doc);

  let classified: Awaited<ReturnType<typeof classifyRagJobAnalysis>> = null;
  try {
    classified = await classifyRagJobAnalysis({
      baseUrl,
      model: resolvedModelId,
      temperature,
      question: ragQuestion,
      assistantAnswer: out.text ?? "",
      retrievalHits: ragRetrievalHits,
      allowedCategories,
      allowedAnswerable,
      allowedIntent,
    });
  } catch (e) {
    console.error("[RAG dev] classification: skipped | reason: exception", e);
  }

  const ragAnalysis = classified
    ? {
        category: classified.category,
        answerable: classified.answerable,
        intent: classified.intent,
      }
    : {
        category: null as string | null,
        answerable: "unclear",
        intent: "what_is",
      };

  if (classified) {
    promptTokensTotal += classified.promptTokens;
    completionTokensTotal += classified.completionTokens;
  }

  const totalTokens = promptTokensTotal + completionTokensTotal;

  try {
    const fullRes = await ChatJobModel.updateOne(
      { _id: jobObjectId, status: "completed_partial" },
      {
        $set: {
          status: "completed_full",
          ragAnalysis,
          result: {
            text: out.text,
            json: null,
            promptTokens: promptTokensTotal,
            completionTokens: completionTokensTotal,
            totalTokens,
          },
        },
      },
    );
    if (fullRes.matchedCount === 0) {
      console.warn(`${logPrefix} RAG final persist skipped (not completed_partial); id=${String(jobObjectId)}`);
    }
  } catch (e) {
    console.log("[RAG dev] second persist (ragAnalysis/tokens) failed; answer already saved:", e);
  }
  appendSessionAssistantIfPresent(doc, out.text);
}

async function runRagTaskJob(ctx: ChatJobRunnerContext): Promise<void> {
  const { doc, jobObjectId } = ctx;
  const logPrefix = "[runRagTaskJob]";

  const messages = mapJobInputToMessages(doc);
  const { baseUrl, temperature } = readOllamaEnv();
  const resolvedModelId = resolveJobBackendModel(doc);
  const ragQuestion = findLastUserMessage(messages);
  let ragRetrievalHits: FaqChunkHit[] = [];
  let mcpToolName: string | null = null;
  let mcpToolResult: string | null = null;
  let clarifyMessage: string | null = null;

  try {
    const settings = await getMcpSettings(
      doc.userId as mongoose.Types.ObjectId,
      doc.apiKeyId as mongoose.Types.ObjectId,
    );
    if (settings.enabled && settings.mcpPlanEligible && settings.mcpUrl.trim()) {
      await withMcpClient(
        { mcpUrl: settings.mcpUrl, headers: settings.headers, body: settings.body },
        async (client) => {
          const tools = await listMcpTools(client);
          const decision = await routeMcpTools({
            baseUrl,
            model: resolvedModelId,
            temperature,
            messages,
            tools,
          });
          if (decision.action === "clarify") {
            clarifyMessage = decision.message;
            return;
          }
          if (decision.action === "call") {
            try {
              mcpToolName = decision.tool;
              mcpToolResult = await callMcpTool(client, decision.tool, decision.args);
            } catch (e) {
              console.warn(`${logPrefix} MCP call failed:`, e);
              mcpToolName = null;
              mcpToolResult = null;
            }
          }
        },
      );
    }
  } catch (e) {
    console.warn(`${logPrefix} MCP routing skipped:`, e);
  }

  if (clarifyMessage) {
    await persistCompletedFull(
      jobObjectId,
      { text: clarifyMessage, promptTokens: 0, completionTokens: 0, useDeepSeek: false },
      logPrefix,
    );
    appendSessionAssistantIfPresent(doc, clarifyMessage);
    return;
  }

  if (ragQuestion) {
    const hits = await retrieveRagHits(String(doc.apiKeyId), ragQuestion, baseUrl);
    if (hits.length > 0) {
      ragRetrievalHits = hits;
      injectRagContext(messages, hits);
    } else {
      console.warn(`[RAG] no FAQ chunks retrieved for apiKeyId=${String(doc.apiKeyId)}`);
    }
  }

  if (mcpToolName && mcpToolResult) {
    injectMcpContext(messages, mcpToolName, mcpToolResult);
  }

  const { guardrails, tone } = await resolveRagSystemLayers(
    doc.userId as mongoose.Types.ObjectId,
    doc.apiKeyId as mongoose.Types.ObjectId,
  );
  const guardedMessages = withRagSystemLayers(messages, guardrails, tone);
  const out = await runRoutedMainCompletion(ctx, guardedMessages, logPrefix);

  console.log("[RAG dev] generatedAnswer:\n" + (out.text ?? ""));

  const persisted = await persistRagPartial(jobObjectId, out, logPrefix);
  if (!persisted) return;

  await finalizeRagJob({
    jobObjectId,
    doc,
    out,
    ragQuestion,
    ragRetrievalHits,
    resolvedModelId,
    baseUrl,
    temperature,
    logPrefix,
  });
}

async function runTranslateTaskJob(ctx: ChatJobRunnerContext): Promise<void> {
  const { doc, jobObjectId } = ctx;
  const logPrefix = "[runTranslateTaskJob]";

  const messages = mapJobInputToMessages(doc);
  const resolvedModelId = resolveJobBackendModel(doc);
  const { baseUrl, temperature, think } = readOllamaEnv();

  const out = await callOllamaChat({
    baseUrl,
    model: resolvedModelId,
    messages,
    temperature,
    maxTokens: doc.maxTokens ?? 500,
    think,
  });

  await persistCompletedFull(jobObjectId, { ...out, useDeepSeek: false }, logPrefix);
  appendSessionAssistantIfPresent(doc, out.text);
}

async function runOcrTaskJob(ctx: ChatJobRunnerContext): Promise<void> {
  const { doc, jobObjectId } = ctx;
  const logPrefix = "[runOcrTaskJob]";

  const messages = mapJobInputToMessages(doc);
  const resolvedModelId = resolveJobBackendModel(doc);
  const { baseUrl, temperature, think } = readOllamaEnv();

  const out = await callOllamaChat({
    baseUrl,
    model: resolvedModelId,
    messages,
    temperature,
    maxTokens: doc.maxTokens ?? 500,
    think,
  });

  await persistCompletedFull(jobObjectId, { ...out, useDeepSeek: false }, logPrefix);
  appendSessionAssistantIfPresent(doc, out.text);
}

/**
 * Executes a single job by id. Used by the queue runner after `claimNextChatJob`,
 * or call directly to run a pending job without waiting for the queue (e.g. admin / paid inline).
 *
 * Dispatches to {@link runChatTaskJob}, {@link runRagTaskJob}, or {@link runTranslateTaskJob}
 * after loading/claiming the document. Terminal writes use status filters so a stale sweeper
 * cannot be overwritten by a late completion from an old execution.
 * Kicks `releaseStaleRunningChatJobs` **without awaiting** so stale rows can be reclaimed in parallel
 * with this job’s embed / retrieval / chat work (interval in `index.ts` still runs on a timer).
 */
export async function runChatJobById(jobId: string): Promise<void> {
  let doc = await ChatJobModel.findById(jobId);
  if (!doc) return;

  if (doc.status === "completed_partial" || doc.status === "completed_full" || doc.status === "failed" || doc.status === "cancelled") {
    return;
  }

  if (doc.status === "pending") {
    const claimed = await ChatJobModel.findOneAndUpdate(
      { _id: doc._id, status: "pending" },
      { $set: { status: "running", startedAt: new Date() } },
      { new: true },
    );
    if (!claimed) return;
    doc = claimed;
  }

  if (doc.status !== "running") return;

  const jobObjectId = doc._id;

  try {
    if (doc.input.length === 0) {
      throw new Error("Job input has no messages; add at least one message with role and content.");
    }

    void releaseStaleRunningChatJobs().catch((err: unknown) => {
      console.error("[runChatJobById] releaseStaleRunningChatJobs:", err);
    });

    const ctx: ChatJobRunnerContext = { doc, jobObjectId };

    switch (doc.taskType) {
      case "chat":
        await runChatTaskJob(ctx);
        break;
      case "rag":
        await runRagTaskJob(ctx);
        break;
      case "translate":
        await runTranslateTaskJob(ctx);
        break;
      case "ocr":
        await runOcrTaskJob(ctx);
        break;
      default:
        throw new Error(`Unsupported task type: ${String(doc.taskType)}`);
    }
  } catch (err: unknown) {
    try {
      await markJobFailedFromRunning(jobObjectId, err, "RUN_ERROR");
    } catch (persistErr) {
      console.error("[runChatJobById] failed to persist RUN_ERROR:", persistErr);
    }
  } finally {
    await finalizeStillRunningFromWorker(jobObjectId);
  }
}
