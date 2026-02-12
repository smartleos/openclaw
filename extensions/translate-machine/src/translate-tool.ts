import { Type } from "@sinclair/typebox";
import type { JobManager } from "./job-manager.js";

type PluginConfig = {
  defaultSource?: string;
  defaultTarget?: string;
  defaultModel?: string;
  defaultTargetLang?: string;
  defaultParallel?: number;
};

export function createTranslateTool(jobManager: JobManager, pluginConfig: PluginConfig) {
  return {
    name: "translate_files",
    label: "翻譯檔案",
    description:
      "使用 TranslateMachine 批次翻譯檔案。支援啟動翻譯任務、查詢進度、取消、預覽、重試失敗檔案。",
    parameters: Type.Object({
      action: Type.Unsafe<string>({
        type: "string",
        enum: ["start", "status", "cancel", "list", "dry-run", "retry-failed"],
        description: "動作：start 啟動、status 查詢、cancel 取消、list 列出、dry-run 預覽、retry-failed 重試失敗",
      }),
      source: Type.Optional(Type.String({ description: "來源路徑" })),
      target: Type.Optional(Type.String({ description: "目標路徑" })),
      model: Type.Optional(Type.String({ description: "Claude 模型（haiku/sonnet/opus）" })),
      parallel: Type.Optional(Type.Number({ description: "平行數量" })),
      maxFiles: Type.Optional(Type.Number({ description: "最大檔案數" })),
      sourceLang: Type.Optional(Type.String({ description: "來源語言" })),
      targetLang: Type.Optional(Type.String({ description: "目標語言" })),
      filePattern: Type.Optional(Type.String({ description: "檔案 glob 模式" })),
      glossary: Type.Optional(Type.String({ description: "自訂對照表路徑" })),
      trimSuffix: Type.Optional(Type.String({ description: "從來源檔名移除的後綴" })),
      addSuffix: Type.Optional(Type.String({ description: "附加到目標檔名的後綴" })),
      retries: Type.Optional(Type.Number({ description: "重試次數" })),
      delay: Type.Optional(Type.Number({ description: "檔案間延遲秒數" })),
      preserveCode: Type.Optional(Type.Unsafe<boolean>({ type: "boolean", description: "程式碼區塊保護（預設開啟）" })),
      jobId: Type.Optional(Type.String({ description: "任務 ID（用於 status/cancel）" })),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = String(params.action || "");

      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      switch (action) {
        case "start": {
          const source = String(params.source || pluginConfig.defaultSource || "");
          const target = String(params.target || pluginConfig.defaultTarget || "");
          if (!source || !target) {
            throw new Error("必須指定 source 和 target");
          }
          const job = jobManager.startJob({
            source,
            target,
            model: params.model ? String(params.model) : pluginConfig.defaultModel,
            parallel: typeof params.parallel === "number" ? params.parallel : pluginConfig.defaultParallel,
            maxFiles: typeof params.maxFiles === "number" ? params.maxFiles : undefined,
            sourceLang: params.sourceLang ? String(params.sourceLang) : undefined,
            targetLang: params.targetLang ? String(params.targetLang) : pluginConfig.defaultTargetLang,
            filePattern: params.filePattern ? String(params.filePattern) : undefined,
            glossary: params.glossary ? String(params.glossary) : undefined,
            trimSuffix: params.trimSuffix ? String(params.trimSuffix) : undefined,
            addSuffix: params.addSuffix ? String(params.addSuffix) : undefined,
            retries: typeof params.retries === "number" ? params.retries : undefined,
            delay: typeof params.delay === "number" ? params.delay : undefined,
            preserveCode: typeof params.preserveCode === "boolean" ? params.preserveCode : undefined,
          });
          return json({ jobId: job.id, status: job.status, source, target });
        }

        case "dry-run": {
          const source = String(params.source || pluginConfig.defaultSource || "");
          const target = String(params.target || pluginConfig.defaultTarget || "");
          if (!source || !target) {
            throw new Error("必須指定 source 和 target");
          }
          const job = jobManager.startJob({
            source,
            target,
            dryRun: true,
            filePattern: params.filePattern ? String(params.filePattern) : undefined,
          });
          return json({ jobId: job.id, status: "dry-run", source, target });
        }

        case "retry-failed": {
          const source = String(params.source || pluginConfig.defaultSource || "");
          const target = String(params.target || pluginConfig.defaultTarget || "");
          if (!source || !target) {
            throw new Error("必須指定 source 和 target");
          }
          const job = jobManager.startJob({
            source,
            target,
            retryFailed: true,
            model: params.model ? String(params.model) : pluginConfig.defaultModel,
            parallel: typeof params.parallel === "number" ? params.parallel : pluginConfig.defaultParallel,
            glossary: params.glossary ? String(params.glossary) : undefined,
            trimSuffix: params.trimSuffix ? String(params.trimSuffix) : undefined,
            addSuffix: params.addSuffix ? String(params.addSuffix) : undefined,
            retries: typeof params.retries === "number" ? params.retries : undefined,
            delay: typeof params.delay === "number" ? params.delay : undefined,
            preserveCode: typeof params.preserveCode === "boolean" ? params.preserveCode : undefined,
          });
          return json({ jobId: job.id, status: job.status, source, target, mode: "retry-failed" });
        }

        case "status": {
          const jobId = String(params.jobId || "");
          if (!jobId) {
            throw new Error("必須指定 jobId");
          }
          const job = jobManager.getJob(jobId);
          if (!job) {
            return json({ found: false, jobId });
          }
          return json({
            found: true,
            id: job.id,
            status: job.status,
            source: job.source,
            target: job.target,
            progress: job.progress,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          });
        }

        case "cancel": {
          const jobId = String(params.jobId || "");
          if (!jobId) {
            throw new Error("必須指定 jobId");
          }
          const ok = jobManager.cancelJob(jobId);
          return json({ cancelled: ok, jobId });
        }

        case "list": {
          const jobs = jobManager.listJobs();
          return json({
            jobs: jobs.map((j) => ({
              id: j.id,
              status: j.status,
              source: j.source,
              target: j.target,
              progress: j.progress,
              startedAt: j.startedAt,
              completedAt: j.completedAt,
            })),
          });
        }

        default:
          throw new Error(`未知動作: ${action}。可用: start, status, cancel, list, dry-run, retry-failed`);
      }
    },
  };
}
