/**
 * Top-level tab-bar click handler.
 *
 * Wires the `#tab-bar` click event to toggle the `active` class on
 * both the `.tab` headers and the `.tab-panel` containers.
 */
export function dashboardTabBarJs(): string {
  return String.raw`
// Tab switching
document.getElementById('tab-bar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
});
`;
}
