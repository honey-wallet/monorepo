import type {
  ApiErrorBody,
  Health,
  PairChannel,
  PairMessage,
  PairSlot,
  VersionInfo,
} from './types';

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

  async function send(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body?.error?.code ?? 'unknown',
        body?.error?.message ?? `Request failed with status ${response.status}`,
      );
    }
    return response;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await send(path, init)).json()) as T;
  }

  // The token goes in a header, never the URL, so it stays out of access logs.
  const pairPath = ({ channel }: PairChannel, slot: PairSlot) =>
    `/api/v1/pairing/${encodeURIComponent(channel)}/${slot}`;
  const pairHeaders = ({ token }: PairChannel) => ({ 'X-Pair-Token': token });

  return {
    health: (init?: RequestInit) => request<Health>('/health', init),
    version: (init?: RequestInit) => request<VersionInfo>('/api/v1/version', init),
    /** Leaves a pairing message for the other device. */
    pairSend: async (pair: PairChannel, slot: PairSlot, message: PairMessage) => {
      await send(pairPath(pair, slot), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...pairHeaders(pair) },
        body: JSON.stringify(message),
      });
    },
    /** Takes the waiting pairing message, or null if it hasn't arrived yet. */
    pairReceive: async (pair: PairChannel, slot: PairSlot, init?: RequestInit) => {
      try {
        return await request<PairMessage>(pairPath(pair, slot), {
          ...init,
          headers: { ...pairHeaders(pair), ...init?.headers },
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
