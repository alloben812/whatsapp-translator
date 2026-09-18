export type TranslationDirection = 'ru-sr' | 'sr-ru';

export interface Translator {
  translate(text: string, direction: TranslationDirection): Promise<string>;
}

export interface Transport {
  send(contactId: string, text: string, messageId?: string): Promise<{ messageId: string }>;
}

export interface Contact {
  id: string;
  name: string;
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
