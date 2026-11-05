import { botsailorClient } from '../../integrations/botsailor/botsailorClient.ts';
import { chatSessionManager } from './chatSessionManager.ts';
import { catalogService } from '../catalog/catalogService.ts';
import { orderService } from '../orders/orderService.ts';
import { db } from '../../database/supabaseClient.ts';
import { config } from '../../config/environment.ts';
import { logger } from '../../utils/logger.ts';
import type { PaymentMethod } from '../../database/types.ts';

export class ChatFlowEngine {
  async processInboundMessage(params: {
    phoneNumber: string;
    text?: string;
    mediaUrl?: string;
    mediaType?: 'image' | 'video' | 'document';
    userName?: string;
  }): Promise<void> {
    const { phoneNumber, text = '', mediaUrl, mediaType = 'image' } = params;
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();

    logger.info(`Processing message from ${cleanPhone}: "${cleanText}" (Media: ${mediaUrl ? 'Yes' : 'No'})`);

    const settings = await db.getStoreSettings();

    // 0. MASTER KILLSWITCH: If bot is turned OFF, stay 100% silent!
    if (settings.is_bot_active === false) {
      logger.info(`[KILLSWITCH ACTIVE] Bot is currently PAUSED. Silently ignoring message from ${cleanPhone}.`);
      return;
    }

    const session = chatSessionManager.getSession(cleanPhone);

    // 1. Check for Admin /add WhatsApp Command
    if (lowerText.startsWith('/add')) {
      const isAdmin = config.adminPhoneList.includes(cleanPhone) || config.adminPhoneList.includes('2348000000000');
      if (isAdmin) {
        await this.handleAdminAddProduct(cleanPhone, cleanText, mediaUrl);
        return;
      }
    }

    // 2. Check for Live Human Support Trigger
    if (
      ['agent', 'support', 'human', 'help', 'representative', 'talk to agent', 'talk to support', 'customer care'].some((k) =>
        lowerText.includes(k)
      ) ||
      (session.state === 'CHOOSING_PAYMENT_METHOD' && lowerText === '3')
    ) {
      chatSessionManager.handoverToSupport(cleanPhone);
      await botsailorClient.sendTextMessage(
        cleanPhone,
        `👩‍💼 *Live Customer Support Assigned*\n\nA representative has been notified and will assist you here shortly.\n\n_(Type *MENU* anytime to resume automated shopping)._`
      );
      await this.notifySupportTeam(cleanPhone, session);
      return;
    }

    // 3. Human Support Handover Protection:
    // If user is currently handed over to human support, don't interfere unless they explicitly type MENU/RESTART
    if (session.state === 'HANDED_OVER_TO_SUPPORT') {
      if (['menu', 'catalog', 'start', 'restart', 'reset'].includes(lowerText)) {
        chatSessionManager.resetSession(cleanPhone);
        await this.sendWelcomeMenu(cleanPhone);
        return;
      }
      logger.info(`User ${cleanPhone} is in human support mode. Ignoring message to let human staff converse.`);
      return;
    }

    // 4. Check for Explicit Reset / Menu Commands
    if (['menu', 'catalog', 'shop', 'store', 'products', 'all products', 'start', 'restart', 'reset'].includes(lowerText)) {
      chatSessionManager.resetSession(cleanPhone);
      await this.sendWelcomeMenu(cleanPhone);
      return;
    }

    // 5. Handling Payment Receipt Upload
    if (
      session.state === 'AWAITING_PAYMENT_RECEIPT' ||
      (mediaUrl && (lowerText.includes('paid') || lowerText.includes('receipt') || lowerText.includes('transfer')))
    ) {
      if (mediaUrl || lowerText.includes('paid') || lowerText.includes('done')) {
        if (session.context.pendingOrderNumber && mediaUrl) {
          await db.attachReceiptUrl(session.context.pendingOrderNumber, mediaUrl);
        }
        await botsailorClient.sendTextMessage(
          cleanPhone,
          `✅ *Payment Proof Received!*\n\nThank you for providing your receipt. Our accounts team will verify your transfer and your order will be dispatched promptly! 🚚✨\n\nOrder Ref: *${
            session.context.pendingOrderNumber || 'Pending'
          }*`
        );
        chatSessionManager.setState(cleanPhone, 'IDLE');
        return;
      }
    }

    // 6. State Machine Routing for Active Conversations
    switch (session.state) {
      case 'SELECTING_VARIANT':
        await this.handleVariantSelection(cleanPhone, cleanText, session);
        return;

      case 'CHOOSING_PAYMENT_METHOD':
        await this.handlePaymentMethodChoice(cleanPhone, cleanText, session);
        return;

      case 'AWAITING_DELIVERY_DETAILS':
        await this.handleDeliveryDetailsSubmission(cleanPhone, cleanText, session);
        return;

      case 'IDLE':
      case 'BROWSING_PRODUCTS':
      default:
        // Smart Idle Handling: Only responds to product matches or explicit shopping intent!
        await this.handleIdleMessage(cleanPhone, cleanText, lowerText, settings);
        return;
    }
  }

