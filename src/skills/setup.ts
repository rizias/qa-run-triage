import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import {
  type Ask,
  type ChosenTarget,
  type InstallReport
} from './updaterState.js';
import { installSkills, maybeRefreshSkills } from './updater.js';
import { note } from './updaterState.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function packageMeta(): { name: string; version: string } {
  const parsed = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  return parsed;
}

export function stateDir(): string {
  return path.join(os.homedir(), '.qa-run-triage');
}

export function templatesDir(): string {
  return path.join(packageRoot, 'skills');
}

interface Terminal {
  question(prompt: string): Promise<string>;
  close(): void;
}

function createTerminal(): Terminal {
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  reader.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      lines.push(line);
    }
  });
  reader.on('close', () => {
    while (waiters.length > 0) {
      waiters.shift()!('');
    }
  });
  return {
    question(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const ready = lines.shift();
      if (ready !== undefined) {
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      reader.close();
    }
  };
}

function createAsk(terminal: Terminal): Ask {
  return {
    async chooseTargets({ skills, options }) {
      console.log(`Скиллы к установке: ${skills.join(', ')}`);
      options.forEach((option, index) => {
        const roots = option.roots.length > 0 ? ` -> ${option.roots.join(', ')}` : '';
        console.log(`  ${index + 1}. ${option.label}${roots}`);
      });
      const picked = await terminal.question('Куда ставить (номера через запятую, пусто — отмена): ');
      const chosen: ChosenTarget[] = [];
      for (const part of picked.split(',').map((value) => value.trim()).filter(Boolean)) {
        const option = options[Number(part) - 1];
        if (option === undefined) {
          continue;
        }
        if (option.id === 'custom') {
          const root = (await terminal.question('Путь: ')).trim();
          if (root !== '') {
            chosen.push({ id: 'custom', root });
          }
        } else {
          chosen.push({ id: option.id });
        }
      }
      return chosen;
    },

    async confirm({ message, paths }) {
      for (const target of paths) {
        console.log(`  ${target}`);
      }
      const answer = await terminal.question(`${message} [д/Н]: `);
      return ['д', 'да', 'y', 'yes'].includes(answer.trim().toLowerCase());
    }
  };
}

export async function runInit(): Promise<InstallReport> {
  const meta = packageMeta();
  const terminal = createTerminal();
  try {
    return await installSkills({
      pkgName: meta.name,
      version: meta.version,
      templates: templatesDir(),
      stateDir: stateDir(),
      ask: createAsk(terminal)
    });
  } finally {
    terminal.close();
  }
}

export function runUpdate(): number {
  const meta = packageMeta();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['i', '-g', `${meta.name}@latest`], {
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: false,
    shell: process.platform === 'win32'
  });
  return result.status ?? 1;
}

export async function keepInstalledSkillsFresh(): Promise<void> {
  try {
    if (process.stdout.isTTY) {
      const { default: updateNotifier } = await import('update-notifier');
      updateNotifier({ pkg: packageMeta(), updateCheckInterval: 1000 * 60 * 60 * 24 }).notify();
    }
    const meta = packageMeta();
    maybeRefreshSkills({
      pkgName: meta.name,
      version: meta.version,
      templates: templatesDir(),
      stateDir: stateDir()
    });
  } catch (error) {
    note(
      false,
      `не удалось обновить установленные скиллы: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
