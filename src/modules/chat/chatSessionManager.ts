import type { ChatSession, ConversationState, Product, ProductVariant, PaymentMethod } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

// In-Memory Session Store with auto-cleanup
class ChatSessionManager {
  private sessions = new Map<string, ChatSession>();
  private humanTakeovers = new Map<string, number>(); // cleanPhone -> expiry timestamp
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours Session Window
  private readonly INACTIVITY_RESET_MS = 30 * 60 * 1000; // 30 Minutes Inactivity Reset
  private readonly DEFAULT_TAKEOVER_MS = 24 * 60 * 60 * 1000; // 24 Hours Human Takeover Mute Window

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
    } else if (session.state !== 'IDLE' && session.state !== 'HANDED_OVER_TO_SUPPORT' && now - session.updatedAt > this.INACTIVITY_RESET_MS) {
      // Inactivity timeout: reset state back to IDLE so casual chats aren't captured as order responses
      logger.info(`Session for ${cleanPhone} timed out after 30 mins. Resetting to IDLE.`);
      session.state = 'IDLE';
      session.context = { lastActiveTime: now };
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

  setSelectedQuantity(phoneNumber: string, quantity: number): void {
    const session = this.getSession(phoneNumber);
    session.context.selectedQuantity = Math.max(1, quantity);
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

  /**
   * LAYER 2: Activate Human Takeover mode for a customer phone number.
   * Suppresses automated chatbot replies for durationMs (default: 24 hours)
   * and immediately resets any pending checkout/variant/quantity questionnaire back to IDLE.
   */
  activateHumanTakeover(phoneNumber: string, durationMs: number = this.DEFAULT_TAKEOVER_MS): void {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const until = Date.now() + durationMs;
    this.humanTakeovers.set(cleanPhone, until);

    // Immediately reset any active questionnaire, cart, or state back to IDLE with 0 invalid attempt strikes
    const session = this.getSession(cleanPhone);
    session.state = 'IDLE';
    session.context = {
      lastActiveTime: Date.now(),
    };
    session.updatedAt = Date.now();

    logger.info(`[HUMAN TAKEOVER] Activated for ${cleanPhone} until ${new Date(until).toISOString()}. Customer session reset to IDLE.`);
  }

  /**
   * LAYER 2: Checks if Human Takeover mode is currently active for this customer phone.
   */
  isHumanTakeoverActive(phoneNumber: string): boolean {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const expiry = this.humanTakeovers.get(cleanPhone);
    if (!expiry) return false;

    if (Date.now() > expiry) {
      this.humanTakeovers.delete(cleanPhone);
      return false;
    }
    return true;
  }

  /**
   * LAYER 2: Clears Human Takeover mode (when customer types "menu"/"start" or via Admin API).
   */
  clearHumanTakeover(phoneNumber: string): void {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    this.humanTakeovers.delete(cleanPhone);
    logger.info(`[HUMAN TAKEOVER] Cleared for ${cleanPhone}. Bot is now responsive again.`);
  }

  /**
   * Returns expiry timestamp in ms or null if inactive.
   */
  getHumanTakeoverUntil(phoneNumber: string): number | null {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const expiry = this.humanTakeovers.get(cleanPhone);
    if (!expiry || Date.now() > expiry) return null;
    return expiry;
  }

  /**
   * Returns list of currently active human takeovers for admin inspection
   */
  getActiveHumanTakeovers(): Array<{ phoneNumber: string; expiresAt: string; remainingMinutes: number }> {
    const now = Date.now();
    const active: Array<{ phoneNumber: string; expiresAt: string; remainingMinutes: number }> = [];
    for (const [phone, expiry] of this.humanTakeovers.entries()) {
      if (expiry > now) {
        active.push({
          phoneNumber: phone,
          expiresAt: new Date(expiry).toISOString(),
          remainingMinutes: Math.round((expiry - now) / 60000),
        });
      } else {
        this.humanTakeovers.delete(phone);
      }
    }
    return active;
  }

  /**
   * Resets all human takeovers (used during testing or emergency unpause all)
   */
  resetAllHumanTakeovers(): void {
    this.humanTakeovers.clear();
  }
}

export const chatSessionManager = new ChatSessionManager();