  /**
   * Smart Idle Message Handler:
   * 1. Searches catalog for product match (e.g. from Meta Ads or organic search).
   * 2. If matched -> presents product and variants.
   * 3. If no match BUT user used shopping keywords (e.g. "buy", "price", "order", "cost") -> polite guidance.
   * 4. If no match AND no shopping intent (casual chats like "where are you", "ok", "good morning") -> 100% SILENT.
   */
  async handleIdleMessage(
    phoneNumber: string,
    cleanText: string,
    lowerText: string,
    settings: Record<string, any>
  ): Promise<void> {
    if (!cleanText || cleanText.length < 2) {
      logger.info(`Ignoring short idle message from ${phoneNumber}: "${cleanText}"`);
      return;
    }

    // Attempt catalog search
    const results = await catalogService.search(cleanText);

    if (results.length > 0) {
      // 1. Direct Product Match Found!
      const topProduct = results[0];
      chatSessionManager.setCurrentProduct(phoneNumber, topProduct);

      const formatted = catalogService.formatProductMessage(topProduct);
      if (formatted.mediaUrl) {
        await botsailorClient.sendMediaMessage(phoneNumber, formatted.mediaUrl, formatted.mediaType, formatted.text);
      } else {
        await botsailorClient.sendTextMessage(phoneNumber, formatted.text);
      }

      const variants = topProduct.variants || [];
      if (variants.length > 0) {
        chatSessionManager.setState(phoneNumber, 'SELECTING_VARIANT');
        if (variants.length <= 3) {
          const buttons = variants.map((v, idx) => {
            const label = [v.color, v.size].filter(Boolean).join(' ') || `Option ${idx + 1}`;
            return {
              text: label.substring(0, 20),
              payload: String(idx + 1),
            };
          });
          await botsailorClient.sendQuickReplyButtons(phoneNumber, `🎨 *Tap your preferred option below:*`, buttons);
        }
      } else {
        chatSessionManager.setState(phoneNumber, 'CHOOSING_PAYMENT_METHOD');
        await this.promptPaymentMethod(phoneNumber, topProduct.name, topProduct.base_price);
      }
      return;
    }

    // 2. No Product Found: Check for Shopping Intent Keywords
    const shoppingIntentKeywords = [
      'order', 'buy', 'price', 'cost', 'how much', 'do you have', 'stock',
      'deliver', 'delivery', 'sell', 'discount', 'purchase', 'shipping',
      'available', 'pay on delivery', 'payment', 'transfer', 'wholesale', 'catalog', 'item'
    ];
    const hasShoppingIntent = shoppingIntentKeywords.some((k) => lowerText.includes(k));

    if (hasShoppingIntent) {
      // User is genuinely trying to buy/inquire about something not in catalog
      let msg = `😕 Sorry, we couldn't find an exact match for *"${cleanText}"* in our current catalog.\n\n`;
      msg += `📂 *Browse our categories:*\n`;
      msg += `1️⃣ *Kitchen Wares*\n`;
      msg += `2️⃣ *Agricultural Tools*\n`;
      msg += `3️⃣ *Home & Cleaning*\n\n`;
      msg += `👉 Type *CATALOG* to see all items.\n`;
      msg += `👉 Type *SUPPORT* to ask our sales representative.`;

      if (settings.whatsapp_group_link) {
        msg += `\n\n📲 *Join our VIP WhatsApp Group for daily stock:*\n${settings.whatsapp_group_link}`;
      }

      await botsailorClient.sendTextMessage(phoneNumber, msg);
      return;
    }

    // 3. Casual / Unrelated Message (Friends, family, personal contacts):
    // DO NOT RESPOND! Stay 100% silent so human conversations are completely untouched!
    logger.info(`[ANTI-INTERFERENCE] Ignoring casual non-store message from ${phoneNumber}: "${cleanText}"`);
  }

