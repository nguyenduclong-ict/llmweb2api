import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Providers from './pages/Providers';
import ApiKeys from './pages/ApiKeys';
import Analysis from './pages/Analysis';
import Logs from './pages/Logs';
import Settings from './pages/Settings';

function ProtectedRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/providers" replace />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/api-keys" element={<ApiKeys />} />
        <Route path="/analysis" element={<Analysis />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('dashboard_password'));

  if (!authed) {
    return (
      <Login
        onLogin={(password) => {
          localStorage.setItem('dashboard_password', password);
          setAuthed(true);
        }}
      />
    );
  }

  return <ProtectedRoutes />;
}
