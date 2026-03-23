import { findGitRepoRoot } from "./project.js";
import { openStorage } from "./storage.js";
import { updateStorage } from "./indexing.js";
import { DebugOptions } from "./objstore.js";
import { normalizeAndValidatePath } from "./pathUtils.js";
import { FileSystem } from "./filesystem.js";

export async function runImports(exportPathArg: string, debugOptions: DebugOptions, fileSystem: FileSystem) {
  const exportPath = normalizeAndValidatePath(exportPathArg, "Export path", false);
  let repoRoot = findGitRepoRoot(exportPath);
  const db = openStorage(debugOptions, true);
  await updateStorage(repoRoot, db, true, fileSystem);
  db.save();
  const importers = db.getImportersOfExportPath(exportPath);
  const sortedImporters = Array.from(importers).sort();
  for (const importer of sortedImporters) {
    console.log(importer);
  }
}
