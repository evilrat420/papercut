import type { PaperProvider, ProviderCapabilities, ProviderConfig } from '../types.js';

export interface ProviderInfo {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  capabilities: ProviderCapabilities;
}

export class ProviderRegistry {
  private providers: Map<string, PaperProvider> = new Map();
  private enabledState: Map<string, boolean> = new Map();
  private priorityOverrides: Map<string, number> = new Map();

  register(provider: PaperProvider): void {
    this.providers.set(provider.id, provider);
    this.enabledState.set(provider.id, true);
  }

  applyConfig(config: Record<string, ProviderConfig>): void {
    for (const [id, cfg] of Object.entries(config)) {
      if (this.providers.has(id)) {
        this.enabledState.set(id, cfg.enabled);
        if (cfg.priority !== undefined) {
          this.priorityOverrides.set(id, cfg.priority);
        }
      }
    }
  }

  get(id: string): PaperProvider | undefined {
    return this.providers.get(id);
  }

  isEnabled(id: string): boolean {
    return this.enabledState.get(id) ?? false;
  }

  setEnabled(id: string, enabled: boolean): void {
    if (this.providers.has(id)) {
      this.enabledState.set(id, enabled);
    }
  }

  private getPriority(provider: PaperProvider): number {
    return this.priorityOverrides.get(provider.id) ?? provider.priority;
  }

  getEnabled(): PaperProvider[] {
    return [...this.providers.values()]
      .filter(p => this.isEnabled(p.id))
      .sort((a, b) => this.getPriority(a) - this.getPriority(b));
  }

  getByCapability(cap: keyof ProviderCapabilities): PaperProvider[] {
    return this.getEnabled().filter(p => p.capabilities[cap]);
  }

  getDisabled(): PaperProvider[] {
    return [...this.providers.values()]
      .filter(p => !this.isEnabled(p.id));
  }

  listAll(): ProviderInfo[] {
    return [...this.providers.values()]
      .sort((a, b) => this.getPriority(a) - this.getPriority(b))
      .map(p => ({
        id: p.id,
        name: p.name,
        enabled: this.isEnabled(p.id),
        priority: this.getPriority(p),
        capabilities: p.capabilities,
      }));
  }

  getAllIds(): string[] {
    return [...this.providers.keys()];
  }
}
