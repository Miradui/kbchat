import type { SystemDiagnostics } from '../../types/api';
import { apiRequest } from '../client';

/**
 * Deployment health. Always resolves for a reachable server: a failing
 * dependency comes back as `status: 'down'` in the payload, not as an HTTP error.
 */
export function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  return apiRequest<SystemDiagnostics>('/system/diagnostics');
}
