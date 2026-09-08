import { pondControlBasePath, pondControlPath } from './base-path.js';

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    const basePath = pondControlBasePath();
    navigator.serviceWorker.register(pondControlPath('/service-worker.js'), { scope: `${basePath}/` }).catch((registrationError) => {
      console.error('Registrazione PWA non riuscita:', registrationError);
    });
  });
}
