import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HaikuIndexResult } from '../types.js';

// Truncate to ~25k chars - plenty for Haiku to extract metadata
// from abstract, intro, methodology, and key results
const MAX_TEXT_CHARS = 25_000;

export class HaikuIndexer {
  private claudeCli: string;

  constructor() {
    this.claudeCli = this.findClaudeCli();
  }

  private findClaudeCli(): string {
    if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;

    if (os.platform() === 'win32') {
      const candidates = [
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
        path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
    }

    return 'claude';
  }

  isAvailable(): boolean {
    return true;
  }

  async indexPaper(
    extractedText: string,
    providerMetadata?: { title?: string; authors?: string[]; abstract?: string }
  ): Promise<HaikuIndexResult> {
    const truncatedText = extractedText.slice(0, MAX_TEXT_CHARS);

    const contextInfo = providerMetadata
      ? `\nKnown metadata:\n- Title: ${providerMetadata.title || 'Unknown'}\n- Authors: ${(providerMetadata.authors || []).join(', ') || 'Unknown'}\n- Abstract: ${providerMetadata.abstract || 'Not available'}\n`
      : '';

    const prompt = `You are a research paper indexer. Analyze this paper and return ONLY a JSON object with these fields:
{
  "title": "the paper's title",
  "authors": ["list of author names"],
  "abstract": "concise abstract (2-4 sentences)",
  "keyTopics": ["5-10 key topics/keywords"],
  "summary": "2-3 paragraph summary of the paper's contributions",
  "methodology": "brief description of the methodology used",
  "keyFindings": ["3-7 bullet points of key findings"]
}
${contextInfo}
Paper text:
${truncatedText}

Return ONLY valid JSON, no markdown fences or extra text.`;

    const stdout = await this.callClaude(prompt);
    return this.parseResponse(stdout);
  }

  private callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Filter env to avoid Claude Code conflicts
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('CLAUDECODE') && !k.startsWith('CLAUDE_CODE')) {
          env[k] = v;
        }
      }

      const child = spawn(this.claudeCli, ['--model', 'haiku', '--print'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Haiku indexing timed out after 120s'));
      }, 120_000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Haiku CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          resolve(stdout);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn Haiku CLI: ${err.message}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  private parseResponse(stdout: string): HaikuIndexResult {
    // Strip markdown fences if present
    const cleaned = stdout
      .replace(/^```(?:json)?\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();

    if (!cleaned) {
      throw new Error('Empty response from Haiku');
    }

    const parsed = JSON.parse(cleaned) as HaikuIndexResult;

    if (!parsed.title || !parsed.summary) {
      throw new Error('Missing required fields (title/summary) in Haiku response');
    }

    return {
      title: parsed.title,
      authors: Array.isArray(parsed.authors) ? parsed.authors : [],
      abstract: parsed.abstract || '',
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
      summary: parsed.summary,
      methodology: parsed.methodology || '',
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
    };
  }
}
