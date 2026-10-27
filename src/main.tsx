import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PrintTranslation from './pages/PrintTranslation';
import { isMac } from './platform';
import './styles.css';

document.documentElement.dataset.platform = isMac ? 'mac' : 'other';

// A hidden window opened with ?print=<book id> lays out the translation PDF instead.
const params = new URLSearchParams(location.search);
const printing = params.get('print');
if (printing) document.documentElement.classList.add('printing');

createRoot(document.getElementById('root')!).render(
  printing ? (
    <PrintTranslation
      bookId={printing}
      bilingual={params.get('bilingual') === '1'}
      font={Number(params.get('font')) || 11}
      image={Number(params.get('image')) || 8}
    />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
