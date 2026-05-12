import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MochiApp from '../todo-notes-app.jsx';

const root = createRoot(document.getElementById('root'));
root.render(
  <StrictMode>
    <MochiApp />
  </StrictMode>
);
