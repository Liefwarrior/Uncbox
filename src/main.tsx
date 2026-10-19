import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/outfit';
import '@fontsource-variable/cinzel';
import '@fontsource/marcellus';
import '@fontsource-variable/cascadia-mono';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
