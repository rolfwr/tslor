import { TransformingFileSystem } from './transformingFileSystem';
import { reThrowAsCliError } from './errors';
import { DebugOptions } from './objstore';

export async function runTscat(path: string, _debugOptions: DebugOptions) {
  const fshost = new TransformingFileSystem();
  try {
    const content = fshost.readFileSync(path);
    console.log(content);
  } catch (err: unknown) {
    reThrowAsCliError(err, 'tscat', 'expected');
  }
}
