import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "../../src/plugins/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJobManager, type JobManager } from "./src/job-manager.js";
import { createTranslateTool } from "./src/translate-tool.js";
import { listTranslationFiles, readTranslationLogs } from "./src/file-utils.js";

type TranslateConfig = {
  scriptPath?: string;
  defaultSource?: string;
  defaultTarget?: string;
  defaultModel?: string;
  defaultTargetLang?: string;
  defaultParallel?: number;
  defaultRetries?: number;
  defaultDelay?: number;
  preserveCode?: boolean;
  maxConcurrentJobs?: number;
};

function parseConfig(value: unknown): TranslateConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    scriptPath: typeof raw.scriptPath === "string" ? raw.scriptPath : undefined,
    defaultSource: typeof raw.defaultSource === "string" ? raw.defaultSource : undefined,
    defaultTarget: typeof raw.defaultTarget === "string" ? raw.defaultTarget : undefined,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
    defaultTargetLang: typeof raw.defaultTargetLang === "string" ? raw.defaultTargetLang : undefined,
    defaultParallel: typeof raw.defaultParallel === "number" ? raw.defaultParallel : undefined,
    defaultRetries: typeof raw.defaultRetries === "number" ? raw.defaultRetries : undefined,
    defaultDelay: typeof raw.defaultDelay === "number" ? raw.defaultDelay : undefined,
    preserveCode: typeof raw.preserveCode === "boolean" ? raw.preserveCode : undefined,
    maxConcurrentJobs: typeof raw.maxConcurrentJobs === "number" ? raw.maxConcurrentJobs : undefined,
  };
}

function resolveScriptPath(configPath?: string): string {
  if (configPath) {
    const expanded = configPath.replace(/^~/, os.homedir());
    if (fs.existsSync(expanded)) return expanded;
  }
  const defaultPath = path.join(os.homedir(), ".openclaw/workspace/TranslateMachine/translate.py");
  if (fs.existsSync(defaultPath)) return defaultPath;
  return configPath?.replace(/^~/, os.homedir()) || defaultPath;
}

