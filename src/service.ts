import {
  isIndividualContactId,
  ServiceError,
  type Contact,
  type IncomingMessage,
  type Message,
  type SendRequest,
  type TranslationDirection,
  type Translator,
  type Transport,
} from './domain.js';
import { Store } from './store.js';
import { randomBytes } from 'node:crypto';

function validateText(text: string, maximumLength: number, label: string): void {
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > maximumLength) {
    throw new ServiceError('invalid_input', `${label} must be nonempty and no longer than ${maximumLength} characters.`);
  }
}

/** Single process / instance. Only explicit send() calls can reach the transport. */
export class TranslationService {
  private contacts: ReadonlySet<string> = new Set();

  constructor(
    private readonly store: Store,
    private readonly translator: Translator,
    private readonly transport: Transport,
    contacts: Contact[],
  ) {
    this.setContacts(contacts);
  }

  setContacts(contacts: Contact[]): void {
    const ids = new Set<string>();
    for (const contact of contacts) {
      if (!isIndividualContactId(contact.id) || ids.has(contact.id)) {
        throw new ServiceError('invalid_contact', 'Contacts must have unique individual WhatsApp IDs.');
      }
      ids.add(contact.id);
    }
    this.contacts = ids;
  }

  list(): Message[] {
    return this.store.list();
  }

  async send(request: SendRequest): Promise<Message> {
    if (!this.contacts.has(request.contactId)) {
      throw new ServiceError('unknown_contact', 'The selected contact is not allowed.');
    }
    validateText(request.text, 4000, 'Text');
    validateText(request.idempotencyKey, 128, 'Idempotency key');

    // Reserve the key synchronously before any asynchronous work.
    const { message, inserted } = this.store.insertOutgoing(
      request.contactId, request.text, request.idempotencyKey,
    );
    if (!inserted) return message;

    const translated = await this.translate(message, 'ru-sr');
    if (translated.status === 'failed') return translated;

    // Persist intent before transport invocation. An interruption now is uncertain.
    const sending = this.store.setState(message.id, 'sending', { remoteId: '3EB0' + randomBytes(16).toString('hex').toUpperCase() });
    try {
      const receipt = await this.transport.send(sending.contactId, sending.translatedText!, sending.remoteId!);
      const confirmed = this.store.get(message.id)!;
      if (['sent', 'delivered', 'read'].includes(confirmed.status)) return confirmed;
      if (!receipt || typeof receipt.messageId !== 'string' || receipt.messageId.trim() === '') {
        return this.store.setState(message.id, 'unknown', { errorCode: 'uncertain_delivery' });
      }
      // 'sent' only means the transport accepted it; it does not mean delivered/read.
      return this.store.setState(message.id, 'sent', { remoteId: receipt.messageId });
    } catch (error) {
      const confirmed = this.store.get(message.id)!;
      if (['sent', 'delivered', 'read'].includes(confirmed.status)) return confirmed;
      if (error instanceof ServiceError && error.code === 'WHATSAPP_NOT_CONNECTED') {
        return this.store.setState(message.id, 'failed', { errorCode: 'whatsapp_disconnected' });
      }
      // Never resend automatically: WhatsApp may have accepted the message already.
      return this.store.setState(message.id, 'unknown', { errorCode: 'uncertain_delivery' });
    }
  }

  async retryIncoming(id: string): Promise<Message> {
    const message = this.store.get(id);
    if (!message || message.direction !== 'incoming' || message.status !== 'failed' || !this.contacts.has(message.contactId)) {
      throw new ServiceError('retry_not_allowed', 'Only a failed incoming translation can be retried.');
    }
    const reserved = this.store.setState(id, 'translating', { errorCode: null });
    const translated = await this.translate(reserved, 'sr-ru');
    return translated.status === 'failed' ? translated : this.store.setState(id, 'received');
  }

  async receive(event: IncomingMessage): Promise<Message | null> {
    if (event.fromMe || event.isHistory || !this.contacts.has(event.contactId)) return null;
    validateText(event.text, 4000, 'Text');
    validateText(event.id, 256, 'Remote message ID');
    const { message, inserted } = this.store.insertIncoming(event.contactId, event.text, event.id);
    if (!inserted) return message;
    const translated = await this.translate(message, 'sr-ru');
    if (translated.status === 'failed') return translated;
    return this.store.setState(message.id, 'received');
  }

  private async translate(message: Message, direction: TranslationDirection): Promise<Message> {
    let text: string;
    try {
      text = await this.translator.translate(message.originalText, direction);
    } catch {
      // Provider error text may contain credentials or private content; don't persist it.
      return this.store.setState(message.id, 'failed', { errorCode: 'translation_failed' });
    }
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 8000) {
      return this.store.setState(message.id, 'failed', { errorCode: 'invalid_translation' });
    }
    return this.store.setState(message.id, 'translating', { translatedText: text });
  }
}
