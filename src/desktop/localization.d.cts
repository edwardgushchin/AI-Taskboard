declare const localization: {
  errorText(message: string): string;
  names: Record<string, string>;
  locale: string;
  catalogs: Record<string, Record<string, string | Record<string, string>>>;
  resolve(preferred?: string[]): string;
  select(preference: string, preferred?: string[]): void;
  install(state: ReturnType<typeof localization.state>): void;
  state(): {locale: string; preference: string; messages: Record<string, string | Record<string, string>>; english: Record<string, string | Record<string, string>>};
  text(key: string, parameters?: Record<string, unknown>, language?: string): string;
};
export = localization;
