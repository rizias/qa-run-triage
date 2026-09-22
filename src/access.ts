export function normalizeJob(job: string): string {
  return job.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase();
}

export function isJobAllowed(allowedJobs: readonly string[] | undefined, job: string): boolean {
  const allowed = normalizeAll(allowedJobs);
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(normalizeJob(job).toLowerCase());
}

export function isPathAllowed(allowedJobs: readonly string[] | undefined, jobPath: string): boolean {
  if (isJobAllowed(allowedJobs, jobPath)) {
    return true;
  }
  const prefix = `${normalizeJob(jobPath).toLowerCase()}/`;
  return normalizeAll(allowedJobs).some((allowed) => allowed.startsWith(prefix));
}

export function assertJobAllowed(allowedJobs: readonly string[] | undefined, job: string): void {
  if (isJobAllowed(allowedJobs, job)) {
    return;
  }
  throw new Error(
    `Джоба ${normalizeJob(job)} запрещена настройкой allowedJobs файла настроек. ` +
      `Разрешённые джобы: ${(allowedJobs ?? []).map(normalizeJob).join(', ')}`
  );
}

function normalizeAll(allowedJobs: readonly string[] | undefined): string[] {
  return (allowedJobs ?? []).map((job) => normalizeJob(job).toLowerCase());
}

export function assertPathAllowed(
  allowedJobs: readonly string[] | undefined,
  jobPath: string
): void {
  if (isPathAllowed(allowedJobs, jobPath)) {
    return;
  }
  throw new Error(
    `Путь ${normalizeJob(jobPath)} запрещён настройкой allowedJobs файла настроек. ` +
      `Разрешённые джобы: ${(allowedJobs ?? []).map(normalizeJob).join(', ')}`
  );
}
