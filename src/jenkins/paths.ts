export function toJenkinsPath(job: string): string {
  const parts = splitJob(job);
  return parts.map((part) => `job/${encodeURIComponent(part)}`).join('/');
}

export function workspacePath(job: string, build: number, node: number): string {
  return `${toJenkinsPath(job)}/${build}/execution/node/${node}/ws/`;
}

export function workspaceSourcePath(job: string, build: number, node: number): string {
  return `${workspacePath(job, build, node)}src/*zip*/src.zip`;
}

function splitJob(job: string): string[] {
  const normalized = job.trim().replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error('Пустой путь джобы');
  }
  return parts;
}
