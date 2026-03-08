export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0]!;
      const waitTime = Math.max(50, this.windowMs - (now - oldest) + 50);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.waitForSlot();
    }

    this.timestamps.push(Date.now());
  }
}

export interface FetchOptions {
  maxRetries?: number;
  baseDelay?: number;
  headers?: Record<string, string>;
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
}

const NON_RETRYABLE = new Set([400, 401, 404, 405, 410, 422]);

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    headers = {},
    rateLimiter,
    timeoutMs = 30_000,
  } = options;

  if (rateLimiter) {
    await rateLimiter.waitForSlot();
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) return response;

      // Don't retry client errors that won't change
      if (NON_RETRYABLE.has(response.status)) {
        throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}: ${response.statusText}`);
      }

      if ([429, 403, 503].includes(response.status) && attempt < maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}: ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry aborts or non-retryable HTTP errors
      if (lastError.name === 'AbortError' || lastError.name === 'TimeoutError') {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${new URL(url).hostname}`);
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
        continue;
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}
