import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { consumeVerificationCredential } from './verification.js';
import './styles.css';

const token = consumeVerificationCredential(window.location, window.history);
const root = document.getElementById('root');
if (!root) throw new Error('Application root unavailable');
createRoot(root).render(<App verificationToken={token} />);
