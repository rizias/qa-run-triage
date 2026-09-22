import type { EnvironmentConfig } from '../configFields.js';

export interface RunEnvironment {
  env: string;
  city: string;
}

export function environmentFrom(
  parameters: Record<string, string> | undefined,
  environment: EnvironmentConfig
): RunEnvironment {
  return {
    env: firstParameterValue(parameters, environment.env),
    city: firstParameterValue(parameters, environment.city)
  };
}

function firstParameterValue(
  parameters: Record<string, string> | undefined,
  names: readonly string[]
): string {
  if (!parameters) {
    return '';
  }
  for (const name of names) {
    const value = parameters[name];
    if (value !== undefined) {
      return value;
    }
  }
  return '';
}
