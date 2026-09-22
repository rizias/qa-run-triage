import { execFileSync } from 'node:child_process';

const INSTALL_PAGE = 'https://github.com/gitleaks/gitleaks';

if (process.env.QA_RUN_TRIAGE_SKIP_SECRET_SCAN === '1') {
  console.log('Проверка секретов пропущена: задана QA_RUN_TRIAGE_SKIP_SECRET_SCAN=1.');
  process.exit(0);
}

function tryRun(args) {
  try {
    execFileSync('gitleaks', args, { stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(
        `gitleaks не установлен. Установите gitleaks: ${INSTALL_PAGE}`
      );
      process.exit(1);
    }
    process.exit(e.status ?? 1);
  }
}

tryRun(['protect', '--staged', '--redact']);
