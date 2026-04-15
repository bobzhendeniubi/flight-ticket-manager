import { Link } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export function HomePage() {
  const user = useAuth((s) => s.user);

  return (
    <div className="space-y-8">
      <section className="card">
        <h1 className="text-2xl font-bold text-slate-900">Welcome{user ? `, ${user.displayName ?? user.email}` : ''}</h1>
        <p className="mt-2 text-slate-600">
          Search and book flights, hotels, airport transfers, and visas — one platform for customers and travel
          agents.
        </p>
        {!user && (
          <div className="mt-4 flex gap-3">
            <Link to="/login" className="btn-primary">Sign in</Link>
            <Link to="/register" className="btn-secondary">Create account</Link>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: 'Flights', desc: 'Self-operated routes with dynamic pricing.' },
          { title: 'Hotels', desc: 'Curated partner inventory, bookable as add-on.' },
          { title: 'Transfers', desc: 'Airport pickups and ground transport.' },
          { title: 'Visas', desc: 'Document upload + processing status tracking.' },
        ].map((c) => (
          <div key={c.title} className="card">
            <h3 className="font-semibold text-slate-900">{c.title}</h3>
            <p className="mt-1 text-sm text-slate-600">{c.desc}</p>
            <p className="mt-3 text-xs uppercase tracking-wide text-slate-400">Coming in M2–M3</p>
          </div>
        ))}
      </section>
    </div>
  );
}
