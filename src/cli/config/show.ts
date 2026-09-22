import { describeConfig, type ConfigDescription, type ServerDescription } from '../../configDescribe.js';
import { printFieldLine } from './format.js';

export function runConfigShow(
  env: NodeJS.ProcessEnv,
  explicitConfigFile: string | undefined,
  explicitProfile: string | undefined,
  json: boolean
): void {
  const description = describeConfig(env, explicitConfigFile, explicitProfile);
  if (json) {
    console.log(JSON.stringify(description));
    return;
  }
  printHuman(description);
}

function printHuman(description: ConfigDescription): void {
  console.log(`Общий файл: ${description.commonFile}`);
  console.log(`Общий файл найден: ${description.commonFileFound ? 'да' : 'нет'}`);
  console.log(`Текущий профиль: ${description.profileName} (выбран: ${description.profileSource})`);
  console.log(`Файл профиля: ${description.profileFile}`);
  console.log(`Файл профиля найден: ${description.profileFileFound ? 'да' : 'нет'}`);
  console.log(`Файл секретов: ${description.credentialsFile}`);
  console.log(`Файл секретов найден: ${description.credentialsFileFound ? 'да' : 'нет'}`);
  console.log(`Файл заметок: ${description.notesFile}`);
  console.log(`Файл заметок найден: ${description.notesFileFound ? 'да' : 'нет'}`);
  printFieldLine('description', description.description);
  for (const server of description.servers) {
    printServer(server);
  }
  printFieldLine('jobs', description.jobs);
  printFieldLine('defaultServer', description.defaultServer);
  printFieldLine('repos', description.repos);
  printFieldLine('environment', description.environment);
  printFieldLine('allowedJobs', description.allowedJobs);
  printFieldLine('report.timeZone', description.report.timeZone);
  for (const limit of description.limits) {
    printFieldLine(limit.name, limit);
  }
  printFieldLine('cacheDir', description.cacheDir);
}

function printServer(server: ServerDescription): void {
  console.log(`Сервер ${server.name}:`);
  printFieldLine(`  ${server.name}.kind`, server.kind);
  printFieldLine(`  ${server.name}.auth`, server.auth);
  printFieldLine(`  ${server.name}.baseUrl`, server.baseUrl);
  printFieldLine(`  ${server.name}.reportArtifact`, server.reportArtifact);
  printFieldLine(`  ${server.name}.workspaceNodeMax`, server.workspaceNodeMax);
  for (const field of ['proxyUser', 'proxyPass', 'user', 'token'] as const) {
    if (server[field]) printFieldLine(`  ${server.name}.${field}`, server[field]);
  }
}
