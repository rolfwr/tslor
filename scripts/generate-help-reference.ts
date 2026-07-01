/**
 * Generate docs/help-reference.md from actual CLI help output.
 * Run with: pnpm run generate:help
 */
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const cliBin = resolve(rootDir, 'dist', 'tslor.mjs');

function runHelp(subcommand?: string): string {
  const args = subcommand ? [cliBin, subcommand, '--help'] : [cliBin, '--help'];
  return String(execFileSync('node', args, { encoding: 'utf-8', cwd: rootDir })).trim();
}

function codeFence(content: string): string {
  return '```\n' + content + '\n```';
}

function main() {
  const mainHelp = runHelp();

  /*
    Extract subcommand names from the main help output.
    Commander formats commands as "  name [options] <args...>  description".
  */
  const commandsSection = mainHelp.split('Commands:\n')[1];
  if (!commandsSection) {
    throw new Error('No Commands section found in help output');
  }
  const commandLines = commandsSection.split('\n').filter(l => l.trim() !== '');
  const commandNames = commandLines.map(line => {
    const match = line.match(/^\s+(\S+)/);
    return match ? match[1] : null;
  }).filter((name): name is string => name !== null && name !== 'help');

  const commandSections = commandNames
    .map(name => `### \`${name}\`\n\n${codeFence(runHelp(name))}`)
    .join('\n\n');

  const output = [
    '# TSLOR Help Reference',
    '',
    'Auto-generated documentation — regenerate with `pnpm run generate:help`.',
    '',
    '## tslor --help',
    '',
    codeFence(mainHelp),
    '',
    '## Command Reference',
    '',
    commandSections,
  ].join('\n');

  const outPath = resolve(rootDir, 'docs', 'help-reference.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output + '\n');
  console.log(`Wrote ${outPath} (${commandNames.length} commands)`);
}

main();