  /**
   * Welcome Menu & Introduction
   */
  async sendWelcomeMenu(phoneNumber: string): Promise<void> {
    const [categories, settings] = await Promise.all([catalogService.getCategories(), db.getStoreSettings()]);
    let msg = `👋 *Welcome to ${settings.store_name || config.STORE_NAME}!* 🛍️\n\n`;
    msg += `We deliver high-quality products directly to your doorstep across Nigeria.\n\n`;
    msg += `📂 *POPULAR CATEGORIES:*\n`;

    categories.forEach((cat) => {
      msg += `• ${cat.icon_emoji || '📦'} *${cat.name}*\n`;
    });

    msg += `\n🔍 *How to order:* Simply type what you are looking for!\n`;
    msg += `_Examples:_ \n`;
    msg += `👉 *"Wooden Chopping Board"*\n`;
    msg += `👉 *"Knapsack Sprayer"*\n`;
    msg += `👉 *"Spin Mop"*\n\n`;
    msg += `_Or type *SUPPORT* to speak with our team._`;

    if (settings.whatsapp_group_link) {
      msg += `\n\n📲 *Join our VIP WhatsApp Catalog Group:*\n${settings.whatsapp_group_link}\n_(New arrivals & wholesale prices posted daily!)_`;
    }

    await botsailorClient.sendTextMessage(phoneNumber, msg);
  }

  /**
   * Search Products & Present Top Match with Variants (delegates to smart handler)
   */
  async handleProductSearch(phoneNumber: string, query: string): Promise<void> {
    const settings = await db.getStoreSettings();
    await this.handleIdleMessage(phoneNumber, query, query.toLowerCase(), settings);
  }

  /**
   * Handle Variant Selection (Supports button taps, option numbers, or variant names)
   */
  async handleVariantSelection(phoneNumber: string, text: string, session: any): Promise<void> {
    const product = session.context.currentProduct;
    if (!product || !product.variants || product.variants.length === 0) {
      await this.handleProductSearch(phoneNumber, text);
      return;
    }

    const cleanLower = text.trim().toLowerCase();
    const choiceIdx = parseInt(text.replace(/\D/g, ''), 10) - 1;
    const variants = product.variants;

    let selectedVariant = (!isNaN(choiceIdx) && choiceIdx >= 0 && choiceIdx < variants.length)
      ? variants[choiceIdx]
      : undefined;

    // If not a number index, check if user tapped a button or typed a color/size
    if (!selectedVariant) {
      selectedVariant = variants.find((v: any) => {
        const colorMatch = v.color && cleanLower.includes(v.color.toLowerCase());
        const sizeMatch = v.size && cleanLower.includes(v.size.toLowerCase());
        return colorMatch || sizeMatch;
      });
    }

    if (!selectedVariant) {
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please reply with a valid option number between *1* and *${variants.length}*, or tap an option button.`
      );
      return;
    }

    chatSessionManager.setSelectedVariant(phoneNumber, selectedVariant);
    chatSessionManager.setState(phoneNumber, 'CHOOSING_PAYMENT_METHOD');

    const formattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(selectedVariant.price);
    const variantDesc = [selectedVariant.color, selectedVariant.size].filter(Boolean).join(' | ');

    let msg = `✅ *Option Selected:*\n`;
    msg += `🛍️ *${product.name}*\n`;
    msg += `🎨 *Variant:* ${variantDesc}\n`;
    msg += `💰 *Price:* ${formattedPrice}\n\n`;

    await botsailorClient.sendTextMessage(phoneNumber, msg);
    await this.promptPaymentMethod(phoneNumber, product.name, selectedVariant.price, variantDesc);
  }

  /**
   * Prompt Payment Method using Interactive WhatsApp Quick-Reply Buttons!
   */
  async promptPaymentMethod(phoneNumber: string, productName: string, price: number, variantText?: string): Promise<void> {
    const formattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(price);

    const bodyText = `💳 *HOW WOULD YOU LIKE TO PAY?*\n\n🛍️ *Item:* ${productName} ${variantText ? `(${variantText})` : ''}\n💰 *Total:* ${formattedPrice}\n\nTap your preferred checkout option below:`;

    await botsailorClient.sendQuickReplyButtons(
      phoneNumber,
      bodyText,
      [
        { text: '🚚 Pay on Delivery', payload: '1' },
        { text: '🏦 Bank Transfer', payload: '2' },
        { text: '💬 Talk to Support', payload: '3' },
      ],
      'Payment Selection'
    );
  }

  /**
   * Handle Payment Method Choice
   */
  async handlePaymentMethodChoice(phoneNumber: string, text: string, session: any): Promise<void> {
    const clean = text.trim().toLowerCase();
    let method: PaymentMethod | null = null;

    if (clean === '1' || clean.includes('delivery') || clean.includes('pod')) {
      method = 'POD';
    } else if (clean === '2' || clean.includes('transfer') || clean.includes('bank') || clean.includes('pay now')) {
      method = 'BANK_TRANSFER';
    } else if (clean === '3' || clean.includes('support')) {
      chatSessionManager.handoverToSupport(phoneNumber);
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `👩‍💼 A customer support agent will join this chat shortly to assist you.`
      );
      return;
    }

    if (!method) {
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please reply with:\n*1* for Pay on Delivery\n*2* for Bank Transfer\n*3* for Human Support`
      );
      return;
    }

