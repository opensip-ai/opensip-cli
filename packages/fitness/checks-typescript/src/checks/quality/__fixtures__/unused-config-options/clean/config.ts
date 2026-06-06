export interface WidgetConfig {
  widgetFactor: number
}

export function scale(cfg: WidgetConfig, n: number): number {
  return cfg.widgetFactor * n
}
