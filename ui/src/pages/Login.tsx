import { useState } from 'react';
import './Login.css';

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        setError('Invalid password');
        return;
      }

      localStorage.setItem('dashboard_password', password);
      onLogin();
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>llmweb2api</h1>
        <p className="login-subtitle">Dashboard Login</p>
        <div className="form-group">
          <input
            type="password"
            placeholder="Enter dashboard password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="login-error">{error}</p>}
        <button className="btn btn-primary login-btn" type="submit" disabled={loading || !password}>
          {loading ? 'Checking...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