    chatSessionManager.setSelectedPaymentMethod(phoneNumber, method);
    chatSessionManager.setState(phoneNumber, 'AWAITING_DELIVERY_DETAILS');

    const variant = session.context.selectedVariant;
    const product = session.context.currentProduct;
    const price = variant ? variant.price : product?.base_price || 0;
    const formattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(price);

    let msg = '';
    if (method === 'BANK_TRANSFER') {
      msg += `🏦 *OFFICIAL COMPANY BANK DETAILS:*\n\n`;
      msg += `• *Bank Name:* ${config.BANK_NAME}\n`;
      msg += `• *Account Number:* ${config.BANK_ACCOUNT_NUMBER}\n`;
      msg += `• *Account Name:* ${config.BANK_ACCOUNT_NAME}\n`;
      msg += `• *Amount to Transfer:* ${formattedPrice}\n\n`;
      msg += `📌 _Please make the transfer and send your receipt screenshot here!_\n\n`;
    } else {
      msg += `🚚 *PAY ON DELIVERY SELECTED!*\n\n`;
      msg += `You will pay *${formattedPrice}* when our dispatch rider delivers to your doorstep.\n\n`;
    }

    msg += `📝 *PLEASE PROVIDE YOUR DELIVERY DETAILS:*\n`;
    msg += `Reply to this chat with your details in this format:\n\n`;
    msg += `• *Full Name:*\n`;
    msg += `• *Phone Number:*\n`;
    msg += `• *Delivery Address & City/State:*\n\n`;
    msg += `_(You can send it all in one message!)_`;

