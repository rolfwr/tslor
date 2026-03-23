import { TransformingFileSystem } from "./transformingFileSystem";
import { DebugOptions } from "./objstore";

export async function runTscat(path: string, debugOptions: DebugOptions) {
  const fshost = new TransformingFileSystem();
  const content = fshost.readFileSync(path);
  console.log(content);
}
