import { db } from '../../database/supabaseClient.ts';
import { botsailorClient } from '../../integrations/botsailor/botsailorClient.ts';
import { chatSessionManager } from '../chat/chatSessionManager.ts';
import { logger } from '../../utils/logger.ts';
import type { CustomerLead, Product, ProductVariant } from '../../database/types.ts';

class FollowupService {
  private leads = new Map<string, CustomerLead>();
  private initialized = false;

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const settings = await db.getStoreSettings();
      const savedLeads: CustomerLead[] = settings.customer_leads || [];
      savedLeads.forEach((l) => this.leads.set(l.phoneNumber, l));
      this.initialized = true;
      logger.info(`FollowupService initialized with ${this.leads.size} leads from storage.`);
    } catch (err: any) {
      logger.error('Failed to load leads from database:', err.message);
      this.initialized = true;
    }
  }

  private async persistLeads(): Promise<void> {
    try {
      const leadsArray = Array.from(this.leads.values()).slice(-500); // keep recent 500 leads
      await db.updateStoreSettings({ customer_leads: leadsArray });
    } catch (err: any) {
      logger.error('Failed to persist leads to database:', err.message);
    }
  }

  async recordLead(params: {
    phoneNumber: string;
    product: Product;
    variant?: ProductVariant;
    quantity?: number;
    userName?: string;
  }): Promise<void> {
    await this.ensureInitialized();
    const cleanPhone = params.phoneNumber.replace(/\D/g, '');
    const existing = this.leads.get(cleanPhone);

    // If customer already purchased in this active session, don't revert to pending
    if (existing && existing.status === 'PURCHASED' && Date.now() - existing.lastInteractionAt < 2 * 60 * 60 * 1000) {
      return;
    }

    const variantDesc = params.variant
      ? [params.variant.color, params.variant.size].filter(Boolean).join(' - ')
      : undefined;

    const lead: CustomerLead = {
      phoneNumber: cleanPhone,
      userName: params.userName || existing?.userName,
      productId: params.product.id,
      productName: params.product.name,
      variantId: params.variant?.id,
      variantDesc: variantDesc || existing?.variantDesc,
      quantity: params.quantity || existing?.quantity || 1,
      lastInteractionAt: Date.now(),
      followupCount: 0,
      status: 'PENDING_ADDRESS',
      lastFollowupAt: undefined,
    };

    this.leads.set(cleanPhone, lead);
    await this.persistLeads();
    logger.info(`Lead recorded for ${cleanPhone}: ${params.product.name} (Status: PENDING_ADDRESS)`);
  }

  async markPurchased(phoneNumber: string): Promise<void> {
    await this.ensureInitialized();
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const lead = this.leads.get(cleanPhone);
    if (lead) {
      lead.status = 'PURCHASED';
      lead.lastInteractionAt = Date.now();
      await this.persistLeads();
      logger.info(`Lead marked as PURCHASED for ${cleanPhone} (Follow-ups stopped)`);
    }
  }

  async optOut(phoneNumber: string): Promise<void> {
    await this.ensureInitialized();
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const lead = this.leads.get(cleanPhone);
    if (lead) {
      lead.status = 'OPTED_OUT';
      lead.lastInteractionAt = Date.now();
      await this.persistLeads();
      logger.info(`Lead opted out of follow-ups: ${cleanPhone}`);
    }
  }

  async getLead(phoneNumber: string): Promise<CustomerLead | undefined> {
    await this.ensureInitialized();
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    return this.leads.get(cleanPhone);
  }

  async getAllLeads(): Promise<CustomerLead[]> {
    await this.ensureInitialized();
    return Array.from(this.leads.values()).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);
  }

  async getStats(): Promise<{ total: number; pending: number; purchased: number; optedOut: number }> {
    await this.ensureInitialized();
    const all = Array.from(this.leads.values());
    return {
      total: all.length,
      pending: all.filter((l) => l.status === 'PENDING_ADDRESS').length,
      purchased: all.filter((l) => l.status === 'PURCHASED').length,
      optedOut: all.filter((l) => l.status === 'OPTED_OUT' || l.status === 'EXPIRED').length,
    };
  }

  /**
   * Process and dispatch due automated follow-ups
   * Interval 1: 30 minutes after last interaction
   * Interval 2: 2 hours after last interaction
   */
  async processDueFollowups(): Promise<{ sent: number; skipped: number }> {
    await this.ensureInitialized();
    const settings = await db.getStoreSettings();

    // Respect master bot killswitch
    if (settings.is_bot_active === false) {
      logger.info('FollowupService: Bot is currently PAUSED. Skipping follow-ups.');
      return { sent: 0, skipped: 0 };
    }

    const now = Date.now();
    const FIRST_FOLLOWUP_DELAY = 30 * 60 * 1000; // 30 minutes
    const SECOND_FOLLOWUP_DELAY = 2 * 60 * 60 * 1000; // 2 hours

    let sent = 0;
    let skipped = 0;

    for (const lead of this.leads.values()) {
      if (lead.status !== 'PENDING_ADDRESS') {
        continue;
      }

      // Respect Layer 2 Human Takeover: Never dispatch automated follow-ups if human agent is conversing
      if (chatSessionManager.isHumanTakeoverActive(lead.phoneNumber)) {
        logger.info(`FollowupService: Customer ${lead.phoneNumber} is in active human takeover. Skipping follow-up.`);
        skipped++;
        continue;
      }

      const timeSinceActivity = now - lead.lastInteractionAt;

      // 1. First Follow-up
      if (lead.followupCount === 0 && timeSinceActivity >= FIRST_FOLLOWUP_DELAY) {
        const msg = `Hi there 👋 We noticed you checked out the *${lead.productName}*.\n\nAre you still interested in having it delivered? Reply *YES* to proceed or feel free to ask any questions! 😊`;
        try {
          await botsailorClient.sendTextMessage(lead.phoneNumber, msg);
          lead.followupCount = 1;
          lead.lastFollowupAt = now;
          sent++;
          logger.info(`Follow-up 1 dispatched to ${lead.phoneNumber} for ${lead.productName}`);
        } catch (err: any) {
          logger.error(`Failed to send follow-up 1 to ${lead.phoneNumber}:`, err.message);
        }
      }
      // 2. Second Follow-up (Objection Handling + Group Invite)
      else if (lead.followupCount === 1 && timeSinceActivity >= SECOND_FOLLOWUP_DELAY) {
        let msg = `Hello! 😊 Quick check on the *${lead.productName}* — we have limited stock available this week.\n\n`;
        msg += `👉 Reply *1* to Order\n`;
        if (settings.whatsapp_group_link) {
          msg += `👉 Reply *2* to Join our VIP Group for daily new items\n`;
        }
        msg += `👉 Or reply *NO* if you're not interested.`;

        try {
          await botsailorClient.sendTextMessage(lead.phoneNumber, msg);
          lead.followupCount = 2;
          lead.lastFollowupAt = now;
          sent++;
          logger.info(`Follow-up 2 dispatched to ${lead.phoneNumber} for ${lead.productName}`);
        } catch (err: any) {
          logger.error(`Failed to send follow-up 2 to ${lead.phoneNumber}:`, err.message);
        }
      }
      // 3. Expire after 2 follow-ups
      else if (lead.followupCount >= 2 && timeSinceActivity >= 24 * 60 * 60 * 1000) {
        lead.status = 'EXPIRED';
        skipped++;
      } else {
        skipped++;
      }
    }

    if (sent > 0) {
      await this.persistLeads();
    }

    return { sent, skipped };
  }
}

export const followupService = new FollowupService();
