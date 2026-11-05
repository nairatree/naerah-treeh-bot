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

    // 1. Check for Admin /add WhatsApp Command
    if (lowerText.startsWith('/add')) {
      const isAdmin = config.adminPhoneList.includes(cleanPhone) || config.adminPhoneList.includes('2348000000000');
      if (isAdmin) {
        await this.handleAdminAddProduct(cleanPhone, cleanText, mediaUrl);
        return;
      }
    }

    // 2. Check for Live Human Support Trigger
    if (['agent', 'support', 'human', 'help', 'representative', 'talk to agent', '3'].includes(lowerText)) {
      const session = chatSessionManager.getSession(cleanPhone);
      if (session.state === 'CHOOSING_PAYMENT_METHOD' && lowerText === '3') {
        chatSessionManager.handoverToSupport(cleanPhone);
        await botsailorClient.sendTextMessage(
          cleanPhone,
          `👩‍💼 *Live Customer Support*\n\nA customer care representative has been notified and will join this chat shortly to assist you.\n\n_(Type *MENU* anytime to resume automated shopping)._`
        );
        return;
      }

      if (['agent', 'support', 'human', 'representative', 'talk to agent'].some((k) => lowerText.includes(k))) {
        chatSessionManager.handoverToSupport(cleanPhone);
        await botsailorClient.sendTextMessage(
          cleanPhone,
          `👩‍💼 *Customer Support Assigned*\n\nOne of our human agents will attend to you here shortly.\n\n_(Type *MENU* anytime to return to the catalog)._`
        );
        return;
      }
    }

    // 3. Check for Reset / Menu Command
    if (['menu', 'start', 'restart', 'reset', 'hi', 'hello', 'hey'].includes(lowerText)) {
      chatSessionManager.resetSession(cleanPhone);
      await this.sendWelcomeMenu(cleanPhone);
      return;
    }

    // 4. Retrieve Current Conversation State
    const session = chatSessionManager.getSession(cleanPhone);

    // If session is already handed over to human support, don't interfere unless they type MENU
    if (session.state === 'HANDED_OVER_TO_SUPPORT') {
      logger.info(`User ${cleanPhone} is in human support mode. Ignoring bot automated processing.`);
      return;
    }

    // 5. Handling Payment Receipt Upload
    if (session.state === 'AWAITING_PAYMENT_RECEIPT' || (mediaUrl && (lowerText.includes('paid') || lowerText.includes('receipt') || lowerText.includes('transfer')))) {
      if (mediaUrl || lowerText.includes('paid') || lowerText.includes('done')) {
        if (session.context.pendingOrderNumber && mediaUrl) {
          await db.attachReceiptUrl(session.context.pendingOrderNumber, mediaUrl);
        }
        await botsailorClient.sendTextMessage(
          cleanPhone,
          `✅ *Payment Proof Received!*\n\nThank you for providing your receipt. Our accounts team will verify your transfer and your order will be dispatched promptly! 🚚✨\n\nOrder Ref: *${session.context.pendingOrderNumber || 'Pending'}*`
        );
        chatSessionManager.setState(cleanPhone, 'IDLE');
        return;
      }
    }

    // 6. State Machine Routing
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
        // Treat as a product search or category exploration
        await this.handleProductSearch(cleanPhone, cleanText);
        return;
    }
  }

  /**
   * Welcome Menu & Introduction
   */
  async sendWelcomeMenu(phoneNumber: string): Promise<void> {
    const categories = await catalogService.getCategories();
    let msg = `👋 *Welcome to ${config.STORE_NAME}!* 🛍️\n\n`;
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

    await botsailorClient.sendTextMessage(phoneNumber, msg);
  }

  /**
   * Search Products & Present Top Match with Variants
   */
  async handleProductSearch(phoneNumber: string, query: string): Promise<void> {
    if (!query || query.length < 2) {
      await this.sendWelcomeMenu(phoneNumber);
      return;
    }

    const results = await catalogService.search(query);

    if (results.length === 0) {
      let msg = `😕 Sorry, we couldn't find an exact match for *"${query}"*.\n\n`;
      msg += `Please try another keyword, or check our categories:\n`;
      msg += `1️⃣ *Kitchen Wares*\n`;
      msg += `2️⃣ *Agricultural Tools*\n`;
      msg += `3️⃣ *Home & Cleaning*\n\n`;
      msg += `_Or reply *SUPPORT* to have our representative check stock for you!_`;
      await botsailorClient.sendTextMessage(phoneNumber, msg);
      return;
    }

    // Top Match Found
    const topProduct = results[0];
    chatSessionManager.setCurrentProduct(phoneNumber, topProduct);

    const formatted = catalogService.formatProductMessage(topProduct);

    if (formatted.mediaUrl) {
      await botsailorClient.sendMediaMessage(phoneNumber, formatted.mediaUrl, 'image', formatted.text);
    } else {
      await botsailorClient.sendTextMessage(phoneNumber, formatted.text);
    }

    const variants = topProduct.variants || [];
    if (variants.length > 0) {
      chatSessionManager.setState(phoneNumber, 'SELECTING_VARIANT');
    } else {
      // No variants, move straight to payment method choice
      chatSessionManager.setState(phoneNumber, 'CHOOSING_PAYMENT_METHOD');
      await this.promptPaymentMethod(phoneNumber, topProduct.name, topProduct.base_price);
    }
  }

  /**
   * Handle Variant Selection (e.g. user replies '1', '2', etc.)
   */
  async handleVariantSelection(phoneNumber: string, text: string, session: any): Promise<void> {
    const product = session.context.currentProduct;
    if (!product || !product.variants || product.variants.length === 0) {
      await this.handleProductSearch(phoneNumber, text);
      return;
    }

    const choiceIdx = parseInt(text.replace(/\D/g, ''), 10) - 1;
    const variants = product.variants;

    if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= variants.length) {
      await botsailorClient.sendTextMessage(
        phoneNumber,
        `⚠️ Please reply with a valid option number between *1* and *${variants.length}*.`
      );
      return;
    }

    const selectedVariant = variants[choiceIdx];
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
   * Prompt Payment Method (POD vs Bank Transfer)
   */
  async promptPaymentMethod(phoneNumber: string, productName: string, price: number, variantText?: string): Promise<void> {
    const formattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(price);

    let msg = `💳 *HOW WOULD YOU LIKE TO PAY?*\n\n`;
    msg += `1️⃣ *Pay on Delivery (POD)*\n`;
    msg += `   _Pay ${formattedPrice} cash or instant transfer to our delivery rider at your doorstep._\n\n`;
    msg += `2️⃣ *Pay Now (Bank Transfer)*\n`;
    msg += `   _Transfer directly to our official company bank account now._\n\n`;
    msg += `3️⃣ *Talk to Human Support*\n\n`;
    msg += `👉 *Reply with 1, 2, or 3 to proceed.*`;

    await botsailorClient.sendTextMessage(phoneNumber, msg);
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

    const confirmationMsg = orderService.formatOrderConfirmation(order);
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
}

export const chatFlowEngine = new ChatFlowEngine();
