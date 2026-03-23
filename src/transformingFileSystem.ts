import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { mkdir, writeFile, stat, readdir } from "fs/promises";
import { resolve } from "path";
import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

export class TransformingFileSystem implements FileSystemHost {
  constructor() {}
  isCaseSensitive(): boolean {
    return true;
  }
  delete(path: string): Promise<void> {
    throw new Error("delete not implemented.");
  }
  deleteSync(path: string): void {
    throw new Error("deleteSync not implemented.");
  }
  readDirSync(dirPath: string): RuntimeDirEntry[] {
    try {
      const { readdirSync } = require("fs");
      const entries = readdirSync(dirPath, { withFileTypes: true });
      return entries.map((entry: any) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }
  }
  async readFile(filePath: string, encoding?: string): Promise<string> {
    if (encoding && encoding !== "utf-8") {
      throw new Error("Encoding " + encoding + " not supported.");
    }
    
    const { readFile } = require("fs/promises");
    let content = await readFile(filePath, "utf-8");

    if (filePath.endsWith(".vue")) {
      content = extractScript(content);
    }

    return content;
  }
  readFileSync(filePath: string, encoding?: string): string {
    if (encoding && encoding !== "utf-8") {
      throw new Error("Encoding " + encoding + " not supported.");
    }
    let content = readFileSync(filePath, "utf-8");

    if (filePath.endsWith(".vue")) {
      content = extractScript(content);
    }

    return content;
  }
  async writeFile(filePath: string, fileText: string): Promise<void> {
    if (filePath.endsWith(".vue")) {
      // For Vue files, we need to reinsert the TypeScript into the original Vue structure
      const originalContent = readFileSync(filePath, "utf-8");
      const modifiedContent = reinsertScript(originalContent, fileText);
      await writeFile(filePath, modifiedContent);
    } else {
      // For non-Vue files, write directly
      await writeFile(filePath, fileText);
    }
  }
  
  writeFileSync(filePath: string, fileText: string): void {
    if (filePath.endsWith(".vue")) {
      // For Vue files, we need to reinsert the TypeScript into the original Vue structure
      const originalContent = readFileSync(filePath, "utf-8");
      const modifiedContent = reinsertScript(originalContent, fileText);
      writeFileSync(filePath, modifiedContent);
    } else {
      // For non-Vue files, write directly
      writeFileSync(filePath, fileText);
    }
  }
  async mkdir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }
  
  mkdirSync(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
  }
  move(srcPath: string, destPath: string): Promise<void> {
    throw new Error("move not implemented.");
  }
  moveSync(srcPath: string, destPath: string): void {
    throw new Error("moveSync not implemented.");
  }
  copy(srcPath: string, destPath: string): Promise<void> {
    throw new Error("copy not implemented.");
  }
  copySync(srcPath: string, destPath: string): void {
    throw new Error("copySync not implemented.");
  }
  async fileExists(filePath: string): Promise<boolean> {
    try {
      const stats = await stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }
  
  fileExistsSync(filePath: string): boolean {
    try {
      const stats = statSync(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }
  
  async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
  
  directoryExistsSync(dirPath: string): boolean {
    try {
      const stats = statSync(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
  realpathSync(path: string): string {
    const { realpathSync } = require("fs");
    return realpathSync(path);
  }
  getCurrentDirectory(): string {
    return process.cwd();
  }
  glob(patterns: ReadonlyArray<string>): Promise<string[]> {
    throw new Error("glob not implemented.");
  }
  globSync(patterns: ReadonlyArray<string>): string[] {
    throw new Error("globSync not implemented.");
  }
}

export function extractScript(code: string): string {
  const pos = code.indexOf("<script");
  if (pos === -1) {
    return "";
  }
  const start = code.indexOf(">", pos);
  if (start === -1) {
    throw new Error("Script tag not closed");
  }
  const end = code.indexOf("</script>", start);
  if (end === -1) {
    throw new Error("Script tag not closed");
  }

  const scriptPart = code.slice(start + 1, end);
  const verify = reinsertScript(code, scriptPart);
  if (verify !== code) {
    throw new Error("Safe script extraction failed");
  }

  return scriptPart;
}

export function reinsertScript(code: string, scriptPart: string): string {
  const pos = code.indexOf('<script');
  if (pos === -1) {
    if (scriptPart.trim() === '') {
      return code;
    }
    throw new Error('Script tag for reinsertion not found');
  }
  const start = code.indexOf('>', pos);
  if (start === -1) {
    throw new Error('Script tag not closed');
  }
  const end = code.indexOf('</script>', start);
  if (end === -1) {
    throw new Error('Script tag not closed');
  }

  if (!scriptPart.startsWith('\n')) {
    scriptPart = '\n' + scriptPart;
  }

  return code.slice(0, start + 1) + scriptPart + code.slice(end);
}