const translatePlugin = {
  id: "translate-machine",
  name: "TranslateMachine",
  description: "使用 Claude CLI 批次翻譯 Markdown 檔案",

  configSchema: {
    parse: parseConfig,
    uiHints: {
      scriptPath: {
        label: "翻譯腳本路徑",
        placeholder: "~/.openclaw/workspace/TranslateMachine/translate.py",
        help: "translate.py 的絕對路徑",
      },
      defaultSource: { label: "預設來源目錄", placeholder: "./docs-en" },
      defaultTarget: { label: "預設目標目錄", placeholder: "./docs-tw" },
      defaultModel: { label: "預設模型", placeholder: "haiku" },
      defaultTargetLang: { label: "預設目標語言", placeholder: "繁體中文，台灣用語習慣" },
      defaultParallel: { label: "預設平行數量" },
      defaultRetries: { label: "預設重試次數" },
      defaultDelay: { label: "預設檔案間延遲（秒）" },
      preserveCode: { label: "程式碼區塊保護" },
      maxConcurrentJobs: { label: "最大同時執行任務數", advanced: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const scriptPath = resolveScriptPath(config.scriptPath);

    const jobManager = createJobManager({
      config: {
        scriptPath,
        maxConcurrent: config.maxConcurrentJobs ?? 2,
        defaultModel: config.defaultModel,
        defaultTargetLang: config.defaultTargetLang,
        defaultParallel: config.defaultParallel,
        defaultRetries: config.defaultRetries,
        defaultDelay: config.defaultDelay,
        preserveCode: config.preserveCode,
      },
      logger: api.logger,
    });

    // ── Agent 工具 ──────────────────────────────────────────
    api.registerTool(createTranslateTool(jobManager, {
      defaultSource: config.defaultSource,
      defaultTarget: config.defaultTarget,
      defaultModel: config.defaultModel,
      defaultTargetLang: config.defaultTargetLang,
      defaultParallel: config.defaultParallel,
    }), { optional: true });

    // ── Gateway 方法 ────────────────────────────────────────

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // translate.start — 啟動翻譯任務
    api.registerGatewayMethod(
      "translate.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const source = typeof params?.source === "string" ? params.source.trim() : "";
          const target = typeof params?.target === "string" ? params.target.trim() : "";
          if (!source || !target) {
            respond(false, { error: "source 和 target 為必填" });
            return;
          }
          const job = jobManager.startJob({
            source,
            target,
            model: typeof params?.model === "string" ? params.model : undefined,
            targetLang: typeof params?.targetLang === "string" ? params.targetLang : undefined,
            sourceLang: typeof params?.sourceLang === "string" ? params.sourceLang : undefined,
            parallel: typeof params?.parallel === "number" ? params.parallel : undefined,
            retries: typeof params?.retries === "number" ? params.retries : undefined,
            delay: typeof params?.delay === "number" ? params.delay : undefined,
            maxFiles: typeof params?.maxFiles === "number" ? params.maxFiles : undefined,
            filePattern: typeof params?.filePattern === "string" ? params.filePattern : undefined,
            glossary: typeof params?.glossary === "string" ? params.glossary : undefined,
            trimSuffix: typeof params?.trimSuffix === "string" ? params.trimSuffix : undefined,
            addSuffix: typeof params?.addSuffix === "string" ? params.addSuffix : undefined,
            preserveCode: typeof params?.preserveCode === "boolean" ? params.preserveCode : undefined,
            retryFailed: params?.retryFailed === true,
            dryRun: params?.dryRun === true,
          });
          respond(true, { jobId: job.id, started: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // translate.status — 查詢任務狀態
    api.registerGatewayMethod(
      "translate.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const jobId = typeof params?.jobId === "string" ? params.jobId.trim() : "";
        const job = jobManager.getJob(jobId);
        if (!job) {
          respond(true, { found: false });
          return;
        }
        respond(true, {
          found: true,
          job: {
            id: job.id,
            status: job.status,
            source: job.source,
            target: job.target,
            progress: job.progress,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          },
        });
      },
    );

    // translate.cancel — 取消任務
    api.registerGatewayMethod(
      "translate.cancel",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const jobId = typeof params?.jobId === "string" ? params.jobId.trim() : "";
        const ok = jobManager.cancelJob(jobId);
        respond(ok, ok ? { cancelled: true } : { error: "找不到執行中的任務" });
      },
    );

    // translate.list — 列出所有任務
    api.registerGatewayMethod(
      "translate.list",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        respond(true, { jobs: jobManager.listJobs() });
      },
    );

    // translate.output — 取得任務輸出行
    api.registerGatewayMethod(
      "translate.output",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const jobId = typeof params?.jobId === "string" ? params.jobId.trim() : "";
        const offset = typeof params?.offset === "number" ? params.offset : 0;
        const lines = jobManager.getJobOutput(jobId, offset);
        respond(true, { lines, offset: offset + lines.length });
      },
    );

    // translate.files — 列出來源/目標目錄檔案
    api.registerGatewayMethod(
      "translate.files",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sourceDir = typeof params?.source === "string" ? params.source.trim() : "";
          const targetDir = typeof params?.target === "string" ? params.target.trim() : "";
          if (!sourceDir || !targetDir) {
            respond(false, { error: "source 和 target 為必填" });
            return;
          }
          const filePattern = typeof params?.filePattern === "string" ? params.filePattern : "*.md";
          const trimSuffix = typeof params?.trimSuffix === "string" ? params.trimSuffix : undefined;
          const addSuffix = typeof params?.addSuffix === "string" ? params.addSuffix : undefined;
          const result = listTranslationFiles(sourceDir, targetDir, filePattern, trimSuffix, addSuffix);
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // translate.logs — 讀取翻譯紀錄
    api.registerGatewayMethod(
      "translate.logs",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const targetDir = typeof params?.target === "string" ? params.target.trim() : "";
          if (!targetDir) {
            respond(false, { error: "target 為必填" });
            return;
          }
          const glossaryPath = typeof params?.glossary === "string" ? params.glossary.trim() : undefined;
          const logs = readTranslationLogs(targetDir, glossaryPath || undefined);
          respond(true, logs);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // ── Dashboard HTTP 路由 ─────────────────────────────────
    const gatewayToken = api.config?.gateway?.auth?.token ?? "";
    api.registerHttpRoute({
      path: "/translate-machine",
      handler: async (_req, res) => {
        const htmlPath = path.join(import.meta.dirname, "dashboard/index.html");
        if (!fs.existsSync(htmlPath)) {
          res.statusCode = 404;
          res.end("Dashboard HTML not found");
          return;
        }
        let html = fs.readFileSync(htmlPath, "utf-8");
        // 注入 gateway auth token 供 WebSocket 握手使用
        if (gatewayToken) {
          html = html.replace(
            "<!--GATEWAY_TOKEN-->",
            `<script>window.__GATEWAY_TOKEN__=${JSON.stringify(gatewayToken)};</script>`,
          );
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      },
    });

    api.logger.info(`[translate-machine] Plugin registered (script: ${scriptPath})`);
  },
};

export default translatePlugin;
