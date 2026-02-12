import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type TranslationJob = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  source: string;
  target: string;
  startedAt: number;
  completedAt?: number;
  progress: {
    total: number;
    completed: number;
    failed: number;
    currentFile?: string;
  };
  outputLines: string[];
  pid?: number;
};

export type StartJobOptions = {
  source: string;
  target: string;
  model?: string;
  targetLang?: string;
  sourceLang?: string;
  parallel?: number;
  retries?: number;
  delay?: number;
  maxFiles?: number;
  filePattern?: string;
  glossary?: string;
  trimSuffix?: string;
  addSuffix?: string;
  preserveCode?: boolean;
  retryFailed?: boolean;
  dryRun?: boolean;
};

export type JobManagerConfig = {
  scriptPath: string;
  maxConcurrent: number;
  defaultModel?: string;
  defaultTargetLang?: string;
  defaultParallel?: number;
  defaultRetries?: number;
  defaultDelay?: number;
  preserveCode?: boolean;
};

export type JobManager = ReturnType<typeof createJobManager>;

export function createJobManager(params: {
  config: JobManagerConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}) {
  const { config, logger } = params;
  const jobs = new Map<string, TranslationJob>();
  const processes = new Map<string, ChildProcess>();

  function startJob(opts: StartJobOptions): TranslationJob {
    // 檢查最大同時執行數
    const runningCount = [...jobs.values()].filter((j) => j.status === "running").length;
    if (runningCount >= config.maxConcurrent) {
      throw new Error(`已達最大同時執行任務數 (${config.maxConcurrent})`);
    }

    // 禁止兩個任務寫同一個目標目錄
    for (const j of jobs.values()) {
      if (j.status === "running" && j.target === opts.target) {
        throw new Error(`目標目錄 ${opts.target} 已有執行中的任務 (${j.id})`);
      }
    }

    const job: TranslationJob = {
      id: `translate-${Date.now()}`,
      status: "running",
      source: opts.source,
      target: opts.target,
      startedAt: Date.now(),
      progress: { total: 0, completed: 0, failed: 0 },
      outputLines: [],
    };

    // 組合指令參數
    const args = [
      config.scriptPath,
      "--source", opts.source,
      "--target", opts.target,
      "--model", opts.model || config.defaultModel || "haiku",
      "--target-lang", opts.targetLang || config.defaultTargetLang || "繁體中文，台灣用語習慣",
      "--parallel", String(opts.parallel ?? config.defaultParallel ?? 1),
      "--retries", String(opts.retries ?? config.defaultRetries ?? 2),
      "--delay", String(opts.delay ?? config.defaultDelay ?? 3),
      "--output-format", "json",
      "--no-interactive",
      "--pause-every", "0",
    ];

    if (opts.sourceLang) {
      args.push("--source-lang", opts.sourceLang);
    }
    if (opts.maxFiles && opts.maxFiles > 0) {
      args.push("--max-files", String(opts.maxFiles));
    }
    if (opts.filePattern) {
      args.push("--file-pattern", opts.filePattern);
    }
    if (opts.glossary) {
      args.push("--glossary", opts.glossary);
    }
    if (opts.trimSuffix) {
      args.push("--trim-suffix", opts.trimSuffix);
    }
    if (opts.addSuffix) {
      args.push("--add-suffix", opts.addSuffix);
    }
    if (opts.preserveCode === false || config.preserveCode === false) {
      args.push("--no-preserve-code");
    }
    if (opts.retryFailed) {
      args.push("--retry-failed");
    }
    if (opts.dryRun) {
      args.push("--dry-run");
    }

    logger.info(`[translate-machine] Starting job ${job.id}: python3 ${args.join(" ")}`);

    const proc = spawn("python3", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    job.pid = proc.pid;
    processes.set(job.id, proc);

    // 逐行讀取 stdout
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line: string) => {
        job.outputLines.push(line);
        if (job.outputLines.length > 200) {
          job.outputLines.shift();
        }

        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          switch (event.event) {
            case "init":
              job.progress.total = (event.pending as number) ?? 0;
              break;
            case "file_start":
              job.progress.currentFile = event.file as string;
              break;
            case "file_ok":
              job.progress.completed++;
              job.progress.currentFile = event.file as string;
              break;
            case "file_fail":
              job.progress.completed++;
              job.progress.failed++;
              job.progress.currentFile = event.file as string;
              break;
            case "done":
              // 由 close 事件處理最終狀態
              break;
          }
        } catch {
          // 非 JSON 行，忽略
        }
      });
    }

    // 收集 stderr
    if (proc.stderr) {
      const rlErr = createInterface({ input: proc.stderr });
      rlErr.on("line", (line: string) => {
        job.outputLines.push(`[stderr] ${line}`);
        if (job.outputLines.length > 200) {
          job.outputLines.shift();
        }
      });
    }

    proc.on("close", (code: number | null) => {
      if (job.status === "running") {
        job.status = code === 0 ? "completed" : "failed";
      }
      job.completedAt = Date.now();
      processes.delete(job.id);
      logger.info(`[translate-machine] Job ${job.id} finished: ${job.status} (code=${code})`);
    });

    proc.on("error", (err: Error) => {
      if (job.status === "running") {
        job.status = "failed";
      }
      job.completedAt = Date.now();
      job.outputLines.push(`[error] ${err.message}`);
      processes.delete(job.id);
      logger.error(`[translate-machine] Job ${job.id} error: ${err.message}`);
    });

    jobs.set(job.id, job);
    return job;
  }

  function cancelJob(jobId: string): boolean {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") {
      return false;
    }

    const proc = processes.get(jobId);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }

    job.status = "cancelled";
    job.completedAt = Date.now();
    processes.delete(jobId);
    logger.info(`[translate-machine] Job ${jobId} cancelled`);
    return true;
  }

  function getJob(jobId: string): TranslationJob | undefined {
    return jobs.get(jobId);
  }

  function listJobs(): TranslationJob[] {
    return [...jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => ({
        ...j,
        outputLines: [], // 列表不回傳完整輸出
      }));
  }

  function getJobOutput(jobId: string, offset = 0): string[] {
    const job = jobs.get(jobId);
    if (!job) {
      return [];
    }
    return job.outputLines.slice(offset);
  }

  return {
    startJob,
    cancelJob,
    getJob,
    listJobs,
    getJobOutput,
  };
}
