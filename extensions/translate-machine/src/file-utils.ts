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
  trimSuffix?: string,
  addSuffix?: string,
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

  // 比對時考慮 trimSuffix / addSuffix：來源檔名經轉換後應與目標檔名匹配
  const targetSet = new Set(result.target);
  result.pending = result.source.filter((name) => {
    const nameExt = path.extname(name);
    let stem = path.basename(name, nameExt);
    if (trimSuffix && stem.endsWith(trimSuffix)) {
      stem = stem.slice(0, -trimSuffix.length);
    }
    if (addSuffix) {
      stem = stem + addSuffix;
    }
    const expectedTarget = stem + nameExt;
    return !targetSet.has(expectedTarget);
  });

  return result;
}

export type LogContents = {
  translateLog: string;
  glossary: string;
  newTerms: string;
  failedFiles: string;
};

export function readTranslationLogs(targetDir: string, glossaryPath?: string): LogContents {
  const readFile = (name: string) => {
    const filePath = path.join(targetDir, name);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    return "";
  };

  const readAbsOrRel = (absPath: string | undefined, defaultName: string) => {
    if (absPath) {
      const resolved = path.isAbsolute(absPath) ? absPath : path.join(targetDir, absPath);
      if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved, "utf-8");
      }
    }
    return readFile(defaultName);
  };

  return {
    translateLog: readFile("translate-log.txt"),
    glossary: readAbsOrRel(glossaryPath, "glossary.md"),
    newTerms: readFile("new-terms.txt"),
    failedFiles: readFile("failed-files.txt"),
  };
}
