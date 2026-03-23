import { findGitRepoRoot } from "./project";
import { openStorage } from "./storage";
import { updateStorage } from "./indexing";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { FileSystem } from "./filesystem";

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
