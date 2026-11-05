import type { ChatSession, ConversationState, Product, ProductVariant, PaymentMethod } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

// In-Memory Session Store with auto-cleanup
class ChatSessionManager {
  private sessions = new Map<string, ChatSession>();
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours Session Window

  getSession(phoneNumber: string): ChatSession {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const now = Date.now();
    let session = this.sessions.get(cleanPhone);

    if (!session || now - session.updatedAt > this.TTL_MS) {
      session = {
        phoneNumber: cleanPhone,
        state: 'IDLE',
        context: {
          lastActiveTime: now,
        },
        updatedAt: now,
      };
      this.sessions.set(cleanPhone, session);
    }

    session.updatedAt = now;
    session.context.lastActiveTime = now;
    return session;
  }

  setState(phoneNumber: string, state: ConversationState): void {
    const session = this.getSession(phoneNumber);
    session.state = state;
    session.updatedAt = Date.now();
  }

  setCurrentProduct(phoneNumber: string, product: Product): void {
    const session = this.getSession(phoneNumber);
    session.context.currentProductId = product.id;
    session.context.currentProduct = product;
    session.context.selectedVariantId = undefined;
    session.context.selectedVariant = undefined;
    session.updatedAt = Date.now();
  }

  setSelectedVariant(phoneNumber: string, variant: ProductVariant): void {
    const session = this.getSession(phoneNumber);
    session.context.selectedVariantId = variant.id;
    session.context.selectedVariant = variant;
    session.updatedAt = Date.now();
  }

  setSelectedPaymentMethod(phoneNumber: string, method: PaymentMethod): void {
    const session = this.getSession(phoneNumber);
    session.context.selectedPaymentMethod = method;
    session.updatedAt = Date.now();
  }

  setPendingOrderNumber(phoneNumber: string, orderNumber: string): void {
    const session = this.getSession(phoneNumber);
    session.context.pendingOrderNumber = orderNumber;
    session.updatedAt = Date.now();
  }

  resetSession(phoneNumber: string): void {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    this.sessions.delete(cleanPhone);
    logger.info(`Session reset for phone: ${cleanPhone}`);
  }

  handoverToSupport(phoneNumber: string): void {
    const session = this.getSession(phoneNumber);
    session.state = 'HANDED_OVER_TO_SUPPORT';
    session.updatedAt = Date.now();
  }

  isHandedOverToSupport(phoneNumber: string): boolean {
    const session = this.getSession(phoneNumber);
    return session.state === 'HANDED_OVER_TO_SUPPORT';
  }
}

export const chatSessionManager = new ChatSessionManager();
