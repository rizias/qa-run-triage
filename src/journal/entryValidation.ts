import { z } from 'zod';
import { LEGACY_BUILD_URL_FIELD } from '../ci/createClient.js';

const text = z.string().optional();
const number = z.number().finite().optional();
const nullableText = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();
const schema = z.object({
  job: z.string(), build: z.number().finite(), analyzedAt: z.string(), testsRan: z.boolean(),
  env: text, city: text, branch: text, codeBranch: text, verdict: text, model: text, server: text,
  result: nullableText, commit: nullableText, buildUrl: nullableText,
  testSetHash: nullableText, sourceHash: nullableText,
  total: nullableNumber, failed: nullableNumber, buildTimestamp: nullableNumber, durationMs: nullableNumber,
  recoveredAfterRetry: number, analysisDurationMs: number, tokensIn: number, tokensOut: number,
  fingerprints: z.array(z.string()).optional(), signatureVersion: z.literal('legacy').optional(),
  [LEGACY_BUILD_URL_FIELD]: nullableText
}).passthrough();

export function validateJournalEntry(value: unknown): z.infer<typeof schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Строка журнала не соответствует типам полей');
  return parsed.data;
}
