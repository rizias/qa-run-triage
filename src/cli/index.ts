#!/usr/bin/env node
import { loadConfig, type Config } from '../config.js';
import { appendAnalysis, parseAnalysis } from '../journal/appendAnalysis.js';
import { assertJobAllowed } from '../access.js';
import { keepInstalledSkillsFresh } from '../skills/setup.js';
import { isEntryPoint } from './entryPoint.js';
import { writeJournalReport } from '../htmlreport/report.js';
import { serverResolver } from '../journal/identity.js';
import { DEFAULT_SETTINGS, loadSettings } from '../settings.js';
import { commandLoadsProfileSettings, extractConfigFlag, parseArgs, type Command } from './args.js';
import { COMMAND_HANDLERS, runWithoutConfig } from './commands.js';
import { printCliError } from './printError.js';

export { parseArgs, type Command } from './args.js';

export function assertCommandAllowed(
  allowedJobs: readonly string[] | undefined,
  command: Command
): void {
  if ('job' in command) {
    assertJobAllowed(allowedJobs, command.job);
  }
}

async function main(): Promise<void> {
  const { configFile, profile, rest } = extractConfigFlag(process.argv.slice(2));
  await keepInstalledSkillsFresh();
  const settings = commandLoadsProfileSettings(rest)
    ? loadSettings(process.env, configFile, profile)
    : DEFAULT_SETTINGS;
  const command = parseArgs(rest, settings);

  if (await runWithoutConfig(command, process.env, configFile, profile)) {
    return;
  }

  const config = loadConfig(process.env, configFile, profile);
  assertCommandAllowed(config.allowedJobs, command);

  await COMMAND_HANDLERS[command.kind](config, command);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    printCliError(error);
    process.exit(1);
  });
}

export function runJournalAppend(
  config: Config,
  input: string
): Promise<Record<string, unknown>> {
  const analysis = parseAnalysis(input);
  appendAnalysis(config, analysis);
  const answer: Record<string, unknown> = {
    saved: true,
    job: analysis.job,
    build: analysis.build
  };
  try {
    answer.report = writeJournalReport(config.cacheDir, {
      resolveServer: serverResolver(config),
      settings: config.settings,
      windowDays: config.settings.reportWindowDays
    });
  } catch (error) {
    answer.reportError = error instanceof Error ? error.message : String(error);
  }
  return Promise.resolve(answer);
}

export async function readStandardInput(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > maxBytes) {
      throw new Error(
        `Разбор на стандартном вводе превышает limits.journalInputMaxBytes (${maxBytes} байт).`
      );
    }
    chunks.push(piece);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    throw new Error('Разбор не передан: подайте объект JSON на стандартный ввод.');
  }
  return text;
}
