import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export interface PapercutConfig {
  papersDir: string;
  dataDir: string;
  dbPath: string;
  semanticScholarApiKey?: string;
  crossrefEmail?: string;
}

export function loadConfig(): PapercutConfig {
  const papersDir = process.env.PAPERCUT_PAPERS_DIR || path.join(projectRoot, 'papers');
  const dataDir = process.env.PAPERCUT_DATA_DIR || path.join(projectRoot, 'data');

  return {
    papersDir,
    dataDir,
    dbPath: path.join(dataDir, 'papercut.db'),
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
    crossrefEmail: process.env.CROSSREF_EMAIL,
  };
}
