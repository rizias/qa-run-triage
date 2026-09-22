import fs from 'node:fs';
import path from 'node:path';
import { assertSkillPaths } from './safePaths.js';
import {
  DAY_MS,
  findPathKey,
  note,
  readRegistry,
  mutateRegistry,
  persistRegistry,
  recordInstall,
  recordedFiles,
  samePath,
  toSlash,
  withRegistryLock,
  type InstallOptions,
  type InstallReport,
  type InstalledCopy,
  type Registry,
  type RegistryEntry,
  type RefreshOptions,
  type RefreshReport,
  type SkipReason,
  type SkippedPath
} from './updaterState.js';
import {
  basesFor,
  collisions,
  conflictMessage,
  stampOf,
  isSafeRelative,
  kindOfBase,
  listFiles,
  placeSkill,
  resolveTemplate,
  scanSkills,
  targetOptions,
  type Job
} from './updaterFiles.js';

const planJobs = (templates: InstallOptions['templates'], bases: string[], skills: string[]): { jobs: Job[]; duplicates: Job[] } => {
  const jobs: Job[] = [];
  const duplicates: Job[] = [];
  for (const base of bases) {
    for (const skill of skills) {
      const kind = kindOfBase(base);
      if (resolveTemplate(templates, kind, skill) === undefined) continue;
      const dest = toSlash(path.join(base, skill));
      const job = { skill, dest, kind };
      const taken = jobs.find((other) => samePath(other.dest, dest));
      if (taken === undefined) jobs.push(job);
      else if (taken.skill !== skill) duplicates.push(job);
    }
  }
  return { jobs, duplicates };
};

