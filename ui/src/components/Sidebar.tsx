import { NavLink } from 'react-router-dom';
import './Sidebar.css';

const links = [
  { to: '/providers', label: 'Providers', icon: '⚙' },
  { to: '/api-keys', label: 'API Keys', icon: '🔑' },
  { to: '/analysis', label: 'Analysis', icon: '📊' },
  { to: '/logs', label: 'Logs', icon: '📋' },
  { to: '/settings', label: 'Settings', icon: '⚡' },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>llmweb2api</h2>
      </div>
      <nav className="sidebar-nav">
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="sidebar-icon">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
