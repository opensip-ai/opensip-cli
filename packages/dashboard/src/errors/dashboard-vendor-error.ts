/**
 * Missing committed dashboard vendor asset.
 *
 * Disposition for the cytoscape-bundle throw is normalize-at-enclosing-boundary
 * (report-compose classifies). The leaf still must not be a bare `Error` so the
 * package can join the bare-throw ratchet without inventing a substrate catalog
 * only for this site.
 */
export class DashboardVendorAssetError extends Error {
  override readonly name = 'DashboardVendorAssetError';
  readonly asset: 'cytoscape-bundle';

  constructor(message: string) {
    super(message);
    this.asset = 'cytoscape-bundle';
  }
}
