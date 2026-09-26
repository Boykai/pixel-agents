import type { ObservationCapabilities } from '../../core/src/provider.js';

export interface ProviderSettings {
  providerId: string;
  displayName: string;
  capabilities?: ObservationCapabilities;
  disclosure?: string;
}

export interface HooksFeedback {
  canManage?: boolean;
  error?: string;
}
