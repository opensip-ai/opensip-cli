/// <reference lib="dom" />
/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

import { renderSubtabBar } from '../client/subtab-bar.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderSubtabBar resiliency', () => {
  it('isolates one failing renderer and continues rendering its siblings', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);

    const panels = renderSubtabBar(host, [
      {
        id: 'broken',
        label: 'Broken',
        render() {
          throw new Error('opaque payload drift');
        },
      },
      {
        id: 'healthy',
        label: 'Healthy',
        render(panel) {
          panel.textContent = 'Healthy content';
        },
      },
    ]);

    expect(panels.broken.textContent).toContain('Broken could not be rendered.');
    expect(panels.healthy.textContent).toBe('Healthy content');
  });

  it('keeps the current selection when a malformed subtab target is clicked', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    const panels = renderSubtabBar(host, [
      {
        id: 'first',
        label: 'First',
        render(panel) {
          panel.dataset.rendered = 'yes';
        },
      },
      {
        id: 'second',
        label: 'Second',
        render(panel) {
          panel.dataset.rendered = 'yes';
        },
      },
    ]);
    const firstTab = host.querySelector<HTMLElement>('[data-subtab="first"]')!;
    const secondTab = host.querySelector<HTMLElement>('[data-subtab="second"]')!;
    delete secondTab.dataset.subtab;
    secondTab.click();

    expect(firstTab.classList.contains('active')).toBe(true);
    expect(panels.first.classList.contains('active')).toBe(true);
    expect(panels.second.classList.contains('active')).toBe(false);
  });
});
