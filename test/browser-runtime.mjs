import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* optional local runtime */ }
  try { return await import('playwright-core'); } catch { /* existing CLI runtime */ }
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const runtime = await import(pathToFileURL(join(globalRoot, '@playwright', 'cli', 'node_modules', 'playwright-core', 'index.js')).href);
  return runtime.default ?? runtime;
}
