import { botsailorClient } from '../../integrations/botsailor/botsailorClient.ts';
import { chatSessionManager } from './chatSessionManager.ts';
import { catalogService } from '../catalog/catalogService.ts';
import { orderService } from '../orders/orderService.ts';
import { followupService } from '../followup/followupService.ts';
import { db } from '../../database/supabaseClient.ts';
import { config } from '../../config/environment.ts';
import { logger } from '../../utils/logger.ts';

export class ChatFlowEngine {
  async processInboundMessage(params: {
    phoneNumber: string;
    text?: string;
    mediaUrl?: string;
    mediaType?: 'image' | 'video' | 'document';
    userName?: string;
  }): Promise<void> {
    const { phoneNumber, text = '', mediaUrl, mediaType = 'image', userName } = params;
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

    // 2. Check for Delivery & Order Status Inquiries (Hybrid Model - Post-Purchase Assistance)
    if (orderService.isDeliveryInquiry(cleanText)) {
      const order = await orderService.findCustomerOrder(cleanPhone, cleanText);
      chatSessionManager.handoverToSupport(cleanPhone);

      if (order) {
        const statusMsg = orderService.formatOrderStatus(order);
        await botsailorClient.sendTextMessage(cleanPhone, statusMsg);
      } else {
        let msg = `📦 *Order & Delivery Inquiry*\n\n`;
        msg += `We couldn't immediately locate an active order for this WhatsApp number in our records.\n\n`;
        msg += `One of our *staff* has been notified and will check with dispatch to assist you directly!\n\n`;
        msg += `👉 If you have your Order Ref (e.g. *NT-2026-XXXX*), please reply with it so we can track it immediately.`;
        await botsailorClient.sendTextMessage(cleanPhone, msg);
      }

      // Non-blocking staff alert for instant customer response
      this.notifyStaffDeliveryInquiry({
        customerPhone: cleanPhone,
        inquiryText: cleanText,
        order,
      }).catch((err) =>
        logger.error('Failed to notify staff of delivery inquiry in background:', err.message)
      );
      return;
    }

    // 3. Check for Live Human Support Trigger
    if (
      ['agent', 'support', 'human', 'help', 'representative', 'talk to agent', 'talk to support', 'talk to staff', 'speak with staff', 'connect with our staff', 'connect with staff', 'connect to staff', 'connect staff', 'talk to human', 'human assistance', 'staff', 'customer care', 'call me'].some((k) =>
        lowerText.includes(k)
      )
    ) {
      chatSessionManager.handoverToSupport(cleanPhone);
      await botsailorClient.sendQuickReplyButtons(
        cleanPhone,
        `👩‍💼 *Customer Support Assigned*\n\nOne of our staff has been notified and will assist you here shortly.\n\n_(Type *MENU* anytime to resume automated shopping)._`,
        [
          { text: '📂 MENU', payload: 'menu' },
        ],
        'Customer Support'
      );
      // Non-blocking staff alert for lightning fast customer response
      this.notifySupportTeam(cleanPhone, session).catch((err) =>
        logger.error('Failed to notify staff in background:', err.message)
      );
      return;
    }

    // 4. Human Support Handover Protection:
    // If user is currently handed over to staff, don't interfere unless they explicitly type MENU/RESTART
    if (session.state === 'HANDED_OVER_TO_SUPPORT') {
      const cleanCmd = lowerText.replace(/[^\w\s]/g, '').trim();
      if (
        ['menu', 'catalog', 'view catalog', 'see catalog', 'start', 'restart', 'reset'].some((cmd) =>
          cleanCmd.includes(cmd) || lowerText.includes(cmd)
        )
      ) {
        chatSessionManager.resetSession(cleanPhone);
        await this.sendWelcomeMenu(cleanPhone);
        return;
      }
      logger.info(`User ${cleanPhone} is in human staff mode. Ignoring message to let staff converse.`);
      return;
    }

    // 5. Check for Explicit Reset / Menu Commands
    if (['menu', 'catalog', 'view catalog', 'see catalog', 'view products', 'shop', 'store', 'products', 'all products', 'start', 'restart', 'reset'].includes(lowerText)) {
      chatSessionManager.resetSession(cleanPhone);
      await this.sendWelcomeMenu(cleanPhone);
      return;
    }

    // 5b. Check for "Enter Product Name" Button Tap
    if (['enter product name', 'enter product', 'order a product', 'enter_product', 'enter name'].includes(lowerText)) {
      await botsailorClient.sendTextMessage(
        cleanPhone,
        `🛍️ *What product would you like to order?*\n\nPlease reply with the product name (for example: *Chopping Board*, *Knapsack Sprayer*, *Spin Mop*).`
      );
      return;
    }

    // 6. Check for VIP Group Link Request (across any state)
    if (['group', 'vip', 'vip group', 'community', 'join group', 'whatsapp group', 'link'].includes(lowerText)) {
      chatSessionManager.resetSession(cleanPhone);
      let groupMsg = `📲 *Join our VIP WhatsApp Community:*\n${settings.whatsapp_group_link || 'https://chat.whatsapp.com/...'}\n\n`;
      groupMsg += `New arrivals, product videos & wholesale deals are posted daily! 🛍️✨`;
      await botsailorClient.sendTextMessage(cleanPhone, groupMsg);
      return;
    }

    // 7. Handle Opt-out / Objection / Cancellation (across any state)
    if (['no', 'not interested', 'stop', 'cancel', 'don\'t want', 'dont want', 'nevermind', 'never mind'].includes(lowerText)) {
      chatSessionManager.resetSession(cleanPhone);
      await followupService.optOut(cleanPhone);
      await botsailorClient.sendTextMessage(
        cleanPhone,
        `No problem at all! Feel free to reach out anytime you need anything. Have a wonderful day! 😊✨`
      );
      return;
    }

    // 8. Handle "YES" / "ORDER" from Follow-up while in IDLE
    if (session.state === 'IDLE' && (lowerText === 'yes' || lowerText === '1' || lowerText === 'order' || lowerText === 'i want to buy')) {
      const lead = await followupService.getLead(cleanPhone);
      if (lead && lead.productName) {
        const results = await catalogService.search(lead.productName);
        if (results.length > 0) {
          const topProduct = results[0];
          chatSessionManager.setCurrentProduct(cleanPhone, topProduct);
          const variants = topProduct.variants || [];
          if (variants.length > 0) {
            chatSessionManager.setState(cleanPhone, 'SELECTING_VARIANT');
            await botsailorClient.sendTextMessage(
              cleanPhone,
              `Great! Let's complete your order for *${topProduct.name}* 🛍️\n\n👉 Reply with your preferred option number:`
            );
            return;
          } else {
            chatSessionManager.setState(cleanPhone, 'AWAITING_QUANTITY');
            await botsailorClient.sendTextMessage(
              cleanPhone,
              `Great! 🛍️ *${topProduct.name}*\n\n📦 *How many pieces would you like?* (Reply with e.g. 1, 2, or 3)`
            );
            return;
          }
        }
      }
    }

    // 9. Smart Greeting with Interactive Buttons (Hybrid Model)
    if (session.state === 'IDLE' && this.isStandaloneGreeting(cleanText)) {
      let greeting = `Good day! 👋 Welcome to *Nairatee Stores*.\n\n`;
      greeting += `Are you looking to order a product, or would you like me to connect you with our staff?\n\n`;
      greeting += `👉 Reply with the *product name* to order (e.g. *Chopping Board*, *Sprayer*, *Mop*)\n`;
      greeting += `👉 Reply *STAFF* to connect with our staff\n`;
      greeting += `👉 Reply *CATALOG* to view popular items`;

      await botsailorClient.sendQuickReplyButtons(
        cleanPhone,
        greeting,
        [
          { text: 'Enter Product Name', payload: 'enter_product' },
          { text: 'Staff', payload: 'staff' },
          { text: 'View Catalog', payload: 'catalog' },
        ],
        'Nairatee Stores'
      );
      return;
    }

    // 8. State Machine Routing for Active Conversations
    switch (session.state) {
      case 'SELECTING_VARIANT':
        await this.handleVariantSelection(cleanPhone, cleanText, session);
        return;

      case 'AWAITING_QUANTITY':
        await this.handleQuantitySelection(cleanPhone, cleanText, session);
        return;

      case 'AWAITING_DELIVERY_DETAILS':
        await this.handleDeliveryDetailsSubmission(cleanPhone, cleanText, session);
        return;

      case 'IDLE':
      case 'BROWSING_PRODUCTS':
      default:
        // Smart Idle Handling: Only responds to product matches or explicit shopping intent!
        await this.handleIdleMessage(cleanPhone, cleanText, lowerText, settings, userName);
        return;
    }
  }

