import type { ApiErrorBody, Health, VersionInfo } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  /** Server origin, e.g. `http://localhost:8080`. */
  baseUrl: string;
  /** Override for tests or custom transports. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient({ baseUrl, fetch: fetchImpl = fetch }: ApiClientOptions) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body?.error.code ?? 'unknown',
        body?.error.message ?? `Request failed with status ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }

  return {
    health: (init?: RequestInit) => request<Health>('/health', init),
    version: (init?: RequestInit) => request<VersionInfo>('/api/v1/version', init),
  };
}
