export interface Checkout {
  repository: string;
  commit: string;
}

const REPO_URL = /(?:Cloning repository|Fetching upstream changes from|remote\.origin\.url)\s+(\S+)/;
const REVISION = /Checking out Revision\s+([0-9a-f]{40})/;

function parsedUrlPathname(url: string): string[] | null {
  try {
    return new URL(url).pathname.split('/').filter((segment) => segment.length > 0);
  } catch {
    return null;
  }
}

function pathSegments(url: string): string[] {
  const rest = url.trim().replace(/^ssh:\/\//, '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest)) {
    const parsed = parsedUrlPathname(rest);
    if (parsed) {
      return parsed;
    }
  }
  const scpMatch = /^[^/@]+@[^:/]+:(.+)$/.exec(rest);
  const path = scpMatch ? scpMatch[1] : rest;
  return path.split('/').filter((segment) => segment.length > 0);
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith('.git') ? segment.slice(0, -'.git'.length) : segment;
}

export function repositoryIdentityFromUrl(url: string): string {
  const segments = pathSegments(url);
  if (segments.length === 0) {
    return stripGitSuffix(url).toLowerCase();
  }
  const last = stripGitSuffix(segments[segments.length - 1]);
  const secondLast = segments[segments.length - 2];
  const identity = secondLast ? `${secondLast}/${last}` : last;
  return identity.toLowerCase();
}

function identitySegments(value: string): string[] {
  return pathSegments(value)
    .map((segment) => stripGitSuffix(segment).toLowerCase())
    .filter((segment) => segment.length > 0);
}

function lastSegment(value: string): string | undefined {
  const segments = identitySegments(value);
  return segments[segments.length - 1];
}

export function matchStoredRepository(
  stored: string,
  candidate: string,
  allCandidates: readonly string[]
): boolean {
  const storedSegs = identitySegments(stored);
  const candidateSegs = identitySegments(candidate);
  if (storedSegs.length === 0 || candidateSegs.length === 0) {
    return false;
  }
  if (storedSegs.length >= 2 && candidateSegs.length >= 2) {
    return storedSegs.slice(-2).join('/') === candidateSegs.slice(-2).join('/');
  }
  if (storedSegs.length !== 1) {
    return storedSegs[storedSegs.length - 1] === candidateSegs[candidateSegs.length - 1];
  }
  const last = storedSegs[0];
  const matching = allCandidates.filter((item) => lastSegment(item) === last);
  if (matching.length !== 1) {
    return false;
  }
  return candidateSegs[candidateSegs.length - 1] === last;
}

export function ambiguousOneSegmentReason(
  stored: string,
  allCandidates: readonly string[]
): string | null {
  const storedSegs = identitySegments(stored);
  if (storedSegs.length !== 1) {
    return null;
  }
  const last = storedSegs[0];
  const matching = allCandidates.filter((item) => lastSegment(item) === last);
  if (matching.length > 1) {
    return `имя репозитория "${stored}" неоднозначно: несколько записей repos с последним сегментом ${last}`;
  }
  return null;
}

export function parseCheckouts(consoleLog: string): Checkout[] {
  const byRepository = new Map<string, string>();
  let pendingRepository: string | null = null;
  for (const line of consoleLog.split(/\r?\n/)) {
    const urlMatch = REPO_URL.exec(line);
    if (urlMatch) {
      pendingRepository = repositoryIdentityFromUrl(urlMatch[1]);
      continue;
    }
    const revisionMatch = REVISION.exec(line);
    if (revisionMatch && pendingRepository) {
      byRepository.set(pendingRepository, revisionMatch[1]);
      pendingRepository = null;
    }
  }
  return [...byRepository.entries()].map(([repository, commit]) => ({ repository, commit }));
}
