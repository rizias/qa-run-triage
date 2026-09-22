import { writeCommonFileProfile } from '../../commonConfig.js';

export function runConfigUse(profile: string): void {
  const commonPath = writeCommonFileProfile(profile);
  console.log(`Текущий профиль: ${profile}`);
  console.log(`Общий файл: ${commonPath}`);
}
