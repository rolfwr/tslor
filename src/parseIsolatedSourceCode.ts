import { FileSystemHost, Project } from "ts-morph";
import { defaultProjectOptions, parseModule } from "./indexing.js";


export function parseIsolatedSourceCode(sourceCode: string) {
  const projectOptions = defaultProjectOptions();

  const partialFileSystemHost: Partial<FileSystemHost> = new StubFileSystemHost();

  projectOptions.fileSystem = makeStub('fileSystem', partialFileSystemHost)

  const project = new Project(projectOptions);

  const sourceFile = project.createSourceFile('example.ts', sourceCode);
  const result = parseModule(sourceFile);
  return result;
}

class StubFileSystemHost implements Partial<FileSystemHost> {
  isCaseSensitive(): boolean {
    return false;
  }

  fileExistsSync(filePath: string): boolean {
    switch (filePath) {
      case '/test/example.ts':
        return false;
    }

    console.log('I/O leak: ' + filePath);
    throw new Error('fileExistsSync not implemented for ' + filePath);
  }

  getCurrentDirectory(): string {
    return '/test';
  }
}

export function makeStub<T>(what: string, obj: Partial<T>): T {
  return new Proxy<Partial<T>>(obj, new StubProxy(what, obj)) as T;
}

class StubProxy implements Required<ProxyHandler<any>> {
  constructor(private what: string, private inner: unknown) {
  }
  apply(target: any, thisArg: any, argArray: any[]) {
    void target;
    void thisArg;
    void argArray;
    throw new Error('Apply on ' + this.what + ' stub not implemented');
  }
  construct(target: any, argArray: any[], newTarget: Function): object {
    void target;
    void argArray;
    void newTarget;
    throw new Error('Construct on ' + this.what + ' stub not implemented');
  }
  defineProperty(target: any, property: string | symbol, attributes: PropertyDescriptor): boolean {
    void target;
    void property;
    void attributes;
    throw new Error('Define property on ' + this.what + ' stub not implemented');
  }
  deleteProperty(target: any, p: string | symbol): boolean {
    void target;
    void p;
    throw new Error('Delete property on ' + this.what + ' stub not implemented');
  }
  get(target: any, p: string | symbol, receiver: any) {
    void p;
    void receiver;

    if (p in target) {
      return target[p];
    }

    throw new Error('Stub ' + this.what + ' does not have property ' + p.toString());
  }
  getOwnPropertyDescriptor(target: {}, p: string | symbol): PropertyDescriptor | undefined {
    void target;
    void p;
    throw new Error('Get own property descriptor on ' + this.what + ' stub not implemented');
  }
  getPrototypeOf(target: {}): object | null {
    void target;
    throw new Error('Get prototype of ' + this.what + ' stub not implemented');
  }
  has(target: {}, p: string | symbol): boolean {
    void target;
    void p;
    throw new Error('Has on ' + this.what + ' stub not implemented');
  }
  isExtensible(target: {}): boolean {
    void target;
    throw new Error('Is extensible on ' + this.what + ' stub not implemented');
  }
  ownKeys(target: {}): ArrayLike<string | symbol> {
    void target;
    throw new Error('Own keys on ' + this.what + ' stub not implemented');
  }
  preventExtensions(target: {}): boolean {
    void target;
    throw new Error('Prevent extensions on ' + this.what + ' stub not implemented');
  }
  set(target: {}, p: string | symbol, newValue: any, receiver: any): boolean {
    void target;
    void p;
    void newValue;
    void receiver;
    throw new Error('Set on ' + this.what + ' stub not implemented');
  }
  setPrototypeOf(target: {}, v: object | null): boolean {
    void target;
    void v;
    throw new Error('Set prototype of ' + this.what + ' stub not implemented');
  }
}
