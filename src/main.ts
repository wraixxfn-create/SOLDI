import { WorldBugError } from './core/errors.ts';
import { createApp } from './ui/app.ts';
import './ui/styles.css';

/**
 * Boot. Two obligations: start the app, and never leave the player staring at a dead page.
 * Anything thrown during construction, during the frame loop, or in an unhandled promise lands in
 * the error overlay with a copyable report — and the game stays in whatever state it reached.
 */

const overlayId = 'error-overlay';

function showErrorOverlay(error: unknown, context: string): void {
  const existing = document.getElementById(overlayId);
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = 'WORLDBUG hit a fault';
  card.append(heading);

  const info = document.createElement('p');
  info.textContent =
    'The simulation is deterministic: reloading and starting the same sector with the same actions reproduces this exactly. The report below is what a bug tracker needs.';
  card.append(info);

  const pre = document.createElement('pre');
  pre.textContent = reportText(error, context);
  card.append(pre);

  const actions = document.createElement('div');
  actions.className = 'row';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy report';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(pre.textContent ?? '').catch(() => {
      copy.textContent = 'Copy failed — select the text manually';
    });
  });

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => window.location.reload());

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => overlay.remove());

  actions.append(copy, reload, dismiss);
  card.append(actions);

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', 'Application fault');
  overlay.append(card);

  existing?.remove();
  document.body.append(overlay);
}

function reportText(error: unknown, context: string): string {
  const lines = [`context: ${context}`, `time: ${new Date().toISOString()}`, `url: ${window.location.href}`];
  if (error instanceof WorldBugError) lines.push(`kind: ${error.name}`, `details: ${JSON.stringify(error.details)}`);
  if (error instanceof Error) {
    lines.push(`name: ${error.name}`, `message: ${error.message}`);
    if (error.stack) lines.push('', error.stack);
  } else {
    lines.push(`value: ${String(error)}`);
  }
  return lines.join('\n');
}

function boot(): void {
  try {
    const app = createApp({ document });
    app.start();
    window.addEventListener('error', (event) => {
      showErrorOverlay(event.error ?? event.message, 'window error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      showErrorOverlay(event.reason, 'unhandled promise rejection');
    });
    // The canvas keeps its own aspect ratio: re-measure on layout changes the CSS alone cannot see.
    window.addEventListener('resize', () => {
      const mission = app.getMission();
      if (mission) app.getRenderer().resize(mission.config);
    });
  } catch (error) {
    showErrorOverlay(error, 'boot');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
