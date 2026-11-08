import { botsailorClient } from '../../integrations/botsailor/botsailorClient.ts';
import { chatSessionManager } from './chatSessionManager.ts';
import { catalogService } from '../catalog/catalogService.ts';
import { orderService } from '../orders/orderService.ts';
import { followupService } from '../followup/followupService.ts';
import { systemSettings } from '../system/systemSettings.ts';
import { db } from '../../database/supabaseClient.ts';
import { config } from '../../config/environment.ts';
import { logger } from '../../utils/logger.ts';

export class ChatFlowEngine {
  async processInboundMessage(params: {
    phoneNumber: string;
    text?: string;
    buttonPayload?: string;
    mediaUrl?: string;
    mediaType?: 'image' | 'video' | 'document';
    userName?: string;
  }): Promise<void> {
    const { phoneNumber, text = '', buttonPayload = '', mediaUrl, mediaType = 'image', userName } = params;
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();
    const cleanLower = lowerText;
    const btnPayloadClean = (buttonPayload || '').trim().toLowerCase();

    logger.info(`Processing message from ${cleanPhone}: "${cleanText}" (BtnPayload: "${btnPayloadClean}", Media: ${mediaUrl ? 'Yes' : 'No'})`);

    const settings = await db.getStoreSettings();
    const supportPhoneClean = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');

    // 1. Check for Admin /add WhatsApp Command (Authorized staff/admins can upload products anytime!)
    if (lowerText.startsWith('/add')) {
      const isAdmin =
        config.adminPhoneList.includes(cleanPhone) ||
        config.adminPhoneList.includes('2348000000000') ||
        cleanPhone === supportPhoneClean ||
        cleanPhone === '2348103949939';
      if (isAdmin) {
        await this.handleAdminAddProduct(cleanPhone, cleanText, mediaUrl);
        return;
      }
    }

    // REVOKE & PROTOCOL GUARD: Never process WhatsApp message revoke/delete events or synthetic attachment tokens
    if (
      cleanText.includes('#ATTACHMENT:revoke#') ||
      cleanText.toLowerCase().includes('revoke#') ||
      cleanText.toLowerCase() === 'revoke' ||
      cleanText.toLowerCase().includes('deleted this message') ||
      cleanText.toLowerCase().includes('this message was deleted') ||
      cleanText.toLowerCase().includes('you deleted')
    ) {
      logger.info(`[CHAT_FLOW] Discarding message revoke/deletion event from ${cleanPhone}`);
      return;
    }

    // 0. MASTER KILLSWITCH: If bot is turned OFF, stay 100% silent for shoppers!
    const isBotActive = await systemSettings.isBotGloballyActive();
    if (!isBotActive) {
      logger.info(`[KILLSWITCH ACTIVE] Bot is currently PAUSED. Silently ignoring message from ${cleanPhone}.`);
      return;
    }

    // LAYER 2: Automatic Human Takeover & Bot Auto-Mute Check
    // When a human agent has taken over the chat, the bot remains 100% silent unless customer explicitly types a resume command
    if (chatSessionManager.isHumanTakeoverActive(cleanPhone)) {
      const isBotResumeCommand =
        btnPayloadClean === 'menu' ||
        btnPayloadClean === 'start' ||
        btnPayloadClean === 'restart' ||
        btnPayloadClean === 'reset' ||
        btnPayloadClean === 'shop' ||
        btnPayloadClean === 'catalog' ||
        ['menu', 'start', 'restart', 'reset', 'clear', 'bot', 't-bot', 'teebot', 'tbot', 'hello t-bot', 'hello teebot', 'shop', 'store', 'catalog'].some((cmd) =>
          cleanLower === cmd || cleanLower.includes(cmd)
        );

      if (isBotResumeCommand) {
        logger.info(`[HUMAN TAKEOVER] Customer ${cleanPhone} explicitly typed resume command "${cleanText}". Unpausing bot.`);
        chatSessionManager.clearHumanTakeover(cleanPhone);
        chatSessionManager.resetSession(cleanPhone);
        await this.sendStartOfFlowPrompt(cleanPhone);
        return;
      }

      logger.info(`[HUMAN TAKEOVER ACTIVE] Customer ${cleanPhone} is in human agent takeover mode. Sent: "${cleanText}". Bot remaining 100% silent.`);
      return;
    }

    const session = chatSessionManager.getSession(cleanPhone);

    // 2. Check for Delivery & Post-Purchase Order Inquiries (Hybrid Model - Post-Purchase Assistance)
    if (orderService.isPostPurchaseOrSupportInquiry(cleanText)) {
      const order = await orderService.findCustomerOrder(cleanPhone, cleanText);
      chatSessionManager.handoverToSupport(cleanPhone);

      if (order) {
        const statusMsg = orderService.formatOrderStatus(order);
        await botsailorClient.sendQuickReplyButtons(
          cleanPhone,
          statusMsg,
          [{ text: '📂 MENU', payload: 'menu' }],
          'Order Status'
        );
      } else {
        let msg = `👩‍💼 *Customer Support Assigned*\n\n`;
        msg += `We see you are contacting us regarding an existing order, delivery, or support inquiry (*"${cleanText}"*).\n\n`;
        msg += `One of our *staff* has been notified right away and will assist you here shortly!\n\n`;
        msg += `_(Type *MENU* anytime to return to the catalog)._`;
        await botsailorClient.sendQuickReplyButtons(
          cleanPhone,
          msg,
          [{ text: '📂 MENU', payload: 'menu' }],
          'Customer Support'
        );
      }

      // Non-blocking staff alert for instant customer response
      this.notifyStaffDeliveryInquiry({
        customerPhone: cleanPhone,
        inquiryText: cleanText,
        order,
      }).catch((err) =>
        logger.error('Failed to notify staff of delivery/support inquiry in background:', err.message)
      );
      return;
    }

    // 3. Check for Live Human Support Trigger (Buttons, keywords, or fallback #1)
    const isSupportTrigger =
      btnPayloadClean === 'staff' ||
      btnPayloadClean === 'support' ||
      ['agent', 'support', 'human', 'help', 'representative', 'talk to agent', 'talk to support', 'talk to staff', 'speak with staff', 'connect with our staff', 'connect with staff', 'connect to staff', 'connect staff', 'talk to human', 'human assistance', 'staff', 'customer care', 'call me'].some((k) =>
        lowerText.includes(k)
      ) ||
      ((session.context.lastPrompt === 'UNAVAILABLE' || session.context.lastPrompt === 'PHOTO_INQUIRY') && (lowerText === '1' || btnPayloadClean === '1'));

    if (isSupportTrigger) {
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
    // If user is currently handed over to staff, don't interfere unless they explicitly type MENU/RESTART or tap MENU button
    if (session.state === 'HANDED_OVER_TO_SUPPORT') {
      const cleanCmd = lowerText.replace(/[^\w\s]/g, '').trim();
      const isResumeMenu =
        btnPayloadClean === 'menu' ||
        btnPayloadClean === 'main_menu' ||
        ['menu', 'start', 'restart', 'reset', 'main menu'].some((cmd) =>
          cleanCmd.includes(cmd) || lowerText.includes(cmd)
        );

      if (isResumeMenu) {
        chatSessionManager.clearHumanTakeover(cleanPhone);
        chatSessionManager.resetSession(cleanPhone);
        await this.sendStartOfFlowPrompt(cleanPhone);
        return;
      }
      logger.info(`User ${cleanPhone} is in human staff mode. Ignoring message to let staff converse.`);
      return;
    }

    // 5. Universal Reset Commands (Takes user back to start of flow, NOT greeting)
    const universalResetCommands = [
      'reset',
      'clear',
      'restart',
      'start over',
      'menu',
      'main menu',
      'clear all',
      'cancel',
      'home',
      'shop',
      'store',
      'catalog',
      'start',
    ];

    const isMainMenuTrigger =
      btnPayloadClean === 'menu' ||
      btnPayloadClean === 'main_menu' ||
      btnPayloadClean === 'reset' ||
      btnPayloadClean === 'start' ||
      btnPayloadClean === 'restart' ||
      btnPayloadClean === 'shop' ||
      btnPayloadClean === 'catalog' ||
      universalResetCommands.includes(cleanLower) ||
      ((session.context.lastPrompt === 'UNAVAILABLE' || session.context.lastPrompt === 'PHOTO_INQUIRY') && (lowerText === '3' || btnPayloadClean === '3'));

    if (isMainMenuTrigger) {
      chatSessionManager.resetSession(cleanPhone);
      await this.sendStartOfFlowPrompt(cleanPhone);
      return;
    }

    // LAYER 4: Stale / Abandoned Session Auto-Reset on Casual Greeting
    // If a customer returns to an uncompleted session (e.g. AWAITING_DELIVERY_DETAILS, SELECTING_VARIANT, AWAITING_QUANTITY)
    // and sends a casual greeting ("hello", "hi", "hey", "good morning", etc.):
    // Cleanly reset the session back to IDLE and display the Main Menu / Start of Flow prompt instead of throwing invalid step errors or demanding an address!
    if (session.state !== 'IDLE' && session.state !== 'HANDED_OVER_TO_SUPPORT') {
      const isCasualGreeting =
        this.isStandaloneGreeting(cleanText) ||
        ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'good day', 'morning', 'afternoon'].includes(cleanLower);

      if (isCasualGreeting) {
        logger.info(`[SESSION AUTO-RESET] Customer ${cleanPhone} returned to uncompleted flow (${session.state}) with greeting "${cleanText}". Resetting to IDLE and presenting Main Menu.`);
        chatSessionManager.resetSession(cleanPhone);
        await this.sendStartOfFlowPrompt(cleanPhone);
        return;
      }
    }

    // 5b. Check for "Enter Product Name" Button Tap
    const isEnterProductTrigger =
      btnPayloadClean === 'enter_product' ||
      btnPayloadClean === 'enter product name' ||
      ['enter product name', 'enter product', 'order a product', 'enter name'].includes(lowerText) ||
      (session.context.lastPrompt === 'PHOTO_INQUIRY' && (lowerText === '2' || btnPayloadClean === '2'));

    if (isEnterProductTrigger) {
      session.context.awaitingProductSearch = true;
      await botsailorClient.sendTextMessage(
        cleanPhone,
        `🛍️ *What product would you like to order?*\n\nPlease reply with the product name (for example: *Chopping Board*, *Knapsack Sprayer*, *Spin Mop*).`
      );
      return;
    }

    // 6. Check for VIP Group Link Request / Catalog View (across any state)
    const isVipGroupTrigger =
      btnPayloadClean === 'group' ||
      btnPayloadClean === 'vip' ||
      btnPayloadClean === 'catalog' ||
      btnPayloadClean === 'view_catalog' ||
      ['catalog', 'view catalog', 'see catalog', 'group', 'vip', 'vip group', 'community', 'join group', 'whatsapp group', 'link', 'join vip group', 'join our vip group'].some((kw) => lowerText.includes(kw)) ||
      (session.context.lastPrompt === 'UNAVAILABLE' && (lowerText === '2' || btnPayloadClean === '2'));

    if (isVipGroupTrigger) {
      chatSessionManager.resetSession(cleanPhone);
      await this.sendWelcomeMenu(cleanPhone);
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
    if (session.state === 'IDLE' && (lowerText === 'yes' || lowerText === 'order' || lowerText === 'i want to buy' || lowerText === 'proceed')) {
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

    // 8b. Photo Search Assistant (Screenshots, Instagram/Facebook ads photos, camera uploads)
    // LAYER 3 GUARD: NEVER trigger photo search if the inbound message is a casual greeting, keyword trigger, or reset command!
    const isGreetingOrReset =
      this.isStandaloneGreeting(cleanText) ||
      universalResetCommands.includes(cleanLower) ||
      btnPayloadClean.length > 0;

    if (mediaUrl && !isGreetingOrReset) {
      session.context.lastSentMediaUrl = mediaUrl;

      // In IDLE or BROWSING state:
      if (session.state === 'IDLE' || session.state === 'BROWSING_PRODUCTS') {
        let matchingProductFound = false;
        if (cleanText.length >= 2 && !this.isGenericPhotoCaption(cleanText)) {
          const adProduct = this.extractProductFromAdMessage(cleanText);
          const cleanedQuery = this.cleanSearchQuery(cleanText);
          const targetQuery = adProduct || cleanedQuery || cleanText;
          const results = await catalogService.search(targetQuery);
          if (results.length > 0) {
            matchingProductFound = true;
          }
        }

        if (!matchingProductFound) {
          await this.handlePhotoInquiry(cleanPhone, mediaUrl, cleanText, session);
          return;
        }
      }
    }

    // 9. Smart Greeting with Interactive Buttons (Hybrid Model)
    if (session.state === 'IDLE' && this.isStandaloneGreeting(cleanText)) {
      let greeting = `Good day! 👋 Welcome to *Nairatee Stores*.\n\n`;
      greeting += `Are you looking to order a product, or would you like me to connect you with our staff?\n\n`;
      greeting += `👉 Reply with the *product name* to order (e.g. *Chopping Board*, *Sprayer*, *Mop*)\n\n`;
      greeting += `👉 Reply *STAFF* to connect with our staff\n\n`;
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
        await this.handleIdleMessage(cleanPhone, cleanText, lowerText, settings, userName, session.context);
        return;
    }
  }

  /**
   * Smart Idle Message Handler:
   * 1. Searches catalog for product match (e.g. from Meta Ads or organic search).
   * 2. If matched -> presents product and variants.
   * 3. If no match BUT user searched for a product or has shopping intent:
   *    -> sends polite "Product Currently Unavailable" notice with 3 interactive buttons:
   *       [ Talk to Staff ], [ Join VIP Group ], [ Main Menu ]
   * 4. If no match AND casual personal chatter (friends/family) -> 100% SILENT.
   */
  async handleIdleMessage(
    phoneNumber: string,
    cleanText: string,
    lowerText: string,
    settings: Record<string, any>,
    userName?: string,
    sessionContext?: any
  ): Promise<void> {
    if (!cleanText || cleanText.length < 2) {
      logger.info(`Ignoring short idle message from ${phoneNumber}: "${cleanText}"`);
      return;
    }

    // Gate 0: Immediate rejection of casual personal chatter, payment chatter, and system events
    if (this.isCasualNonStoreMessage(cleanText)) {
      logger.info(`[ANTI-INTERFERENCE] Ignoring casual non-store message from ${phoneNumber}: "${cleanText}"`);
      return;
    }

    const wasAwaitingSearch = !!sessionContext?.awaitingProductSearch;
    if (sessionContext) {
      sessionContext.awaitingProductSearch = false;
    }

    // 1. Check for Meta Ads / Advert Pre-filled Trigger (e.g. "I want to buy the chopping board you advertised")
    const adProduct = this.extractProductFromAdMessage(cleanText);
    const isAdTrigger = !!adProduct;
    const cleanedQuery = this.cleanSearchQuery(cleanText);
    const targetQuery = adProduct || cleanedQuery || cleanText;

    const words = targetQuery.trim().split(/\s+/).filter(Boolean);
    const isShortQuery = words.length <= 3;
    const hasBuyingIntent = isAdTrigger || this.hasExplicitBuyingIntent(cleanText);

    // Gate: Messages with more than 3 words MUST have explicit buying intent or be an Ad trigger,
    // unless the customer was actively prompted for a product name via the "Enter Product Name" button
    if (!wasAwaitingSearch && !isShortQuery && !hasBuyingIntent) {
      logger.info(`[ANTI-INTERFERENCE] Ignoring non-buying conversational message from ${phoneNumber}: "${cleanText}"`);
      return;
    }

    // Attempt catalog search using the extracted product query or clean text
    const results = await catalogService.search(targetQuery);

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
      await this.sendWelcomeMenu(phoneNumber);
      return;
    }

    // 3. No Product Found: Check if inquiry was an intentional product search
    const isCasual = this.isCasualNonStoreMessage(cleanText);

    // If customer was explicitly prompted for product name, or arrived from Ad, or typed buying keywords, or entered a non-casual item search:
    if (wasAwaitingSearch || isAdTrigger || hasBuyingIntent || (!isCasual && isShortQuery)) {
      const displayItemName = targetQuery || adProduct || cleanText;
      if (sessionContext) {
        sessionContext.lastPrompt = 'UNAVAILABLE';
        sessionContext.lastSearchedQuery = displayItemName;
      }

      let unavailableMsg = `😕 *Product Currently Unavailable*\n\n`;
      unavailableMsg += `Sorry, we couldn't find an exact match for *"${displayItemName}"* in our current stock right now.\n\n`;
      unavailableMsg += `👉 You can speak with our *staff*, join our *VIP WhatsApp Group* to see our available items & daily restocks, or return to our main menu.`;

      await botsailorClient.sendQuickReplyButtons(
        phoneNumber,
        unavailableMsg,
        [
          { text: 'Talk to Staff', payload: 'staff' },
          { text: 'Join VIP Group', payload: 'group' },
          { text: 'Main Menu', payload: 'menu' },
        ],
        'Nairatee Stores'
      );
      return;
    }

    // 4. Casual / Unrelated Message (Friends, family, personal contacts):
    // DO NOT RESPOND! Stay 100% silent so human conversations are completely untouched!
    logger.info(`[ANTI-INTERFERENCE] Ignoring casual non-store message from ${phoneNumber}: "${cleanText}"`);
  }

  /**
   * VIP WhatsApp Group & Catalog Prompt (Clean, spaced, no bulky categories)
   */
  async sendWelcomeMenu(phoneNumber: string): Promise<void> {
    const settings = await db.getStoreSettings();
    const groupLink = settings.whatsapp_group_link || 'https://chat.whatsapp.com/IPHjsm4NALtC93ioNvQc8O?s=cl&p=i&mlu=4&ilr=4&iam=2';

    let msg = `📲 *Join our VIP WhatsApp group to view all 500+ products with daily videos, photos & prices:*\n`;
    msg += `${groupLink}\n\n`;
    msg += `👉 *To order any product immediately:* Reply with the product name (e.g. *Chopping Board*, *Sprayer*, *Mop*)\n\n`;
    msg += `👉 *Or reply STAFF* to connect with our staff.`;

    await botsailorClient.sendQuickReplyButtons(
      phoneNumber,
      msg,
      [
        { text: 'Enter Product Name', payload: 'enter_product' },
        { text: 'Staff', payload: 'staff' },
        { text: 'Main Menu', payload: 'menu' },
      ],
      'Nairatee Stores'
    );
  }

  /**
   * Start-of-Flow Prompt (for Main Menu reset — NO "Good day! Welcome" greeting banner)
   */
  async sendStartOfFlowPrompt(phoneNumber: string): Promise<void> {
    let msg = `🛍️ *How can we help you today?*\n\n`;
    msg += `Are you looking to order a product, or would you like me to connect you with our staff?\n\n`;
    msg += `👉 Reply with the *product name* to order (e.g. *Chopping Board*, *Sprayer*, *Mop*)\n\n`;
    msg += `👉 Reply *STAFF* to connect with our staff\n\n`;
    msg += `👉 Reply *CATALOG* to view popular items`;

    await botsailorClient.sendQuickReplyButtons(
      phoneNumber,
      msg,
      [
        { text: 'Enter Product Name', payload: 'enter_product' },
        { text: 'Staff', payload: 'staff' },
        { text: 'View Catalog', payload: 'catalog' },
      ],
      'Nairatee Stores'
    );
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
      await this.sendStartOfFlowPrompt(phoneNumber);
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
      await this.sendStartOfFlowPrompt(phoneNumber);
      return;
    }

    const parsed = orderService.parseAddressMessage(text, phoneNumber);

    if (this.isStandaloneGreeting(text)) {
      chatSessionManager.resetSession(phoneNumber);
      await this.sendStartOfFlowPrompt(phoneNumber);
      return;
    }

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
      mediaUrl: session?.context?.lastSentMediaUrl,
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
    mediaUrl?: string;
  }): Promise<void> {
    try {
      const settings = await db.getStoreSettings();
      let supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') {
        supportPhone = '2348103949939';
      }
      if (supportPhone.startsWith('0') && supportPhone.length === 11) {
        supportPhone = '234' + supportPhone.substring(1);
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
      alert += `• *Quantity:* ${params.quantity} piece(s) (${totalFormatted})\n`;
      if (params.mediaUrl) {
        alert += `• *Customer Photo:* ${params.mediaUrl}\n`;
      }
      alert += `\n👉 *Tap to chat with customer right now:* https://wa.me/${params.customerPhone}`;

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
      let supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') {
        supportPhone = '2348103949939';
      }
      if (supportPhone.startsWith('0') && supportPhone.length === 11) {
        supportPhone = '234' + supportPhone.substring(1);
      }

      let item = session?.context?.currentProduct?.name;
      if (!item) {
        if (session?.context?.lastPrompt === 'PHOTO_INQUIRY' || session?.context?.lastSentMediaUrl) {
          item = 'Customer sent a photo / Screenshot inquiry';
        } else if (session?.context?.lastSearchedQuery) {
          item = `"${session.context.lastSearchedQuery}" (Requested item - Out of stock / Unavailable)`;
        } else {
          item = 'Browsing Catalog';
        }
      }

      const variant = session?.context?.selectedVariant
        ? [session.context.selectedVariant.color, session.context.selectedVariant.size].filter(Boolean).join(' - ')
        : 'None selected yet';

      let alert = `🚨 *LIVE CUSTOMER SUPPORT REQUEST!* 🚨\n\n`;
      alert += `A customer requested human staff assistance on WhatsApp:\n\n`;
      alert += `• *Customer Phone:* +${customerPhone}\n`;
      alert += `• *Product of Interest:* ${item}\n`;
      alert += `• *Selected Variant:* ${variant}\n`;
      if (session?.context?.lastSentMediaUrl) {
        alert += `• *Customer Photo:* ${session.context.lastSentMediaUrl}\n`;
      }
      alert += `\n👉 *Tap to chat with customer directly:* https://wa.me/${customerPhone}`;

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
      let supportPhone = (settings.support_phone || config.SUPPORT_PHONE_NUMBER).replace(/\D/g, '');
      if (!supportPhone || supportPhone === '2348000000000') {
        supportPhone = '2348103949939';
      }
      if (supportPhone.startsWith('0') && supportPhone.length === 11) {
        supportPhone = '234' + supportPhone.substring(1);
      }

      let alert = params.order
        ? `🚚 *CUSTOMER CHECKING DELIVERY / ORDER STATUS!* 🚚\n\n`
        : `🚨 *POST-PURCHASE / CUSTOMER SUPPORT ALERT!* 🚨\n\n`;
      alert += `• *Customer Phone:* +${params.customerPhone}\n`;
      if (params.order) {
        alert += `• *Order Ref:* ${params.order.order_number}\n`;
        alert += `• *Customer Name:* ${params.order.customer_name}\n`;
        alert += `• *Order Status:* ${params.order.order_status}\n`;
        alert += `• *Delivery Address:* ${params.order.delivery_address}\n`;
      } else {
        alert += `• *Inquiry Type:* Past Order Follow-up / Complaint\n`;
      }
      alert += `• *Customer Message:* "${params.inquiryText}"\n\n`;
      alert += `👉 *Tap to chat with customer right now:* https://wa.me/${params.customerPhone}`;

      await botsailorClient.sendTextMessage(supportPhone, alert);
      logger.info(`Dispatched delivery/support alert to staff (${supportPhone}) for customer (+${params.customerPhone})`);
    } catch (err: any) {
      logger.error('Failed to dispatch delivery inquiry alert to staff WhatsApp:', err.message);
    }
  }

  /**
   * Smart Greeting Filter: Matches standalone greetings and bot triggers
   * (e.g. "Hello T-Bot", "Teebot", "Hi", "Hello", "Good morning", "Good afternoon", "Good day", etc.)
   * Casual non-store messages like "Good morning, hope the kids are fine?" or "Bro call me" are NOT standalone greetings.
   */
  isStandaloneGreeting(text: string): boolean {
    const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Explicit "Hello T-Bot" / "Teebot" flow triggers
    if (/\b(t\s*bot|teebot)\b/i.test(text)) {
      return true;
    }

    // Match single greetings or common combinations like "hello good morning", "hi good day", "good morning nairatee"
    const greetingComboPattern = /^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening|day)|morning|afternoon|evening|day|greetings|howdy|wassup|whatsup|whats\s+up|yo)(?:\s+(?:hello|hi|hey|good\s+(?:morning|afternoon|evening|day)|morning|afternoon|evening|day|nairatee|stores|bot|t\s*bot|teebot))*\s*$/i;
    if (greetingComboPattern.test(clean)) {
      return true;
    }

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

  /**
   * Extracts target product name from Meta Ads / Advert pre-filled message formats:
   * e.g. "I want to buy the chopping board you advertised" -> "chopping board"
   * e.g. "I want to buy the knapsack sprayer you advertised" -> "knapsack sprayer"
   * e.g. "I saw your ad for the electric kettle" -> "electric kettle"
   */
  extractProductFromAdMessage(text: string): string | null {
    const clean = text.trim();

    // 1. "I want to buy (the) [Product] you advertised"
    const adPattern1 = /(?:i\s+want\s+to\s+buy|i\s+want\s+to\s+order|i\s+want|i\s+need)\s+(?:the\s+)?(.*?)(?:\s+you\s+advertised|\s+advertised|\s+i\s+saw\s+on\s+ad|\s+i\s+saw\s+on\s+facebook|\s+i\s+saw\s+on\s+instagram|\s+on\s+your\s+ad|\s+on\s+ad)/i;
    const match1 = clean.match(adPattern1);
    if (match1 && match1[1] && match1[1].trim().length >= 2) {
      return match1[1].trim();
    }

    // 2. "I saw your ad for (the) [Product]" or "Saw your advert for (the) [Product]"
    const adPattern2 = /(?:i\s+)?saw\s+your\s+(?:ad|advert|advertisement)\s+for\s+(?:the\s+)?(.*?)(?:\s+on\s+facebook|\s+on\s+instagram|\s+you\s+advertised|$)/i;
    const match2 = clean.match(adPattern2);
    if (match2 && match2[1] && match2[1].trim().length >= 2) {
      return match2[1].trim();
    }

    // 3. "Interested in (the) [Product] you advertised"
    const adPattern3 = /(?:i\s+am\s+|i'm\s+)?interested\s+in\s+(?:the\s+)?(.*?)(?:\s+you\s+advertised|\s+advertised|\s+i\s+saw|$)/i;
    const match3 = clean.match(adPattern3);
    if (match3 && match3[1] && match3[1].trim().length >= 2) {
      return match3[1].trim();
    }

    return null;
  }

  /**
   * Cleans natural language buying prefixes and suffixes to extract raw product query
   * e.g. "I want bluetooth speaker" -> "bluetooth speaker"
   * e.g. "Do you have knapsack sprayer?" -> "knapsack sprayer"
   */
  cleanSearchQuery(text: string): string {
    let clean = text.trim();
    // Strip common conversational buying prefixes
    clean = clean.replace(/^(?:hello|hi|hey|good\s+day|please|pls)?\s*(?:do\s+you\s+have|have\s+you|i\s+want\s+to\s+buy|i\s+want\s+to\s+order|i\s+want|i\s+need|how\s+much\s+is|how\s+much\s+for|what\s+is\s+the\s+price\s+of|price\s+of|cost\s+of|looking\s+for|give\s+me)\s+(?:the\s+)?/i, '');
    // Strip common conversational suffixes
    clean = clean.replace(/\s+(?:you\s+advertised|advertised|i\s+saw\s+on\s+(?:facebook|instagram|ad)|on\s+(?:your\s+)?ad|available|in\s+stock)\??$/i, '');
    return clean.trim();
  }

  /**
   * Identifies casual, non-store personal chatter from family, friends, staff, and personal contacts
   * (e.g. "We've seen it ma", "Sent it", "Bro, where are you guys right now?", "Seen", "Call me")
   * as well as WhatsApp system/revocation strings.
   */
  isCasualNonStoreMessage(text: string): boolean {
    if (!text) return true;
    const lower = text.toLowerCase().trim();

    // 1. Synthetic tokens, revoke strings, WhatsApp system events
    if (
      lower.includes('#attachment') ||
      lower.includes('revoke') ||
      lower.includes('caption:') ||
      lower.includes('deleted this message') ||
      lower.includes('you deleted') ||
      lower.includes('this message was deleted') ||
      lower.includes('edited') ||
      text.includes('#') ||
      text.includes('|')
    ) {
      return true;
    }

    const clean = lower.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // 2. Comprehensive casual phrases, Nigerian informal greetings, conversational responses
    const casualPatterns = [
      /\bwhere\s+(are\s+you|you\s+dey|you\s+at)\b/i,
      /\bhow\s+(are\s+you|is\s+it|far|things|business|family|life)\b/i,
      /\bhope\s+(the\s+kids|all\s+is\s+well|you\s+are\s+fine|family\s+is\s+good)\b/i,
      /\b(call|ring|ping)\s+me\b/i,
      /\bare\s+you\s+(home|around|at\s+the\s+shop|in\s+lagos|busy)\b/i,
      /\b(bro|brother|sis|sister|my\s+guy|my\s+bro|boss|padi)\b/i,
      /\b(wetin\s+dey|wetin\s+happen)\b/i,
      /^(seen|ok|okay|k|alright|cool|lol|haha|amen|safe|sharp|thanks|thank\s+you|good|yes|no|done|fine|alryt|noted)$/i,
      /\b(good\s+morning|good\s+afternoon|good\s+evening|good\s+day)\b/i,
      // Payment acknowledgments & chatter (e.g. "We've seen it ma", "Sent it", "Sent the money", "Check receipt")
      /\b(seen\s+it|we\s+ve\s+seen|we\s+seen|i\s+seen|have\s+seen|seen\s+am|seen\s+ma|seen\s+sir|noted\s+ma|noted\s+sir)\b/i,
      /\b(sent\s+(?:the\s+)?(?:money|cash|funds|transfer|receipt|proof)|money\s+sent|transfer\s+sent|paid|have\s+paid|i\s+paid|payment\s+done|just\s+sent)\b/i,
      /\b(check\s+receipt|see\s+receipt|check\s+payment|confirm\s+payment|check\s+proof|see\s+proof|check\s+alert)\b/i,
      /\b(opay|palmpay|kuda|moniepoint|zenith|gtb|access|first\s+bank|uba)\b/i,
      /\b(money|transfer|receipt|account\s+number|account\s+no|payment\s+proof|bank\s+alert)\b/i,
      // Customer service / delivery / dispatch chatter
      /\b(where\s+is\s+my|when\s+will|track|waybill|dispatch|driver|rider|delivered|delivery\s+man)\b/i,
      // Common Nigerian conversational phrases
      /\b(no\s+problem|no\s+wahala|god\s+bless|thanks\s+ma|thanks\s+sir|thank\s+you\s+ma|thank\s+you\s+sir|welcome\s+ma|welcome\s+sir)\b/i,
    ];

    return casualPatterns.some((pattern) => pattern.test(clean));
  }

  /**
   * Checks whether a natural text message expresses clear purchase/buying intent
   * (e.g. "how much is", "i want to buy", "do you have", "price of")
   */
  hasExplicitBuyingIntent(text: string): boolean {
    const lower = text.toLowerCase();
    const buyingPatterns = [
      /\b(buy|order|price|cost|how\s+much|do\s+you\s+have|have\s+you|i\s+want|want\s+to|need|available|in\s+stock|looking\s+for|deliver\s+to|interested\s+in|purchase|get\s+one|get\s+this|pay\s+on\s+delivery)\b/i,
      /\b(how\s+much\s+is|cost\s+of|rate\s+of|give\s+me|send\s+me|send\s+price)\b/i,
    ];
    return buyingPatterns.some((pattern) => pattern.test(lower));
  }

  /**
   * Photo Search Assistant: Handles screenshots and image inquiries from Facebook/Instagram ads
   */
  async handlePhotoInquiry(
    phoneNumber: string,
    mediaUrl: string,
    caption?: string,
    session?: any
  ): Promise<void> {
    if (session && session.context) {
      session.context.lastSentMediaUrl = mediaUrl;
      session.context.lastPrompt = 'PHOTO_INQUIRY';
      session.context.lastSearchedQuery = caption || 'Photo Screenshot Inquiry';
    }

    let msg = `📸 *Thanks for sharing the photo!*\n\n`;
    msg += `Are you looking to order this item or check its availability?\n\n`;
    msg += `👉 Reply with the *product name* (e.g. *Chopping Board*, *Sprayer*, *Mop*)\n\n`;
    msg += `👉 Or tap *Talk to Staff* so our team can view your photo and assist you right away!`;

    await botsailorClient.sendQuickReplyButtons(
      phoneNumber,
      msg,
      [
        { text: 'Talk to Staff', payload: 'staff' },
        { text: 'Enter Product Name', payload: 'enter_product' },
        { text: 'Main Menu', payload: 'menu' },
      ],
      'Nairatee Stores'
    );
  }

  /**
   * Checks if an image caption is a generic inquiry rather than a specific product search
   * (e.g. "Do you have this?", "How much?", "Price", "Is this available?", etc.)
   */
  isGenericPhotoCaption(text: string): boolean {
    if (!text || text.trim().length === 0) return true;
    const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return true;

    const genericPhrases = [
      'this',
      'this one',
      'do you have this',
      'do you have this one',
      'do you have this product',
      'do you have',
      'how much',
      'how much is this',
      'how much for this',
      'how much is this one',
      'what is the price',
      'what is the price of this',
      'price',
      'price please',
      'is this available',
      'is this in stock',
      'available',
      'in stock',
      'do you sell this',
      'i want this',
      'i need this',
      'can i get this',
      'check this',
      'hello',
      'hi',
      'good morning',
      'good afternoon',
      'good day',
    ];

    if (genericPhrases.includes(clean)) {
      return true;
    }

    if (/^(?:do you have|how much|what is the price|is this|price of|can i get|i want|i need)\s+(?:this|this one|this item|this product)?$/i.test(clean)) {
      return true;
    }

    return false;
  }
}

export const chatFlowEngine = new ChatFlowEngine();
