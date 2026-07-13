import type { Config } from 'jest';

// Yalniz unit testler (src/**/*.spec.ts). Integration/E2E ayri config'lerle
// calisir (test/integration/jest-integration.json, test/e2e/jest-e2e.json) -
// onaylanan Faz 2 plani Bolum 12.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};

export default config;
