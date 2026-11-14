import { useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { GroupPage } from './pages/GroupPage';

/** Tiny router: "/" and "/g/:groupId". */
export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const m = /^\/g\/([A-Za-z0-9_-]{8,64})\/?$/.exec(path);
  return m ? <GroupPage key={m[1]} groupId={m[1]!} /> : <Home />;
}
