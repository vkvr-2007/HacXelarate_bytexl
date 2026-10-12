import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    fileParallelism: false, // API tests share one Postgres test database
    setupFiles: ['tests/setup.js'],
  },
});
