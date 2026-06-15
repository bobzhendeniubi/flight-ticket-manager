import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { App } from './App';
import './styles/index.css';
import { i18nReady } from './i18n';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const root = createRoot(rootEl);
function renderApp(): void {
  root.render(
    <StrictMode>
      <HelmetProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </HelmetProvider>
    </StrictMode>,
  );
}

// 等 i18n init 完成再渲染，保证首屏 t() 不会输出原始 key（资源内联，几乎瞬时）。
// 出错也兜底渲染，避免白屏。
i18nReady.then(renderApp).catch(renderApp);
