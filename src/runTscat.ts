import { TransformingFileSystem } from "./transformingFileSystem.js";
import { DebugOptions } from "./objstore.js";

export async function runTscat(path: string, debugOptions: DebugOptions) {
  const fshost = new TransformingFileSystem();
  const content = fshost.readFileSync(path);
  console.log(content);
}
