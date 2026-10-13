import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { useSaveStore } from '@/store/saveStore';
import '@/styles/global.css';

/**
 * Entry point.
 *
 * Everything runs client-side: no backend, no accounts, no network calls at
 * runtime. Saves live in `localStorage` behind a validating service layer.
 */
/*
 * The dev build points the browser harnesses at the store the app is *actually* running. A gate that gets
 * along by `import('/src/store/saveStore.ts')` is fine until something edits that module and HMR serves the
 * page a `?t=` copy: the literal import then hands back a second, unhydrated store, and tallies that the
 * game recorded read as zero — a harness that lies in the direction of a fault. One handle, one instance.
 */
if (import.meta.env.DEV) {
  (window as unknown as { __sixfoldSave?: typeof useSaveStore }).__sixfoldSave = useSaveStore;
}

const container = document.getElementById('root');

if (!container) {
  // The interface must never fail silently — say what broke and where.
  document.body.innerHTML =
    '<pre style="color:#FF5C6C;font-family:monospace;padding:24px">SIXFOLD failed to mount: #root element is missing from index.html.</pre>';
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
