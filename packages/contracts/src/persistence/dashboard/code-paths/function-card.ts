/**
 * Universal Function Card overlay — opened by every view's row click.
 *
 * Phase P0 stub; Phase P2 implements the full open/close + caller/callee
 * rendering with delegated click handling.
 */

export function dashboardFunctionCardJs(): string {
  return String.raw`
function openFunctionCard(bodyHash) {
  // Phase P2 implements the full overlay.
}

function closeFunctionCard() {
  const overlay = document.querySelector('.function-card-overlay');
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}
`;
}
