export interface AppConfig {
  readonly usedKnob: string;
  readonly orphanKnob: string;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  usedKnob: 'yes',
  orphanKnob: 'never-read',
};