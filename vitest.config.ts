import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live tests hit the real supermarket websites; they only run with LIVE=1.
    exclude: process.env.LIVE ? [] : ['test/live/**'],
    testTimeout: 20_000,
  },
});
