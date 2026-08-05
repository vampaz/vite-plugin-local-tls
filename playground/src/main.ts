import { message } from './message';

function setText(id: string, value: string): void {
  const element = document.querySelector(`#${id}`);
  if (element) {
    element.textContent = value;
  }
}

setText('marker', import.meta.env.VITE_FIXTURE_MARKER ?? 'unset');
setText('checkout', import.meta.env.VITE_FIXTURE_CHECKOUT ?? 'unknown');
setText('branch', import.meta.env.VITE_FIXTURE_BRANCH ?? 'unknown');
setText('protocol', window.location.protocol);
setText('hmr', import.meta.hot ? 'available' : 'unavailable');
setText('message', message);

if (import.meta.hot) {
  import.meta.hot.accept('./message', (module) => {
    if (module) {
      setText('message', module.message);
    }
  });
}
