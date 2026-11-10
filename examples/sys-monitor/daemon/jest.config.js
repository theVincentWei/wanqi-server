/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  // 显式 testMatch：__tests__ 下的 fixtures（.json 金标准）不得混入套件数
  testMatch: ['**/*.test.ts'],
  testTimeout: 15000,
};
