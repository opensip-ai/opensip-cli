export interface WidgetConfig {
  widgetFactor: number
}

export const defaults: WidgetConfig = JSON.parse('{"widgetFactor":1}') as WidgetConfig
