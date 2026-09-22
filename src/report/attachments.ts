import type { Attachment, Step, TestStage } from './types.js';

export function collectAttachments(stage: TestStage): Attachment[] {
  const found: Attachment[] = [...(stage.attachments ?? [])];
  walk(stage.steps ?? [], found);
  return found;
}

function walk(steps: Step[], found: Attachment[]): void {
  for (const step of steps) {
    found.push(...(step.attachments ?? []));
    walk(step.steps ?? [], found);
  }
}
