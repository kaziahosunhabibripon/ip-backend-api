import { config as loadDotEnv } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

let environmentLoaded = false;

export const isProductionEnvironment = () =>
  process.env.NODE_ENV === 'production';

export const getEnvFileName = () => {
  if (!isProductionEnvironment()) {
    return '.env.local';
  }

  return '.env.prod';
};

export const getEnvFilePath = () => join(process.cwd(), getEnvFileName());

export const loadEnvironment = () => {
  if (environmentLoaded) {
    return;
  }

  const envFilePath = getEnvFilePath();

  if (existsSync(envFilePath)) {
    loadDotEnv({
      path: envFilePath,
      override: true,
    });
  }

  environmentLoaded = true;
};
