import type { ContactLanguageCode, LanguageCode, TranslationLanguages } from './languages.js';

/** Compatibility direction for existing adapters; explicit languages take precedence. */
export type TranslationDirection = 'ru-sr' | 'sr-ru';

export interface Translator {
  translate(text: string, direction: TranslationDirection, languages?: TranslationLanguages): Promise<string>;
}

export interface Transport {
  send(contactId: string, text: string, messageId?: string): Promise<{ messageId: string }>;
}

export interface Contact {
  id: string;
  name: string;
  language?: ContactLanguageCode;
}

/** Metadata discovered from WhatsApp. Discovery never enables translation. */
export interface DiscoveredChat {
  id: string;
  name?: string;
  lastMessageAt?: string;
  preview?: string;
  /** Omitted metadata must not clear an earlier WhatsApp update. */
  pinnedAt?: string | null;
  archived?: boolean;
  hasConversation?: boolean;
}

export interface ChatListEntry extends Contact {
  translationEnabled: boolean;
  lastMessageAt: string | null;
  preview: string | null;
  pinnedAt: string | null;
  archived: boolean | null;
  hasConversation: boolean;
}

export type MessageStatus =
  | 'translating'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'received'
  | 'failed'
  | 'unknown';

export interface Message {
  id: string;
  direction: 'outgoing' | 'incoming';
  contactId: string;
  originalText: string;
  translatedText: string | null;
  status: MessageStatus;
  remoteId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  errorCode: string | null;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

export interface SendRequest {
  contactId: string;
  text: string;
  idempotencyKey: string;
}

export interface IncomingMessage {
  id: string;
  contactId: string;
  text: string;
  fromMe?: boolean;
  isHistory?: boolean;
}

export class ServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function isIndividualContactId(value: string): boolean {
  return typeof value === 'string' && /^\d+@s\.whatsapp\.net$/.test(value);
}
