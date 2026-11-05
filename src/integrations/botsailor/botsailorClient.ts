import { config } from '../../config/environment.ts';
import { logger } from '../../utils/logger.ts';
import type { BotSailorButton, BotSailorListSection } from './types.ts';

function cleanPhoneNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

export class BotSailorClient {
  private baseUrl: string;
  private apiKey: string;
  private botId: string;

  constructor() {
    this.baseUrl = config.BOTSAILOR_BASE_URL.replace(/\/$/, '');
    this.apiKey = config.BOTSAILOR_API_KEY;
    this.botId = config.BOTSAILOR_WHATSAPP_BOT_ID;
  }

  private async postRequest(endpoint: string, body: Record<string, any>): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      if (!config.isLiveBotSailor) {
        logger.info(`[MOCK BOTSAILOR] -> ${endpoint}:`, JSON.stringify(body, null, 2));
        return { status: 'success', mock: true };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => null);
      logger.info(`BotSailor API [${endpoint}] Response:`, {
        httpStatus: res.status,
        data,
      });
      return data;
    } catch (err: any) {
      logger.error(`BotSailor API [${endpoint}] Fetch Exception:`, err.message);
      return null;
    }
  }

  async sendTextMessage(phoneNumber: string, text: string): Promise<boolean> {
    const cleaned = cleanPhoneNumber(phoneNumber);
    logger.info('Dispatching WhatsApp Text Message via BotSailor:', {
      phoneNumber: cleaned,
      textPreview: text.substring(0, 60),
    });

    const res = await this.postRequest('/whatsapp/send', {
      apiToken: this.apiKey,
      api_key: this.apiKey,
      phone_number_id: this.botId,
      bot_id: this.botId,
      phone_number: cleaned,
      message: text,
    });

    return !!(res?.status === '1' || res?.status === 1 || res?.status === 'success' || res?.mock);
  }

  async sendMediaMessage(
    phoneNumber: string,
    mediaUrl: string,
    mediaType: 'image' | 'video' | 'audio' | 'document' = 'image',
    caption?: string
  ): Promise<boolean> {
    const cleaned = cleanPhoneNumber(phoneNumber);
    logger.info('Dispatching WhatsApp Media Message via BotSailor:', {
      phoneNumber: cleaned,
      mediaType,
      mediaUrl,
      captionPreview: caption ? caption.substring(0, 60) : undefined,
    });

    const res = await this.postRequest('/whatsapp/send', {
      apiToken: this.apiKey,
      api_key: this.apiKey,
      phone_number_id: this.botId,
      bot_id: this.botId,
      phone_number: cleaned,
      media_url: mediaUrl,
      media_type: mediaType,
      message: caption || '',
      caption: caption || '',
    });

    return !!(res?.status === '1' || res?.status === 1 || res?.status === 'success' || res?.mock);
  }

  async sendQuickReplyButtons(
    phoneNumber: string,
    bodyText: string,
    buttons: BotSailorButton[],
    headerText?: string,
    footerText?: string
  ): Promise<boolean> {
    const cleaned = cleanPhoneNumber(phoneNumber);
    logger.info('Dispatching WhatsApp Interactive Buttons via BotSailor:', {
      phoneNumber: cleaned,
      buttonCount: buttons.length,
    });

    const formattedButtons = buttons.slice(0, 3).map((b, idx) => ({
      id: b.payload || `btn_${idx}`,
      title: (b.text || '').substring(0, 20),
    }));

    const res = await this.postRequest('/whatsapp/send/interactive-buttons', {
      apiToken: this.apiKey,
      api_key: this.apiKey,
      phone_number_id: this.botId,
      bot_id: this.botId,
      phone_number: cleaned,
      header_text: headerText || '',
      message: bodyText,
      body_text: bodyText,
      footer_text: footerText || config.STORE_NAME,
      buttons: formattedButtons,
    });

    if (res?.status === '1' || res?.status === 1 || res?.mock) {
      return true;
    }

    // Fallback: format buttons cleanly as numbered text
    const buttonHints = buttons.map((b, i) => `${i + 1}️⃣ *${b.text}*`).join('\n');
    return this.sendTextMessage(cleaned, `${bodyText}\n\n${buttonHints}`);
  }

  async sendInteractiveList(
    phoneNumber: string,
    bodyText: string,
    buttonText: string,
    sections: BotSailorListSection[],
    headerText?: string,
    footerText?: string
  ): Promise<boolean> {
    const cleaned = cleanPhoneNumber(phoneNumber);
    logger.info('Dispatching WhatsApp Interactive List via BotSailor:', {
      phoneNumber: cleaned,
      sectionCount: sections.length,
    });

    const res = await this.postRequest('/whatsapp_send_interactive_list', {
      api_key: this.apiKey,
      bot_id: this.botId,
      phone_number: cleaned,
      header_text: headerText || '',
      body_text: bodyText,
      button_text: buttonText,
      footer_text: footerText || config.STORE_NAME,
      sections,
    });

    return !!res;
  }
}

export const botsailorClient = new BotSailorClient();
