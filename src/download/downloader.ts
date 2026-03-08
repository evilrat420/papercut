import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { DownloadProgress, FileFormat } from '../types.js';

export class Downloader {
  private papersDir: string;

  constructor(papersDir: string) {
    this.papersDir = papersDir;
    if (!fs.existsSync(papersDir)) fs.mkdirSync(papersDir, { recursive: true });
  }

  async download(
    urls: string[],
    title: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ filePath: string; fileSize: number; format: FileFormat }> {
    if (urls.length === 0) throw new Error('No download URLs provided');

    const sanitized = this.sanitizeFilename(title);
    let lastError: Error | null = null;

    for (const url of urls) {
      const tmpPath = path.join(this.papersDir, `${sanitized}.tmp`);

      try {
        onProgress?.({
          phase: 'downloading',
          bytesDownloaded: 0,
          message: `Starting download from ${new URL(url).hostname}...`,
        });

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const totalBytes = parseInt(response.headers.get('content-length') || '0', 10) || undefined;
        const body = response.body;
        if (!body) throw new Error('No response body');

        const writeStream = fs.createWriteStream(tmpPath);
        let bytesDownloaded = 0;

        const reader = body.getReader();
        const nodeStream = new Readable({
          async read() {
            try {
              const { done, value } = await reader.read();
              if (done) {
                this.push(null);
                return;
              }
              bytesDownloaded += value.byteLength;
              onProgress?.({
                phase: 'downloading',
                bytesDownloaded,
                totalBytes,
                message: totalBytes
                  ? `Downloaded ${formatBytes(bytesDownloaded)} / ${formatBytes(totalBytes)}`
                  : `Downloaded ${formatBytes(bytesDownloaded)}`,
              });
              this.push(Buffer.from(value));
            } catch (err) {
              this.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          },
        });

        await pipeline(nodeStream, writeStream);

        // Detect format from URL extension, content-type, then magic bytes
        const format = this.detectFormat(url, contentType, tmpPath);
        const ext = FORMAT_TO_EXT[format] || '.bin';

        // Validate magic bytes for known formats
        if (!this.validateMagicBytes(tmpPath, format)) {
          fs.unlinkSync(tmpPath);
          throw new Error(`Downloaded file is not a valid ${format.toUpperCase()}`);
        }

        // Build final path with correct extension
        let filePath = path.join(this.papersDir, `${sanitized}${ext}`);
        let counter = 1;
        while (fs.existsSync(filePath)) {
          filePath = path.join(this.papersDir, `${sanitized}_${counter}${ext}`);
          counter++;
        }

        // Atomic rename
        fs.renameSync(tmpPath, filePath);
        const stats = fs.statSync(filePath);

        onProgress?.({
          phase: 'complete',
          bytesDownloaded: stats.size,
          totalBytes: stats.size,
          message: `Download complete: ${formatBytes(stats.size)}`,
        });

        return { filePath, fileSize: stats.size, format };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        continue;
      }
    }

    onProgress?.({
      phase: 'failed',
      bytesDownloaded: 0,
      message: `Download failed: ${lastError?.message}`,
    });

    throw lastError || new Error('All download URLs failed');
  }

  private detectFormat(url: string, contentType: string, tmpPath: string): FileFormat {
    // 1. Check URL extension
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (pathname.endsWith('.epub')) return 'epub';
      if (pathname.endsWith('.pdf')) return 'pdf';
      if (pathname.endsWith('.txt') || pathname.endsWith('.text')) return 'txt';
      if (pathname.endsWith('.html') || pathname.endsWith('.htm')) return 'html';
    } catch {}

    // 2. Check Content-Type
    if (contentType.includes('epub')) return 'epub';
    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.includes('text/html')) return 'html';
    if (contentType.includes('text/plain')) return 'txt';

    // 3. Check magic bytes
    try {
      const header = Buffer.alloc(8);
      const fd = fs.openSync(tmpPath, 'r');
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      if (header.toString('ascii', 0, 4) === '%PDF') return 'pdf';
      if (header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04) return 'epub';
    } catch {}

    return 'pdf'; // Default assumption for academic papers
  }

  private validateMagicBytes(tmpPath: string, format: FileFormat): boolean {
    try {
      const header = Buffer.alloc(8);
      const fd = fs.openSync(tmpPath, 'r');
      const bytesRead = fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      if (bytesRead < 4) return false;

      switch (format) {
        case 'pdf':
          return header.toString('ascii', 0, 4) === '%PDF';
        case 'epub':
          // EPUB is a ZIP file: PK\x03\x04
          return header[0] === 0x50 && header[1] === 0x4B
            && header[2] === 0x03 && header[3] === 0x04;
        case 'txt':
        case 'html':
          return true; // No strict magic bytes for text
        default:
          return true;
      }
    } catch {
      return false;
    }
  }

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 150)
      .replace(/_+$/, '');
  }
}

const FORMAT_TO_EXT: Record<string, string> = {
  pdf: '.pdf',
  epub: '.epub',
  txt: '.txt',
  html: '.html',
  unknown: '.bin',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