const installJob = async (options: InstallOptions, job: Job, registry: Registry, report: InstallReport): Promise<void> => {
  const template = resolveTemplate(options.templates, job.kind, job.skill);
  if (template === undefined) {
    report.skipped.push({ path: job.dest, reason: 'failed' });
    note(false, `${options.pkgName}: нет шаблона скилла ${job.skill} — пропущено ${job.dest}`);
    return;
  }
  try {
    const recorded = recordedFiles(registry, options.pkgName, job.skill, job.dest);
    assertSkillPaths(job.dest, recorded);
    const clash = collisions(job.dest, template, recorded);
    if (clash.length > 0) {
      const approved = await options.ask.confirm({
        message: `${job.dest}: установка перезапишет файлы, не размещённые этим пакетом (${clash.join(', ')}) — перезаписать?`,
        paths: [job.dest],
      });
      if (!approved) {
        report.skipped.push({ path: job.dest, reason: 'foreign-files', files: clash, message: conflictMessage(options.pkgName, job.dest, clash) });
        return;
      }
    }
    const shipped = listFiles(template);
    const claimed = [...new Set([...recorded, ...clash, ...shipped])];
    mutateRegistry(options.stateDir, (current) => {
      recordInstall(current, options.pkgName, options.version, job.skill, job.dest, claimed);
    });
    placeSkill(template, job.dest, claimed);
    mutateRegistry(options.stateDir, (current) => {
      recordInstall(current, options.pkgName, options.version, job.skill, job.dest, shipped);
    });
    report.installed.push(job.dest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.skipped.push({ path: job.dest, reason: 'failed', message });
    note(false, `${options.pkgName}: не удалось установить ${job.dest}: ${message}`);
  }
};

export const installSkills = async (options: InstallOptions): Promise<InstallReport> => {
  const { removed: pruned } = pruneRegistry({ pkgName: options.pkgName, stateDir: options.stateDir });
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const skills = scanSkills(options.templates);
  const report: InstallReport = { skills, installed: [], skipped: [], pruned };
  if (skills.length === 0) return report;

  const chosen = await options.ask.chooseTargets({ skills, options: targetOptions(projectDir) });
  const { jobs, duplicates } = planJobs(options.templates, chosen.flatMap((choice) => basesFor(choice, projectDir)), skills);
  if (jobs.length === 0) return report;

  const message = `установить скиллов: ${new Set(jobs.map((job) => job.skill)).size}, путей: ${jobs.length}`;
  const approved = await options.ask.confirm({ message, paths: jobs.map((job) => job.dest) });
  if (!approved) return report;

  for (const job of duplicates) {
    report.skipped.push({ path: job.dest, reason: 'failed', message: `${options.pkgName}: скилл ${job.skill} пропущен — его путь назначения совпадает с путём другого скилла в этой файловой системе. Сообщите об этом пользователю.` });
    note(false, `${options.pkgName}: дублирующийся путь назначения для скилла ${job.skill} — пропущено ${job.dest}`);
  }
  for (const job of jobs) {
    const registry = readRegistry(options.stateDir);
    await installJob(options, job, registry, report);
  }
  return report;
};

const refreshOne = (
  options: RefreshOptions,
  registry: Registry,
  skill: string,
  copy: InstalledCopy
): { outcome: SkipReason | 'refreshed' | 'current'; clash?: string[]; message?: string } => {
  try {
    assertSkillPaths(copy.path, copy.files);
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const template = resolveTemplate(options.templates, kindOfBase(path.dirname(copy.path)), skill);
  if (template === undefined) return { outcome: 'failed' };
  if (!fs.existsSync(path.dirname(copy.path))) return { outcome: 'unavailable' };
  if (stampOf(copy.path, skill) === stampOf(template, skill)) return { outcome: 'current' };
  const recorded = copy.files.filter(isSafeRelative);
  const clash = collisions(copy.path, template, recorded);
  if (clash.length > 0) {
    note(options.quiet, `${options.pkgName}: обновление ${copy.path} перезапишет файлы, не размещённые этим пакетом (${clash.join(', ')}) — пропущено`);
    return { outcome: 'foreign-files', clash };
  }
  try {
    const shipped = listFiles(template);
    copy.files = [...new Set([...recorded, ...shipped])].sort();
    persistRegistry(options.stateDir, registry);
    placeSkill(template, copy.path, copy.files);
    copy.files = shipped;
    persistRegistry(options.stateDir, registry);
    return { outcome: 'refreshed' };
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
};

const announceUnavailable = (options: RefreshOptions, dest: string, seen: Record<string, number>): boolean => {
  if (options.quiet === true) return false;
  const key = findPathKey(seen, dest);
  if (Date.now() - (key === undefined ? 0 : seen[key] ?? 0) <= DAY_MS) return false;
  note(false, `${options.pkgName}: путь недоступен, пропущено: ${dest}`);
  seen[key ?? dest] = Date.now();
  return true;
};

const refreshEntry = (
  options: RefreshOptions,
  registry: Registry,
  entry: RegistryEntry,
  report: RefreshReport,
): { announced: boolean; seen: Record<string, number> } => {
  const seen = { ...entry.unavailable };
  let announced = false;
  for (const [skill, copies] of Object.entries(entry.skills)) {
    for (const copy of copies) {
      const { outcome, clash, message } = refreshOne(options, registry, skill, copy);
      if (outcome === 'current') continue;
      if (outcome === 'refreshed') {
        report.refreshed.push(copy.path);
        continue;
      }
      const skipped: SkippedPath = { path: copy.path, reason: outcome };
      if (clash !== undefined) {
        skipped.files = clash;
        skipped.message = conflictMessage(options.pkgName, copy.path, clash);
      }
      if (message !== undefined) {
        skipped.message = message;
      }
      report.skipped.push(skipped);
      if (outcome === 'failed') {
        note(
          options.quiet,
          `${options.pkgName}: не удалось обновить ${copy.path}${message ? `: ${message}` : ''}`
        );
      }
      if (outcome === 'unavailable') announced = announceUnavailable(options, copy.path, seen) || announced;
    }
  }
  return { announced, seen };
};

export const maybeRefreshSkills = (options: RefreshOptions): RefreshReport => {
  const report: RefreshReport = { refreshed: [], skipped: [] };
  try {
    withRegistryLock(options.stateDir, () => {
      const registry = readRegistry(options.stateDir);
      const entry = registry[options.pkgName];
      if (entry === undefined) return;

      const versionChanged = entry.version !== options.version;
      entry.version = options.version;
      const { announced, seen } = refreshEntry(options, registry, entry, report);
      if (announced) {
        entry.unavailable = seen;
        persistRegistry(options.stateDir, registry);
      }
      if (versionChanged && report.refreshed.length === 0) persistRegistry(options.stateDir, registry);
      if (report.refreshed.length > 0) {
        note(options.quiet, `${options.pkgName}: обновлено скиллов: ${report.refreshed.length} (${options.version})`);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Не удалось обновить скиллы: ${message}`);
    return report;
  }
  return report;
};

export const pruneRegistry = (options: { pkgName: string; stateDir: string }): { removed: string[] } => {
  const removed: string[] = [];
  withRegistryLock(options.stateDir, () => {
    const registry = readRegistry(options.stateDir);
    const entry = registry[options.pkgName];
    if (entry === undefined) return;
    for (const [skill, copies] of Object.entries(entry.skills)) {
      const kept = copies.filter((copy) => {
        if (fs.existsSync(path.dirname(copy.path))) return true;
        removed.push(copy.path);
        return false;
      });
      if (kept.length > 0) entry.skills[skill] = kept;
      else delete entry.skills[skill];
    }
    if (entry.unavailable !== undefined) {
      for (const dest of removed) {
        const key = findPathKey(entry.unavailable, dest);
        if (key !== undefined) delete entry.unavailable[key];
      }
      if (Object.keys(entry.unavailable).length === 0) delete entry.unavailable;
    }
    if (removed.length > 0) persistRegistry(options.stateDir, registry);
  });
  return { removed };
};
