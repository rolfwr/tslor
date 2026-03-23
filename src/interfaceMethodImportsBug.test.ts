/**
 * Bug #4: extractTypeReferences() doesn't analyze interface method signatures
 * 
 * When extracting an interface with methods that reference types,
 * those type references aren't being detected as dependencies.
 * This causes the extracted interface to be missing required imports.
 */

import { describe, it, expect } from 'vitest';
import { Project, SyntaxKind } from 'ts-morph';
import { parseModule } from './indexing';

describe('Bug #4: Interface method type references', () => {
  it('should detect type references in interface method signatures', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceCode = `
import type { Logger } from './logger';
import type { RequestHandler } from './handler';
import type { BackendOps } from './backend';

export interface Operations {
  readFile(filePath: string): Promise<string>;
  
  processRequest(
    logger: Logger,
    handler: RequestHandler,
    backend: BackendOps
  ): Promise<void>;
  
  cleanup(logger: Logger): Promise<void>;
}
`;
    
    const sourceFile = project.createSourceFile('test.ts', sourceCode);
    const moduleInfo = parseModule(sourceFile);
    
    // Check that Operations interface is detected as an export
    expect(moduleInfo.exportedNames.has('Operations')).toBe(true);
    
    // Check that type references from method signatures are detected
    const operationsIdentifiers = moduleInfo.identifierUses.get('Operations');
    expect(operationsIdentifiers).toBeDefined();
    
    // Should include Logger, RequestHandler, and BackendOps from method parameters
    expect(operationsIdentifiers).toContain('Logger');
    expect(operationsIdentifiers).toContain('RequestHandler');
    expect(operationsIdentifiers).toContain('BackendOps');
  });

  it('should detect type references in interface method return types', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceCode = `
import type { User } from './user';
import type { Result } from './result';

export interface UserService {
  getUser(id: string): Promise<User>;
  updateUser(user: User): Result<User>;
}
`;
    
    const sourceFile = project.createSourceFile('test.ts', sourceCode);
    const moduleInfo = parseModule(sourceFile);
    
    const identifiers = moduleInfo.identifierUses.get('UserService');
    expect(identifiers).toBeDefined();
    
    // Should detect User from both parameter and return types
    expect(identifiers).toContain('User');
    // Should detect Result from return type
    expect(identifiers).toContain('Result');
  });

  it('should detect type references in complex interface method signatures', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceCode = `
import type { Logger } from './logger';
import type { Config } from './config';
import type { Data } from './data';
import type { Error } from './error';

export interface ComplexOps {
  process(
    logger: Logger,
    config: Config,
    data: Data[]
  ): Promise<Data | Error>;
  
  transform(input: Data, logger?: Logger): Data | null;
}
`;
    
    const sourceFile = project.createSourceFile('test.ts', sourceCode);
    const moduleInfo = parseModule(sourceFile);
    
    const identifiers = moduleInfo.identifierUses.get('ComplexOps');
    expect(identifiers).toBeDefined();
    
    // Should detect all types used in method signatures
    expect(identifiers).toContain('Logger');
    expect(identifiers).toContain('Config');
    expect(identifiers).toContain('Data');
    expect(identifiers).toContain('Error');
  });

  it('should detect type references in utility types like Pick, Omit, etc.', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceCode = `
import type { Logger } from './logger';
import type { Config } from './config';

export interface Service {
  hardLinkOrCopy: (
    filePath: string,
    keldaCfg: Pick<Config, 'serverFolder'>,
    logger: Logger
  ) => Promise<void>;
  
  getPartial: (data: Partial<Config>) => Config;
}
`;
    
    const sourceFile = project.createSourceFile('test.ts', sourceCode);
    const moduleInfo = parseModule(sourceFile);
    
    const identifiers = moduleInfo.identifierUses.get('Service');
    expect(identifiers).toBeDefined();
    
    // Should detect Config from Pick<Config, 'serverFolder'> and Partial<Config>
    expect(identifiers).toContain('Config');
    expect(identifiers).toContain('Logger');
  });
});
