import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './src/App.tsx';
import './src/index.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
