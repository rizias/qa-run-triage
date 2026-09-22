export interface Label {
  name: string;
  value: string;
}

export interface Attachment {
  uid?: string;
  name: string;
  source: string;
  type: string;
  size?: number;
}

export interface Step {
  name?: string;
  status?: string;
  steps?: Step[];
  attachments?: Attachment[];
}

export interface TestStage {
  status?: string;
  statusMessage?: string;
  statusTrace?: string;
  steps?: Step[];
  attachments?: Attachment[];
}

export interface HistoryItem {
  uid: string;
  status: string;
  reportUrl?: string;
}

export interface TestCase {
  uid: string;
  name: string;
  fullName: string;
  historyId?: string;
  status: string;
  statusMessage?: string;
  statusTrace?: string;
  flaky: boolean;
  newFailed: boolean;
  retry?: boolean;
  hidden: boolean;
  retriesCount: number;
  retriesStatusChange: boolean;
  labels: Label[];
  parameterValues: string[];
  testStage?: TestStage;
  extra?: {
    history?: { items?: HistoryItem[] };
    retries?: { status: string }[];
  };
}

export interface AllureSummary {
  statistic: {
    failed: number;
    broken: number;
    skipped: number;
    passed: number;
    unknown: number;
    total: number;
  };
  time: { duration: number };
}
