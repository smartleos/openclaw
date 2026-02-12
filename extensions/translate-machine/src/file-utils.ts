import fs from "node:fs";
import path from "node:path";

export type FileListResult = {
  source: string[];
  target: string[];
  pending: string[];
};

export function listTranslationFiles(
  sourceDir: string,
  targetDir: string,
  filePattern = "*.md",
): FileListResult {
  const result: FileListResult = { source: [], target: [], pending: [] };

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return result;
  }

  // 簡單 glob：只支援 *.ext 格式
  const ext = filePattern.startsWith("*") ? filePattern.slice(1) : "";
  const entries = fs.readdirSync(sourceDir);

  for (const name of entries) {
    if (ext && !name.endsWith(ext)) continue;
    const fullPath = path.join(sourceDir, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    result.source.push(name);
  }
  result.source.sort();

  if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
    const targetEntries = fs.readdirSync(targetDir);
    for (const name of targetEntries) {
      const fullPath = path.join(targetDir, name);
      if (ext && !name.endsWith(ext)) continue;
      if (!fs.statSync(fullPath).isFile()) continue;
      result.target.push(name);
    }
    result.target.sort();
  }

  const targetSet = new Set(result.target);
  result.pending = result.source.filter((name) => !targetSet.has(name));

  return result;
}

export type LogContents = {
  translateLog: string;
  glossary: string;
  newTerms: string;
  failedFiles: string;
};

export function readTranslationLogs(targetDir: string): LogContents {
  const readFile = (name: string) => {
    const filePath = path.join(targetDir, name);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    return "";
  };

  return {
    translateLog: readFile("translate-log.txt"),
    glossary: readFile("glossary.md"),
    newTerms: readFile("new-terms.txt"),
    failedFiles: readFile("failed-files.txt"),
  };
}