    await botsailorClient.sendTextMessage(phoneNumber, msg);
  }

  /**
   * Handle Delivery Details Submission & Order Creation
   */
  async handleDeliveryDetailsSubmission(phoneNumber: string, text: string, session: any): Promise<void> {
    const product = session.context.currentProduct;
    const variant = session.context.selectedVariant;
    const method = session.context.selectedPaymentMethod || 'POD';

    if (!product) {
      chatSessionManager.resetSession(phoneNumber);
      await this.sendWelcomeMenu(phoneNumber);
      return;
    }

    const parsed = orderService.parseAddressMessage(text, phoneNumber);

    if (!parsed.address || parsed.address.length < 5) {
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please include your complete delivery address (Street name, Area, City/State) so our dispatch rider can locate you easily.`
      );
      return;
    }

    const unitPrice = variant ? variant.price : product.base_price;
    const orderItem = {
      product_id: product.id,
      product_name: product.name,
      variant_id: variant?.id,
      size: variant?.size,
      color: variant?.color,
      unit_price: unitPrice,
      quantity: 1,
      subtotal: unitPrice,
    };

    const order = await orderService.createCustomerOrder({
      customerName: parsed.name,
      customerPhone: parsed.phone,
      deliveryAddress: parsed.address,
      items: [orderItem],
      paymentMethod: method,
    });

    chatSessionManager.setPendingOrderNumber(phoneNumber, order.order_number);

    if (method === 'BANK_TRANSFER') {
      chatSessionManager.setState(phoneNumber, 'AWAITING_PAYMENT_RECEIPT');
    } else {
      chatSessionManager.setState(phoneNumber, 'IDLE');
    }

    const settings = await db.getStoreSettings();
    const confirmationMsg = orderService.formatOrderConfirmation(order, settings.whatsapp_group_link);
    await botsailorClient.sendTextMessage(phoneNumber, confirmationMsg);
  }

  /**
   * Handle Admin /add Command from WhatsApp
   */
  async handleAdminAddProduct(phoneNumber: string, text: string, mediaUrl?: string): Promise<void> {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const data: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^([a-zA-Z\s]+):\s*(.+)$/);
      if (match) {
        data[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }

    const name = data['name'] || data['title'];
    const category = data['category'] || 'General';
    const price = parseFloat(data['price'] || '0') || 0;
    const description = data['description'] || name || 'Product';
    const sizes = (data['sizes'] || data['size'] || '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
    const colors = (data['colors'] || data['color'] || '').split(/[,;|]/).map((c) => c.trim()).filter(Boolean);

    if (!name || price <= 0) {
      let help = `⚠️ *Format for /add:*\n\n`;
      help += `/add\n`;
      help += `Category: Kitchen\n`;
      help += `Name: Wooden Chopping Board\n`;
      help += `Price: 8500\n`;
      help += `Sizes: Medium, Large\n`;
      help += `Colors: Blue, Red\n`;
      help += `Description: Premium teak cutting board.\n\n`;
      help += `_(Attach a photo or video to your message!)_`;
      await botsailorClient.sendTextMessage(phoneNumber, help);
      return;
    }

    const variantsData: any[] = [];
    if (sizes.length > 0 || colors.length > 0) {
      const sizeList = sizes.length > 0 ? sizes : ['Standard'];
      const colorList = colors.length > 0 ? colors : ['Default'];
      sizeList.forEach((sz) => {
        colorList.forEach((col) => {
          variantsData.push({
            size: sz !== 'Standard' ? sz : null,
            color: col !== 'Default' ? col : null,
            price: price,
            stock_quantity: 50,
          });
        });
      });
    }

    const created = await db.createProduct(
      {
        name,
        category_name: category,
        base_price: price,
        description,
        media_urls: mediaUrl ? [mediaUrl] : [],
      },
      variantsData
    );

    let ack = `🎉 *Product Successfully Published!*\n\n`;
    ack += `🛍️ *Name:* ${created.name}\n`;
    ack += `📂 *Category:* ${created.category_name}\n`;
    ack += `💰 *Base Price:* ₦${created.base_price}\n`;
    ack += `🎨 *Variants Created:* ${created.variants?.length || 0}\n`;
    ack += `📸 *Media Attached:* ${mediaUrl ? 'Yes' : 'No'}\n\n`;
    ack += `Customers can now find and purchase this item on WhatsApp! 🚀`;

    await botsailorClient.sendTextMessage(phoneNumber, ack);
  }

  /**
   * Dispatches WhatsApp alert to human support staff phone number
   */
  async notifySupportTeam(customerPhone: string, session: any): Promise<void> {
    try {
      const settings = await db.getStoreSettings();
      const supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') {
        logger.warn('Support alert not sent: No valid support phone configured in store settings yet.');
        return;
      }

      const item = session.context.currentProduct?.name || 'Browsing Catalog';
      const variant = session.context.selectedVariant
        ? [session.context.selectedVariant.color, session.context.selectedVariant.size].filter(Boolean).join(' - ')
        : 'None selected yet';

      let alert = `🚨 *LIVE CUSTOMER SUPPORT ALERT!* 🚨\n\n`;
      alert += `A customer requested human assistance on WhatsApp:\n`;
      alert += `• *Customer Phone:* +${customerPhone}\n`;
      alert += `• *Product of Interest:* ${item}\n`;
      alert += `• *Selected Variant:* ${variant}\n\n`;
      alert += `👉 *Tap to chat with customer directly:* https://wa.me/${customerPhone}`;

      await botsailorClient.sendTextMessage(supportPhone, alert);
      logger.info(`Dispatched support alert to staff (${supportPhone}) for customer (+${customerPhone})`);
    } catch (err: any) {
      logger.error('Failed to dispatch support alert to staff WhatsApp:', err.message);
    }
  }
}

export const chatFlowEngine = new ChatFlowEngine();
