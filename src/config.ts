import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import type { ProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export interface PapercutConfig {
  papersDir: string;
  dataDir: string;
  dbPath: string;
  semanticScholarApiKey?: string;
  crossrefEmail?: string;
  openalexEmail?: string;
  unpaywallEmail?: string;
  coreApiKey?: string;
  anthropicApiKey?: string;
  providers: Record<string, ProviderConfig>;
}

export function loadConfig(): PapercutConfig {
  const papersDir = process.env.PAPERCUT_PAPERS_DIR || path.join(projectRoot, 'papers');
  const dataDir = process.env.PAPERCUT_DATA_DIR || path.join(projectRoot, 'data');

  // Load optional config file
  let fileConfig: any = {};
  const configPath = path.join(projectRoot, 'papercut.config.json');
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {}
  }

  // Email for polite API pools (shared across providers that need it)
  const email = process.env.CROSSREF_EMAIL
    || process.env.PAPERCUT_EMAIL
    || fileConfig.email
    || undefined;

  return {
    papersDir: process.env.PAPERCUT_PAPERS_DIR || fileConfig.papersDir || papersDir,
    dataDir: process.env.PAPERCUT_DATA_DIR || fileConfig.dataDir || dataDir,
    dbPath: path.join(
      process.env.PAPERCUT_DATA_DIR || fileConfig.dataDir || dataDir,
      'papercut.db'
    ),
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || fileConfig.semanticScholarApiKey,
    crossrefEmail: email,
    openalexEmail: process.env.OPENALEX_EMAIL || email,
    unpaywallEmail: process.env.UNPAYWALL_EMAIL || email || 'papercut@example.com',
    coreApiKey: process.env.CORE_API_KEY || fileConfig.coreApiKey,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey,
    providers: fileConfig.providers || {},
  };
}
