import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Agents' git worktrees live in .claude/worktrees with their own copies of the tests.
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
