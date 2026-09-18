/** Operator-selected contact languages. Russian stays the owner's base language. */
export const CONTACT_LANGUAGES = [
  { code: 'sr-Latn', label: 'Сербский — латиница' },
  { code: 'sr-Cyrl', label: 'Сербский — кириллица' },
  { code: 'en', label: 'Английский' },
  { code: 'de', label: 'Немецкий' },
  { code: 'fr', label: 'Французский' },
  { code: 'es', label: 'Испанский' },
  { code: 'it', label: 'Итальянский' },
  { code: 'pt', label: 'Португальский' },
  { code: 'tr', label: 'Турецкий' },
  { code: 'hr', label: 'Хорватский' },
  { code: 'bs', label: 'Боснийский' },
  { code: 'uk', label: 'Украинский' },
  { code: 'ar', label: 'Арабский' },
  { code: 'zh', label: 'Китайский' },
  { code: 'ja', label: 'Японский' },
  { code: 'ko', label: 'Корейский' },
] as const;

export type ContactLanguageCode = typeof CONTACT_LANGUAGES[number]['code'];
export type LanguageCode = 'ru' | ContactLanguageCode;
export const DEFAULT_CONTACT_LANGUAGE: ContactLanguageCode = 'sr-Latn';

export interface TranslationLanguages {
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

export function isContactLanguage(value: unknown): value is ContactLanguageCode {
  return typeof value === 'string' && CONTACT_LANGUAGES.some(language => language.code === value);
}

export function isLanguageCode(value: unknown): value is LanguageCode {
  return value === 'ru' || isContactLanguage(value);
}

export function isTranslationLanguages(value: unknown): value is TranslationLanguages {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pair = value as Partial<TranslationLanguages>;
  return Object.keys(pair).sort().join(',') === 'sourceLanguage,targetLanguage'
    && isLanguageCode(pair.sourceLanguage) && isLanguageCode(pair.targetLanguage)
    && ((pair.sourceLanguage === 'ru' && isContactLanguage(pair.targetLanguage))
      || (isContactLanguage(pair.sourceLanguage) && pair.targetLanguage === 'ru'));
}

export function translationLanguages(
  direction: 'outgoing' | 'incoming',
  contactLanguage: ContactLanguageCode = DEFAULT_CONTACT_LANGUAGE,
): TranslationLanguages {
  return direction === 'outgoing'
    ? { sourceLanguage: 'ru', targetLanguage: contactLanguage }
    : { sourceLanguage: contactLanguage, targetLanguage: 'ru' };
}
