/**
 * SHARED with sales-web/src/lib/api.ts — keep them in sync (admin-web subset).
 * 后端 REST API 封装。所有端点都在 /api 下，由 vite-dev 代理到 :4000。
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

type ApiRequestInit = Omit<RequestInit, 'body'> & {
  body?: unknown;
  token?: string | null;
};

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);

  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const errBody = (parsed as ApiErrorBody | undefined)?.error ?? {
      code: 'UNKNOWN',
      message: res.statusText,
    };
    throw new ApiError(res.status, errBody);
  }
  return parsed as T;
}

// ── 类型 ──────────────────────────────────────────────────────────────────

export type UserRole = 'CUSTOMER' | 'AGENT' | 'STAFF' | 'ADMIN';
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';

export interface AuthUser {
  id: string;
  email: string | null;
  role: UserRole;
  displayName: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthResult {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface AdminFlight {
  id: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  aircraftType: string | null;
  isActive: boolean;
  scheduleCount: number;
  createdAt: string;
}

export interface AdminScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  basePrice: string;
}

export interface AdminSchedule {
  id: string;
  flightId: string;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
  isActive: boolean;
  seatClasses: AdminScheduleSeat[];
}

export interface AgentListItem {
  id: string;
  userId: string;
  tier: number;
  parentAgentId: string | null;
  parent: { id: string; companyName: string | null; contactName: string; tier: number } | null;
  companyName: string | null;
  contactName: string;
  contactPhone: string;
  prepaymentBalance: string;
  isActive: boolean;
  notes: string | null;
  email: string | null;
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  childCount: number;
  orderCount: number;
}

export interface CreateChildAgentInput {
  email: string;
  password: string;
  displayName: string;
  contactName: string;
  contactPhone: string;
  companyName?: string;
  prepaymentBalance?: number;
  notes?: string;
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<AuthResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  logout: (refreshToken: string) =>
    apiFetch<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  me: (token: string) =>
    apiFetch<{ user: AuthUser & { phone: string | null; createdAt: string; lastLoginAt: string | null } }>('/users/me', { token }),

  // Flights
  listAllFlights: (token: string) =>
    apiFetch<{ flights: AdminFlight[] }>('/flights/', { token }),
  createFlight: (
    token: string,
    body: { flightNumber: string; originCode: string; destinationCode: string; aircraftType?: string },
  ) => apiFetch<{ flight: AdminFlight }>('/flights/', { method: 'POST', token, body }),
  toggleFlight: (token: string, flightId: string) =>
    apiFetch<{ flight: AdminFlight }>(`/flights/${flightId}/toggle`, { method: 'POST', token }),
  listSchedules: (token: string, flightId: string) =>
    apiFetch<{ schedules: AdminSchedule[] }>(`/flights/${flightId}/schedules`, { token }),
  createSchedule: (
    token: string,
    body: {
      flightId: string;
      departureTime: string;
      arrivalTime: string;
      departureTz?: string;
      arrivalTz?: string;
      seatClasses: Array<{ cabin: CabinClass; capacity: number; basePrice: number }>;
    },
  ) => apiFetch<{ schedule: AdminSchedule }>('/flights/schedules', { method: 'POST', token, body }),

  // Agents
  listAgents: (token: string) => apiFetch<{ agents: AgentListItem[] }>('/agents/', { token }),
  createChildAgent: (token: string, body: CreateChildAgentInput, parentId?: string) =>
    apiFetch<{ user: { id: string; email: string | null }; agent: { id: string; tier: number } }>(
      parentId ? `/agents/children?parentId=${encodeURIComponent(parentId)}` : '/agents/children',
      { method: 'POST', token, body },
    ),
};
