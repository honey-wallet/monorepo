import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// The public launch page lives at `/`. The developer console that talks to a
// running server moved to `/app` and loads only when visited.
const DevConsole = lazy(async () => {
  await import('./index.css');
  return import('./App');
});

const isConsole = window.location.pathname.replace(/\/+$/, '') === '/app';

createRoot(root).render(
  <StrictMode>
    {isConsole ? (
      <Suspense fallback={null}>
        <DevConsole />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