  /**
   * Smart Idle Message Handler:
   * 1. Searches catalog for product match (e.g. from Meta Ads or organic search).
   * 2. If matched -> presents product and variants.
   * 3. If no match BUT user used shopping keywords (e.g. "buy", "price", "order", "cost") -> polite guidance with VIP group.
   * 4. If no match AND no shopping intent (casual chats like "where are you", "ok", "good morning") -> 100% SILENT.
   */
  async handleIdleMessage(
    phoneNumber: string,
    cleanText: string,
    lowerText: string,
    settings: Record<string, any>,
    userName?: string
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

      // Record lead in follow-up tracker
      await followupService.recordLead({
        phoneNumber,
        product: topProduct,
        userName,
      });

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
        chatSessionManager.setState(phoneNumber, 'AWAITING_QUANTITY');
        await botsailorClient.sendQuickReplyButtons(
          phoneNumber,
          `📦 *How many pieces would you like to order?*`,
          [
            { text: '1 Piece', payload: '1' },
            { text: '2 Pieces', payload: '2' },
            { text: '3 Pieces', payload: '3' },
          ]
        );
      }
      return;
    }

    // 2. Check if user is asking to join group or see catalog
    if (['join', 'group', 'vip', 'more items', 'other items', 'catalog', 'see products'].some((k) => lowerText.includes(k))) {
      let groupMsg = `📲 *Join our VIP WhatsApp Group:*\n${settings.whatsapp_group_link || 'https://chat.whatsapp.com/...'}\n\n`;
      groupMsg += `Browse 500+ items with daily videos, photos & wholesale prices! 🛍️`;
      await botsailorClient.sendTextMessage(phoneNumber, groupMsg);
      return;
    }

    // 3. No Product Found: Check for Shopping Intent Keywords
    const shoppingIntentKeywords = [
      'order', 'buy', 'price', 'cost', 'how much', 'do you have', 'stock',
      'deliver', 'delivery', 'sell', 'discount', 'purchase', 'shipping',
      'available', 'pay on delivery', 'payment', 'transfer', 'wholesale', 'catalog', 'item'
    ];
    const hasShoppingIntent = shoppingIntentKeywords.some((k) => lowerText.includes(k));

    if (hasShoppingIntent) {
      let msg = `😕 Sorry, we couldn't find an exact match for *"${cleanText}"* in our current catalog.\n\n`;
      msg += `📂 *Browse categories:* Kitchen Wares, Agricultural Tools, Home & Cleaning.\n\n`;
      msg += `👉 Type *CATALOG* to see all items.\n`;
      msg += `👉 Type *STAFF* to speak with our team.`;

      if (settings.whatsapp_group_link) {
        msg += `\n\n📲 *Join our VIP WhatsApp Group for daily stock:*\n${settings.whatsapp_group_link}`;
      }

      await botsailorClient.sendTextMessage(phoneNumber, msg);
      return;
    }

    // 4. Casual / Unrelated Message (Friends, family, personal contacts):
    // DO NOT RESPOND! Stay 100% silent so human conversations are completely untouched!
    logger.info(`[ANTI-INTERFERENCE] Ignoring casual non-store message from ${phoneNumber}: "${cleanText}"`);
  }

  /**
   * Welcome Menu & Introduction (Short & Nigerian-friendly)
   */
  async sendWelcomeMenu(phoneNumber: string): Promise<void> {
    const [categories, settings] = await Promise.all([catalogService.getCategories(), db.getStoreSettings()]);
    let msg = `📂 *NAIRATEE STORES CATALOG & PRODUCTS* 🛍️\n\n`;

    if (settings.whatsapp_group_link) {
      msg += `📲 *Join our VIP WhatsApp Group to view all 500+ products with daily videos, photos & prices:*\n`;
      msg += `${settings.whatsapp_group_link}\n\n`;
    }

    msg += `✨ *Popular Categories in Store:*\n`;
    categories.forEach((cat) => {
      msg += `• ${cat.icon_emoji || '📦'} *${cat.name}*\n`;
    });

    msg += `\n👉 *To order any product immediately:* Reply with the product name (e.g. *Chopping Board*, *Sprayer*, *Mop*)!\n`;
    msg += `👉 Or reply *STAFF* to connect with our staff.`;

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
      // Check if user already sent address directly in this message!
      const parsedAddr = orderService.parseAddressMessage(text, phoneNumber);
      if (parsedAddr.address && parsedAddr.address.length >= 10 && (parsedAddr.name !== 'Valued Customer' || text.includes('080') || text.includes('090') || text.includes('070') || text.includes('081'))) {
        selectedVariant = variants[0];
        chatSessionManager.setSelectedVariant(phoneNumber, selectedVariant);
        chatSessionManager.setSelectedQuantity(phoneNumber, parsedAddr.quantity || 1);
        await this.handleDeliveryDetailsSubmission(phoneNumber, text, session);
        return;
      }

      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please reply with your option number (e.g. *1* or *2*)`
      );
      return;
    }

    chatSessionManager.setSelectedVariant(phoneNumber, selectedVariant);
    chatSessionManager.setState(phoneNumber, 'AWAITING_QUANTITY');

    // Update lead in follow-up tracker
    await followupService.recordLead({
      phoneNumber,
      product,
      variant: selectedVariant,
    });

    const formattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(selectedVariant.price);
    const variantDesc = [selectedVariant.color, selectedVariant.size].filter(Boolean).join(' - ');

    let msg = `✅ *Option Selected:* ${variantDesc} (${formattedPrice})\n\n`;
    msg += `📦 *How many pieces would you like to order?*\n`;
    msg += `👉 Reply with a number (e.g. *1*, *2*, or *3*)`;

    await botsailorClient.sendQuickReplyButtons(
      phoneNumber,
      msg,
      [
        { text: '1 Piece', payload: '1' },
        { text: '2 Pieces', payload: '2' },
        { text: '3 Pieces', payload: '3' },
      ],
      'Quantity'
    );
  }

  /**
   * Handle Quantity Selection
   */
  async handleQuantitySelection(phoneNumber: string, text: string, session: any): Promise<void> {
    const product = session.context.currentProduct;
    const variant = session.context.selectedVariant;

    if (!product) {
      chatSessionManager.resetSession(phoneNumber);
      await this.sendWelcomeMenu(phoneNumber);
      return;
    }

    // Check if user sent full address in this step directly!
    const parsedAddr = orderService.parseAddressMessage(text, phoneNumber);
    if (parsedAddr.address && parsedAddr.address.length >= 10 && (parsedAddr.name !== 'Valued Customer' || text.includes('080') || text.includes('090') || text.includes('070') || text.includes('081'))) {
      chatSessionManager.setSelectedQuantity(phoneNumber, parsedAddr.quantity || session.context.selectedQuantity || 1);
      await this.handleDeliveryDetailsSubmission(phoneNumber, text, session);
      return;
    }

    const cleanDigits = text.replace(/\D/g, '');
    let qty = parseInt(cleanDigits, 10);
    if (isNaN(qty) || qty <= 0) {
      qty = 1;
    }

    chatSessionManager.setSelectedQuantity(phoneNumber, qty);
    chatSessionManager.setState(phoneNumber, 'AWAITING_DELIVERY_DETAILS');

    // Update lead in follow-up tracker
    await followupService.recordLead({
      phoneNumber,
      product,
      variant,
      quantity: qty,
    });

    let msg = `Got it! 📦 *${qty} piece(s) reserved.*\n\n`;
    msg += `🚚 Please reply with your *Delivery Details* to complete your order:\n\n`;
    msg += `• *Full Name:*\n`;
    msg += `• *Delivery Address & City/State:*\n`;
    msg += `• *Phone Number:*\n\n`;
    msg += `_(You can send everything in one single message!)_`;

    await botsailorClient.sendTextMessage(phoneNumber, msg);
  }

  /**
   * Handle Delivery Details Submission & Order Creation:
   * 1. Creates order with status PENDING (Awaiting staff delivery fee quote).
   * 2. Marks lead as PURCHASED (Follow-up stopped).
   * 3. Sends customer short confirmation with reassurance that staff will contact them + VIP group invite.
   * 4. Dispatches instant WhatsApp alert to staff phone with direct WhatsApp link.
   * 5. Sets state to HANDED_OVER_TO_SUPPORT so bot will never interrupt staff chat.
   */
  async handleDeliveryDetailsSubmission(phoneNumber: string, text: string, session: any): Promise<void> {
    const product = session.context.currentProduct;
    const variant = session.context.selectedVariant;
    const quantity = session.context.selectedQuantity || 1;

    if (!product) {
      chatSessionManager.resetSession(phoneNumber);
      await this.sendWelcomeMenu(phoneNumber);
      return;
    }

    const parsed = orderService.parseAddressMessage(text, phoneNumber);

    if (!parsed.address || parsed.address.length < 5) {
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please include your complete delivery address (Street name, Area, City/State) so our dispatch team can locate you easily.`
      );
      return;
    }

    const finalQuantity = parsed.quantity || quantity;
    const unitPrice = variant ? variant.price : product.base_price;
    const orderItem = {
      product_id: product.id,
      product_name: product.name,
      variant_id: variant?.id,
      size: variant?.size,
      color: variant?.color,
      unit_price: unitPrice,
      quantity: finalQuantity,
      subtotal: unitPrice * finalQuantity,
    };

    const order = await orderService.createCustomerOrder({
      customerName: parsed.name,
      customerPhone: parsed.phone,
      deliveryAddress: parsed.address,
      items: [orderItem],
      paymentMethod: 'POD',
    });

    chatSessionManager.setPendingOrderNumber(phoneNumber, order.order_number);
    chatSessionManager.handoverToSupport(phoneNumber);

    // Stop sales follow-ups
    await followupService.markPurchased(phoneNumber);

    const settings = await db.getStoreSettings();

    // 1. Send confirmation to customer
    const confirmationMsg = orderService.formatOrderConfirmation(order, settings.whatsapp_group_link);
    await botsailorClient.sendTextMessage(phoneNumber, confirmationMsg);

    // 2. Alert staff WhatsApp number in background so customer receives their order confirmation instantly!
    this.notifyStaffNewOrder({
      order,
      productName: product.name,
      variantDesc: variant ? [variant.color, variant.size].filter(Boolean).join(' - ') : undefined,
      quantity: finalQuantity,
      customerName: parsed.name,
      customerPhone: parsed.phone,
      deliveryAddress: parsed.address,
    }).catch((err) =>
      logger.error('Failed to dispatch staff order alert in background:', err.message)
    );
  }

  /**
   * Dispatches WhatsApp alert to human staff phone number when address is submitted
   */
  async notifyStaffNewOrder(params: {
    order: any;
    productName: string;
    variantDesc?: string;
    quantity: number;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
  }): Promise<void> {
    try {
      const settings = await db.getStoreSettings();
      const supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') {
        logger.warn('Staff alert not sent: No valid support phone configured in store settings yet.');
        return;
      }

      const totalFormatted = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(params.order.total_amount);
      const variantText = params.variantDesc ? ` (${params.variantDesc})` : '';

      let alert = `🚨 *NEW ORDER INTENT — ADDRESS SUBMITTED!* 🚨\n\n`;
      alert += `A buyer is ready! Please contact them to confirm delivery fee:\n\n`;
      alert += `• *Order Ref:* ${params.order.order_number}\n`;
      alert += `• *Customer Name:* ${params.customerName}\n`;
      alert += `• *Phone:* +${params.customerPhone}\n`;
      alert += `• *Address:* ${params.deliveryAddress}\n`;
      alert += `• *Product:* ${params.productName}${variantText}\n`;
      alert += `• *Quantity:* ${params.quantity} piece(s) (${totalFormatted})\n\n`;
      alert += `👉 *Tap to chat with customer right now:* https://wa.me/${params.customerPhone}`;

      await botsailorClient.sendTextMessage(supportPhone, alert);
      logger.info(`Dispatched new order alert to staff (${supportPhone}) for customer (+${params.customerPhone})`);
    } catch (err: any) {
      logger.error('Failed to dispatch new order alert to staff WhatsApp:', err.message);
    }
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

      let alert = `🚨 *LIVE CUSTOMER SUPPORT REQUEST!* 🚨\n\n`;
      alert += `A customer requested human staff assistance on WhatsApp:\n`;
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

  /**
   * Dispatches WhatsApp alert to human staff when customer inquires about an order or delivery
   */
  async notifyStaffDeliveryInquiry(params: {
    customerPhone: string;
    inquiryText: string;
    order?: any;
  }): Promise<void> {
    try {
      const settings = await db.getStoreSettings();
      const supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') return;

      let alert = `🚚 *CUSTOMER CHECKING DELIVERY STATUS!* 🚚\n\n`;
      alert += `• *Customer Phone:* +${params.customerPhone}\n`;
      if (params.order) {
        alert += `• *Order Ref:* ${params.order.order_number}\n`;
        alert += `• *Customer Name:* ${params.order.customer_name}\n`;
        alert += `• *Order Status:* ${params.order.order_status}\n`;
        alert += `• *Delivery Address:* ${params.order.delivery_address}\n`;
      } else {
        alert += `• *Order Ref:* Not found by phone number\n`;
      }
      alert += `• *Customer Inquiry:* "${params.inquiryText}"\n\n`;
      alert += `👉 *Tap to chat with customer right now:* https://wa.me/${params.customerPhone}`;

      await botsailorClient.sendTextMessage(supportPhone, alert);
      logger.info(`Dispatched delivery inquiry alert to staff (${supportPhone}) for customer (+${params.customerPhone})`);
    } catch (err: any) {
      logger.error('Failed to dispatch delivery inquiry alert to staff WhatsApp:', err.message);
    }
  }

  /**
   * Smart Greeting Filter: Matches standalone greetings only
   * (e.g. "Hi", "Hello", "Good morning", "Good afternoon", "Good day", etc.)
   * Casual non-store messages like "Good morning, hope the kids are fine?" or "Bro call me" are NOT standalone greetings.
   */
  isStandaloneGreeting(text: string): boolean {
    const clean = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const greetings = [
      'hi',
      'hello',
      'hey',
      'good morning',
      'good afternoon',
      'good evening',
      'good day',
      'howdy',
      'wassup',
      'whatsup',
      'whats up',
      'yo',
      'greetings',
      'hi nairatee',
      'hello nairatee',
      'good morning nairatee',
      'good day nairatee',
      'morning',
      'afternoon',
      'evening',
    ];
    return greetings.includes(clean);
  }
}

export const chatFlowEngine = new ChatFlowEngine();
