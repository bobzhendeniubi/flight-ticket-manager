import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';

interface FullUser {
  id: string;
  email: string | null;
  phone: string | null;
  role: string;
  displayName: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export function ProfilePage() {
  const tokens = useAuth((s) => s.tokens);
  const [user, setUser] = useState<FullUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tokens) return;
    api.me(tokens.accessToken)
      .then((res) => setUser(res.user))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Failed to load profile');
      });
  }, [tokens]);

  if (error) {
    return (
      <div className="card">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!user) {
    return <div className="card text-slate-500">Loading profile…</div>;
  }

  return (
    <div className="card max-w-xl">
      <h1 className="text-xl font-semibold text-slate-900">My profile</h1>
      <dl className="mt-4 divide-y divide-slate-200">
        {[
          ['User ID', user.id],
          ['Email', user.email ?? '—'],
          ['Display name', user.displayName ?? '—'],
          ['Phone', user.phone ?? '—'],
          ['Role', user.role],
          ['Email verified', user.emailVerified ? 'Yes' : 'No'],
          ['Created', new Date(user.createdAt).toLocaleString()],
          ['Last login', user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between py-2 text-sm">
            <dt className="font-medium text-slate-600">{label}</dt>
            <dd className="text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
