import type { Attachment, TestCase } from '../report/types.js';
import { labelOf, mainRecords } from '../report/read.js';
import { collectAttachments } from '../report/attachments.js';
import { parseSourceTail } from '../sources/testPath.js';

export interface Failure {
  name: string;
  fullName: string;
  testClass: string | null;
  testMethod: string | null;
  testFile: string | null;
  testLine: number | null;
  status: string;
  statusMessage: string;
  statusTrace: string;
  newFailed: boolean;
  retriesCount: number;
  retryStatuses: string[];
  historyStatuses: string[];
  parameterValues: string[];
  attachments: Attachment[];
  fingerprint: string;
  epic: string | null;
  feature: string | null;
  owner: string | null;
}

export function listFailures(
  cases: TestCase[],
  include: 'failed' | 'recovered'
): Failure[] {
  const main = mainRecords(cases);
  const picked =
    include === 'failed'
      ? main.filter((item) => item.status === 'failed' || item.status === 'broken')
      : main.filter((item) => item.status === 'passed' && item.retriesCount > 0);

  return picked.map(toFailure).sort((left, right) => {
    if (left.newFailed === right.newFailed) {
      return 0;
    }
    return left.newFailed ? -1 : 1;
  });
}

interface TestIdentity {
  testClass: string | null;
  testMethod: string | null;
  testFile: string | null;
  testLine: number | null;
}

function testIdentity(testCase: TestCase): TestIdentity {
  if (labelOf(testCase, 'framework') !== 'playwright') {
    return {
      testClass: labelOf(testCase, 'testClass'),
      testMethod: labelOf(testCase, 'testMethod'),
      testFile: null,
      testLine: null
    };
  }
  const tail = parseSourceTail(testCase.fullName);
  return { testClass: null, testMethod: null, testFile: tail.path, testLine: tail.line };
}

function toFailure(testCase: TestCase): Failure {
  const statusMessage = testCase.testStage?.statusMessage || testCase.statusMessage || '';

  return {
    name: testCase.name,
    fullName: testCase.fullName,
    ...testIdentity(testCase),
    status: testCase.status,
    statusMessage,
    statusTrace: testCase.testStage?.statusTrace ?? testCase.statusTrace ?? '',
    newFailed: testCase.newFailed,
    retriesCount: testCase.retriesCount,
    retryStatuses: (testCase.extra?.retries ?? []).map((item) => item.status),
    historyStatuses: (testCase.extra?.history?.items ?? []).map((item) => item.status),
    parameterValues: testCase.parameterValues ?? [],
    attachments: collectAttachments(testCase.testStage ?? {}),
    fingerprint: statusMessage,
    epic: labelOf(testCase, 'epic'),
    feature: labelOf(testCase, 'feature'),
    owner: labelOf(testCase, 'owner')
  };
}
