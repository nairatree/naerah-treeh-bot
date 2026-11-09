import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { catalogService } from '../src/modules/catalog/catalogService.ts';
import { orderService } from '../src/modules/orders/orderService.ts';
import { chatSessionManager } from '../src/modules/chat/chatSessionManager.ts';
import { chatFlowEngine } from '../src/modules/chat/chatFlowEngine.ts';
import { followupService } from '../src/modules/followup/followupService.ts';
import {
  isOutboundAgentMessage,
  extractTargetRecipientPhone,
  handleBotSailorWebhook,
  findMediaInPayload,
  isProtocolOrRevokeEvent,
  sanitizeBotSailorText,
} from '../src/modules/webhooks/botsailorWebhook.ts';
import { systemSettings } from '../src/modules/system/systemSettings.ts';
import { db } from '../src/database/supabaseClient.ts';
import { config } from '../src/config/environment.ts';

describe('NairaTree Stores E-Commerce Chatbot Engine Tests', () => {
  before(async () => {
    // Seed fresh test products and order
    await db.createProduct(
      {
        name: 'Premium Wooden Chopping Board',
        category_name: 'Kitchen Wares',
        description: 'High-density, durable hardwood chopping board with anti-bacterial juice groove.',
        base_price: 8500,
        media_urls: ['https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=800'],
        tags: ['kitchen', 'chopping board', 'wood', 'cutting board'],
      },
      [
        { sku: 'KT-CHOP-MED-NAT', size: 'Medium (30x20cm)', color: 'Natural Wood', price: 8500, stock_quantity: 50 },
        { sku: 'KT-CHOP-LRG-NAT', size: 'Large (40x28cm)', color: 'Natural Wood', price: 12000, stock_quantity: 30 },
      ]
    );

    await db.createProduct(
      {
        name: 'Heavy-Duty 2-in-1 Knapsack Sprayer',
        category_name: 'Agricultural Tools',
        description: 'Rechargeable electric and manual backpack sprayer with brass lance.',
        base_price: 28000,
        media_urls: ['https://images.unsplash.com/photo-1592417817098-8f3d6910985c?w=800'],
        tags: ['agriculture', 'sprayer', 'knapsack', 'farming'],
      },
      [
        { sku: 'AG-SPRAY-16L-BLU', size: '16 Litres', color: 'Electric Blue', price: 28000, stock_quantity: 40 },
        { sku: 'AG-SPRAY-20L-YEL', size: '20 Litres Jumbo', color: 'Safety Yellow', price: 34000, stock_quantity: 18 },
      ]
    );

    await db.createOrder({
      order_number: 'NT-2026-1001',
      customer_name: 'Chinedu Okafor',
      customer_phone: '2348031234567',
      delivery_address: '14 Admiralty Way, Lekki Phase 1',
      city_state: 'Lagos State',
      items: [
        {
          product_id: 'prod-test-1',
          product_name: 'Premium Wooden Chopping Board',
          size: 'Medium (30x20cm)',
          color: 'Natural Wood',
          unit_price: 8500,
          quantity: 1,
          subtotal: 8500,
        },
      ],
      total_amount: 8500,
      payment_method: 'POD',
      payment_status: 'UNPAID',
      order_status: 'CONFIRMED',
    });
  });

  after(async () => {
    // Purge all test products and orders so live database remains completely fresh and clean
    const products = await db.getProducts();
    for (const p of products) {
      await db.deleteProduct(p.id);
    }
    if (config.isLiveSupabase) {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
      await sb.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await sb.from('product_variants').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await sb.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    }
    // Ensure master bot switch remains ON as requested by merchant
    await db.updateStoreSettings({ is_bot_active: true });
  });
  test('1. Catalog Search & Short Punchy Multi-Variant Presentation', async () => {
    const results = await catalogService.search('chopping board');
    assert.ok(results.length > 0, 'Should find chopping board product');
    const product = results[0];
    assert.strictEqual(product.name, 'Premium Wooden Chopping Board');
    assert.ok(product.variants && product.variants.length > 0, 'Product must have multi-variants');

    // Test formatted message is short & punchy
    const formatted = catalogService.formatProductMessage(product);
    assert.ok(formatted.text.includes('PREMIUM WOODEN CHOPPING BOARD'));
    assert.ok(formatted.text.includes('Price:'));
    assert.ok(formatted.text.includes('Option 1') || formatted.text.includes('1️⃣'));
    assert.ok(!formatted.text.includes('Category:'), 'Should be clean and concise without bulky category labels');
  });

  test('2. Address & Quantity Parser from Natural User WhatsApp Message', () => {
    const rawMessage = `My name is Joy Adebayo\nPhone: 08031112233\nAddress: 15 Admiralty Way, Lekki Phase 1, Lagos\nQuantity: 2 pieces`;
    const parsed = orderService.parseAddressMessage(rawMessage, '2348031112233');

    assert.strictEqual(parsed.name, 'Joy Adebayo');
    assert.strictEqual(parsed.phone, '08031112233');
    assert.ok(parsed.address.includes('Admiralty Way'), 'Should extract full street address');
    assert.strictEqual(parsed.quantity, 2, 'Should extract quantity of 2 pieces');
  });

  test('3. Master Killswitch: Silently Drops Messages When Paused', async () => {
    await db.updateStoreSettings({ is_bot_active: false });
    const testPhone = '2348055443322';
    chatSessionManager.resetSession(testPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'I want to buy chopping board',
    });

    const session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session must remain IDLE when bot is paused');
  });

  test('4. Anti-Interference Shield: Casual Messages Ignored, Store Inquiries Processed', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const casualPhone = '2348077665544';
    chatSessionManager.resetSession(casualPhone);

    // Casual messages from friends or family
    await chatFlowEngine.processInboundMessage({
      phoneNumber: casualPhone,
      text: 'Bro, where are you guys right now?',
    });

    let session = chatSessionManager.getSession(casualPhone);
    assert.strictEqual(session.state, 'IDLE', 'Casual chat must be ignored and stay IDLE');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: casualPhone,
      text: 'Good morning, hope the kids are fine?',
    });
    session = chatSessionManager.getSession(casualPhone);
    assert.strictEqual(session.state, 'IDLE', 'Casual greeting must not trigger bot flow');
  });

  test('5. New Streamlined Flow: Product -> Variant -> Quantity -> Address -> Staff Alert', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const testPhone = '2348099887766';
    chatSessionManager.resetSession(testPhone);

    // Step A: Customer arrives searching for Knapsack Sprayer
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'I want knapsack sprayer',
    });

    let session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'SELECTING_VARIANT', 'State must advance to variant selection');
    assert.ok(session.context.currentProduct, 'Current product should be set');

    // Verify lead is recorded as pending address
    let lead = await followupService.getLead(testPhone);
    assert.ok(lead, 'Lead should be tracked in follow-up system');
    assert.strictEqual(lead?.status, 'PENDING_ADDRESS');

    // Step B: Customer picks Variant Option 1 (16L Electric Blue)
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: '1',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'AWAITING_QUANTITY', 'State must advance to quantity selection (No payment options)');
    assert.ok(session.context.selectedVariant, 'Selected variant must be recorded');

    // Step C: Customer chooses 2 pieces
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: '2',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'AWAITING_DELIVERY_DETAILS', 'State must advance to delivery address submission');
    assert.strictEqual(session.context.selectedQuantity, 2);

    // Step D: Customer provides Delivery Details
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'Name: Emeka Eze\nPhone: 08022223344\nAddress: 24 Broad Street, Marina, Lagos',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Session should hand over to staff after address submission');

    // Verify lead is marked as PURCHASED (Follow-up stopped!)
    lead = await followupService.getLead(testPhone);
    assert.strictEqual(lead?.status, 'PURCHASED', 'Lead must be marked as PURCHASED so follow-ups stop');

    // Verify order was saved to database with pending staff delivery fee
    const orders = await db.getOrders();
    const createdOrder = orders.find((o) => o.customer_name === 'Emeka Eze');
    assert.ok(createdOrder, 'Order must be saved in database');
    assert.strictEqual(createdOrder.items[0].quantity, 2, 'Order must reflect 2 pieces');
    assert.strictEqual(createdOrder.total_amount, 56000, 'Total should be 28,000 * 2 = 56,000');
    assert.strictEqual(createdOrder.order_status, 'PENDING', 'Order status should be PENDING awaiting delivery quote');
  });

  test('6. Follow-up Engine & Objection Handling', async () => {
    const shopperPhone = '2348033221100';
    chatSessionManager.resetSession(shopperPhone);

    // Customer searches but does not complete address
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'chopping board',
    });

    let lead = await followupService.getLead(shopperPhone);
    assert.ok(lead);
    assert.strictEqual(lead?.status, 'PENDING_ADDRESS');

    // Customer says "not interested" / "no"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'not interested',
    });

    lead = await followupService.getLead(shopperPhone);
    assert.strictEqual(lead?.status, 'OPTED_OUT', 'Lead must be opted out cleanly when stating no');
  });

  test('7. Bulk CSV Catalog Import with Variants Generator', async () => {
    const sampleCSV = `Category,Name,Price,Sizes,Colors,Description,Image_URL
Kitchen Wares,Non-Stick Frying Pan,15000,"Small (20cm), Large (28cm)","Matte Black, Crimson Red","Granite coating pan with induction base",https://example.com/pan.jpg`;

    const result = await catalogService.bulkImportFromCSV(sampleCSV);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.successful, 1);

    const search = await catalogService.search('Non-Stick Frying Pan');
    assert.ok(search.length > 0);
    const pan = search[0];
    assert.strictEqual(pan.variants?.length, 4, 'Should auto-generate 4 color/size combinations');
  });

  test('8. Hybrid Model: Smart 2-Line Greeting for Standalone Greetings ("Hi", "Good morning")', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const greetingPhone = '2348011223344';
    chatSessionManager.resetSession(greetingPhone);

    // Prospective buyer sends "Hi"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: greetingPhone,
      text: 'Hi',
    });

    let session = chatSessionManager.getSession(greetingPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after smart greeting');

    // Prospective buyer sends "Good morning"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: greetingPhone,
      text: 'Good morning',
    });
    session = chatSessionManager.getSession(greetingPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after smart greeting');

    // Prospective buyer taps "Enter Product Name" button
    await chatFlowEngine.processInboundMessage({
      phoneNumber: greetingPhone,
      text: 'Enter Product Name',
    });
    session = chatSessionManager.getSession(greetingPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE while prompting for product name');

    // Prospective buyer now replies with product name
    await chatFlowEngine.processInboundMessage({
      phoneNumber: greetingPhone,
      text: 'wooden chopping board',
    });
    session = chatSessionManager.getSession(greetingPhone);
    assert.strictEqual(session.state, 'SELECTING_VARIANT', 'Advances to product variant selection');

    // Test "View Catalog" button tap
    const catalogUserPhone = '2348011998877';
    chatSessionManager.resetSession(catalogUserPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: catalogUserPhone,
      text: 'View Catalog',
    });
    session = chatSessionManager.getSession(catalogUserPhone);
    assert.strictEqual(session.state, 'IDLE');

    // Test "Staff" button tap
    const staffUserPhone = '2348011998866';
    chatSessionManager.resetSession(staffUserPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: staffUserPhone,
      text: 'Staff',
    });
    session = chatSessionManager.getSession(staffUserPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Staff button must handover to support');

    // Test tapping "📂 MENU" button while handed over to support
    await chatFlowEngine.processInboundMessage({
      phoneNumber: staffUserPhone,
      text: '📂 MENU',
    });
    session = chatSessionManager.getSession(staffUserPhone);
    assert.strictEqual(session.state, 'IDLE', 'Tapping MENU button must resume shopping flow');
  });

  test('9. Hybrid Model: Post-Purchase Delivery Status Handler', async () => {
    await db.updateStoreSettings({ is_bot_active: true });

    // Test delivery inquiry recognition helper
    assert.ok(orderService.isDeliveryInquiry('When will you be doing the delivery?'));
    assert.ok(orderService.isDeliveryInquiry('Good morning, when will my products be ready?'));
    assert.ok(orderService.isDeliveryInquiry('Where is my order?'));
    assert.ok(orderService.isDeliveryInquiry('track order NT-2026-1001'));
    assert.strictEqual(orderService.isDeliveryInquiry('Bro, where are you guys right now?'), false);
    assert.strictEqual(orderService.isDeliveryInquiry('Good morning, hope the kids are fine?'), false);

    // Existing buyer from MOCK_ORDERS (2348031234567, order NT-2026-1001)
    const existingBuyerPhone = '2348031234567';
    chatSessionManager.resetSession(existingBuyerPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: existingBuyerPhone,
      text: 'When will you be doing the delivery?',
    });

    let session = chatSessionManager.getSession(existingBuyerPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Transfers to staff after answering delivery status');

    // Unknown buyer checks delivery status
    const unknownPhone = '2348099112233';
    chatSessionManager.resetSession(unknownPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: unknownPhone,
      text: 'When is my delivery?',
    });

    session = chatSessionManager.getSession(unknownPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Transfers to staff after reassuring customer');

    // Ensure bot stays active
    await db.updateStoreSettings({ is_bot_active: true });
  });

  test('10. Unavailable Product Search: Sends clean notice with Staff, VIP Group, and Menu buttons', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const userPhone = '2348011226688';
    chatSessionManager.resetSession(userPhone);

    // Customer searches for a product not in stock
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'I want bluetooth speaker',
    });

    let session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after unavailable product notification');
    assert.strictEqual(session.context.lastPrompt, 'UNAVAILABLE');
    assert.strictEqual(session.context.lastSearchedQuery, 'bluetooth speaker');

    // Customer taps "Join VIP Group" (buttonPayload: 'group')
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'Join VIP Group',
      buttonPayload: 'group',
    });
    session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after sending group link');

    // Reset and trigger unavailable again
    chatSessionManager.resetSession(userPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'I want bluetooth speaker',
    });

    // Customer taps "Talk to Staff" (buttonPayload: 'staff')
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'Talk to Staff',
      buttonPayload: 'staff',
    });
    session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Transfers to staff and alerts merchant');

    // Customer taps "Main Menu" (buttonPayload: 'menu') while handed over
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'Main Menu',
      buttonPayload: 'menu',
    });
    session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE', 'Resumes shopping flow on Main Menu tap');

    // Customer sends fallback numeric options: '2' for VIP group
    chatSessionManager.resetSession(userPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'wireless earbuds',
    });
    assert.strictEqual(chatSessionManager.getSession(userPhone).context.lastPrompt, 'UNAVAILABLE');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: '2',
    });
    assert.strictEqual(chatSessionManager.getSession(userPhone).state, 'IDLE');

    // Customer sends fallback numeric options: '1' for Talk to Staff
    chatSessionManager.resetSession(userPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: 'electric drone',
    });
    assert.strictEqual(chatSessionManager.getSession(userPhone).context.lastPrompt, 'UNAVAILABLE');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: '1',
    });
    assert.strictEqual(chatSessionManager.getSession(userPhone).state, 'HANDED_OVER_TO_SUPPORT');

    // Ensure bot stays active
    await db.updateStoreSettings({ is_bot_active: true });
  });

  test('11. Solution 1: Past-Tense & Complaint Gate Intercepts "I ordered for a plate last week"', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const pastBuyerPhone = '2348022334455';
    chatSessionManager.resetSession(pastBuyerPhone);

    // Scenario 1: Customer mentions past order ("Oh, I ordered for a plate last week")
    await chatFlowEngine.processInboundMessage({
      phoneNumber: pastBuyerPhone,
      text: 'Oh, I ordered for a plate last week',
    });

    let session = chatSessionManager.getSession(pastBuyerPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Must intercept past order and handover to staff');
    assert.strictEqual(session.context.currentProduct, undefined, 'Must NOT trigger product selling flow');

    // Scenario 2: Complaint about damaged goods ("My plate arrived broken yesterday")
    const complaintPhone = '2348022334466';
    chatSessionManager.resetSession(complaintPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: complaintPhone,
      text: 'My plate arrived broken yesterday',
    });

    session = chatSessionManager.getSession(complaintPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Must intercept complaint and handover to staff');

    // Scenario 3: Payment follow-up ("I paid for the plate this morning")
    const paidPhone = '2348022334477';
    chatSessionManager.resetSession(paidPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: paidPhone,
      text: 'I paid for the plate this morning',
    });

    session = chatSessionManager.getSession(paidPhone);
    assert.strictEqual(session.state, 'HANDED_OVER_TO_SUPPORT', 'Must intercept payment follow-up and handover to staff');

    await db.updateStoreSettings({ is_bot_active: true });
  });

  test('12. Solution 1: Conversational Long-Sentence Gate vs Explicit Buying Intent', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const shopperPhone = '2348033445566';
    chatSessionManager.resetSession(shopperPhone);

    // Conversational chatter with product noun but NO buying intent (> 3 words)
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'My friend was talking about chopping boards at work',
    });

    let session = chatSessionManager.getSession(shopperPhone);
    assert.strictEqual(session.state, 'IDLE', 'Must stay IDLE and NOT show product when no buying intent exists');

    // Explicit buying intent in longer sentence ("How much is the chopping board?")
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'How much is the chopping board?',
    });

    session = chatSessionManager.getSession(shopperPhone);
    assert.strictEqual(session.state, 'SELECTING_VARIANT', 'Must show product when buying intent is present');
    assert.ok(session.context.currentProduct, 'Product must be matched');

    // Short query (<= 3 words, e.g. "Chopping board")
    const directPhone = '2348033445577';
    chatSessionManager.resetSession(directPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: directPhone,
      text: 'Chopping board',
    });

    session = chatSessionManager.getSession(directPhone);
    assert.strictEqual(session.state, 'SELECTING_VARIANT', 'Direct short query must trigger product presentation');

    await db.updateStoreSettings({ is_bot_active: true });
  });

  test('13. Meta Ads Trigger & Hello T-Bot / Teebot Name Greeting', async () => {
    await db.updateStoreSettings({ is_bot_active: true });

    // 1. Customer initiates chat with "Hello T-Bot"
    const tbotPhone = '2348044556677';
    chatSessionManager.resetSession(tbotPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: tbotPhone,
      text: 'Hello T-Bot',
    });

    let session = chatSessionManager.getSession(tbotPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after Hello T-Bot welcome greeting');

    // 2. Customer initiates chat with "Teebot"
    const teebotPhone = '2348044556688';
    chatSessionManager.resetSession(teebotPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: teebotPhone,
      text: 'Teebot',
    });

    session = chatSessionManager.getSession(teebotPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session stays IDLE after Teebot welcome greeting');

    // 3. Meta Ads Trigger: "I want to buy the chopping board you advertised"
    const adBuyerPhone = '2348044556699';
    chatSessionManager.resetSession(adBuyerPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: adBuyerPhone,
      text: 'I want to buy the chopping board you advertised',
    });

    session = chatSessionManager.getSession(adBuyerPhone);
    assert.strictEqual(session.state, 'SELECTING_VARIANT', 'Ad prefilled text must match product and show variants');
    assert.strictEqual(session.context.currentProduct?.name, 'Premium Wooden Chopping Board');

    // 4. Meta Ads Trigger for Out-of-Stock / Unmatched Product: "I want to buy the luxury wristwatch you advertised"
    const unavailableAdPhone = '2348044556600';
    chatSessionManager.resetSession(unavailableAdPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: unavailableAdPhone,
      text: 'I want to buy the luxury wristwatch you advertised',
    });

    session = chatSessionManager.getSession(unavailableAdPhone);
    assert.strictEqual(session.state, 'IDLE', 'Must stay IDLE and offer Unavailable buttons (Staff, VIP Group, Menu)');

    // Ensure bot returns to merchant's intended state: ON!
    await db.updateStoreSettings({ is_bot_active: true });
  });

  test('14. Layer 1: Outbound & Echo Blocker Detects All Agent / Coexistence Echoes', () => {
    // 1. from_me: true
    assert.strictEqual(isOutboundAgentMessage({ from_me: true }), true);
    assert.strictEqual(isOutboundAgentMessage({ message: { from_me: true } }), true);

    // 2. direction: 'outbound' / 'outgoing' / is_outbound / is_echo
    assert.strictEqual(isOutboundAgentMessage({ direction: 'outbound' }), true);
    assert.strictEqual(isOutboundAgentMessage({ direction: 'outgoing' }), true);
    assert.strictEqual(isOutboundAgentMessage({ is_outbound: true }), true);
    assert.strictEqual(isOutboundAgentMessage({ is_echo: true }), true);
    assert.strictEqual(isOutboundAgentMessage({ message: { is_echo: true } }), true);

    // 3. Meta Cloud API coexistence fields
    assert.strictEqual(isOutboundAgentMessage({ entry: [{ changes: [{ field: 'smb_message_echoes' }] }] }), true);
    assert.strictEqual(isOutboundAgentMessage({ entry: [{ changes: [{ value: { message_echoes: [{ to: '2348011223344' }] } }] }] }), true);
    assert.strictEqual(isOutboundAgentMessage({ entry: [{ changes: [{ value: { messages: [{ from_me: true }] } }] }] }), true);

    // 4. BotSailor / CRM events
    assert.strictEqual(isOutboundAgentMessage({ event: 'message_sent' }), true);
    assert.strictEqual(isOutboundAgentMessage({ event: 'outgoing_message' }), true);
    assert.strictEqual(isOutboundAgentMessage({ event: 'agent_reply' }), true);
    assert.strictEqual(isOutboundAgentMessage({ event: 'live_chat_message' }), true);

    // 5. Sender role
    assert.strictEqual(isOutboundAgentMessage({ sender_type: 'agent' }), true);
    assert.strictEqual(isOutboundAgentMessage({ sender_type: 'business' }), true);
    assert.strictEqual(isOutboundAgentMessage({ source: 'live_chat' }), true);

    // 6. Normal customer inbound message MUST return false
    assert.strictEqual(isOutboundAgentMessage({
      chat_id: '2348011223344',
      message: 'Hello, how much is the chopping board?',
    }), false);
    assert.strictEqual(isOutboundAgentMessage({
      entry: [{ changes: [{ value: { messages: [{ from: '2348011223344', text: { body: 'Hello' } }] } }] }],
    }), false);

    // Test target recipient phone extractor
    assert.strictEqual(extractTargetRecipientPhone({ recipient: '2348011223344' }), '2348011223344');
    assert.strictEqual(extractTargetRecipientPhone({ to: '2348011223344' }), '2348011223344');
    assert.strictEqual(extractTargetRecipientPhone({
      entry: [{ changes: [{ value: { message_echoes: [{ to: '2348011223344' }] } }] }],
    }), '2348011223344');
  });

  test('15. Layer 1 & 2: Agent Outbound Echo Drops Message & Activates 24-Hour Human Takeover', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const customerPhone = '2348055667788';
    chatSessionManager.resetSession(customerPhone);
    chatSessionManager.clearHumanTakeover(customerPhone);

    // Customer was in the middle of a checkout flow (SELECTING_VARIANT)
    chatSessionManager.setState(customerPhone, 'SELECTING_VARIANT');
    chatSessionManager.setCurrentProduct(customerPhone, {
      id: 'test-p1',
      name: 'Premium Wooden Chopping Board',
      category_name: 'Kitchen',
      base_price: 8500,
      description: 'Test',
      media_urls: [],
      is_available: true,
    });
    assert.strictEqual(chatSessionManager.getSession(customerPhone).state, 'SELECTING_VARIANT');

    // Agent manually sends a message from WhatsApp Business App / Coexistence
    let responseCode = 0;
    let responseData: any = null;
    const fakeReq = {
      body: {
        event: 'smb_message_echoes',
        direction: 'outbound',
        recipient: customerPhone,
        message: { text: 'Hello, we have the board in stock. What address should we send it to?' },
      },
    } as any;
    const fakeRes = {
      status(code: number) { responseCode = code; return this; },
      json(data: any) { responseData = data; return this; },
    } as any;

    await handleBotSailorWebhook(fakeReq, fakeRes);

    // Layer 1 Verification: Outbound echo was immediately dropped
    assert.strictEqual(responseCode, 200);
    assert.strictEqual(responseData.status, 'ignored');
    assert.strictEqual(responseData.reason, 'outbound_agent_echo');

    // Layer 2 Verification: Human Takeover is now active for 24 hours
    assert.strictEqual(chatSessionManager.isHumanTakeoverActive(customerPhone), true);

    // Layer 2 Verification: Customer active session was reset to IDLE (no questionnaires firing)
    const session = chatSessionManager.getSession(customerPhone);
    assert.strictEqual(session.state, 'IDLE', 'Customer session must be reset to IDLE upon human takeover');
  });

  test('16. Layer 2: Customer Messages While Muted Produce 0 Bot Responses Until "menu"', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const customerPhone = '2348055667788';

    // Verify takeover is active
    assert.strictEqual(chatSessionManager.isHumanTakeoverActive(customerPhone), true);

    // Customer sends normal conversational replies to the agent
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'Okay, can I get it tomorrow?',
    });
    assert.strictEqual(chatSessionManager.getSession(customerPhone).state, 'IDLE');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'How much is delivery to Lekki?',
    });
    assert.strictEqual(chatSessionManager.getSession(customerPhone).state, 'IDLE');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'Where is your store located?',
    });
    assert.strictEqual(chatSessionManager.getSession(customerPhone).state, 'IDLE');

    // Customer explicitly types "menu" to resume chatbot
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'menu',
    });

    // Verification: Human takeover was cleared and bot resumed
    assert.strictEqual(chatSessionManager.isHumanTakeoverActive(customerPhone), false);
    assert.strictEqual(chatSessionManager.getSession(customerPhone).state, 'IDLE');
  });

  test('17. Layer 3: Master Bot Killswitch Completely Disables Bot When Toggled OFF', async () => {
    // Toggle OFF via settings
    await db.updateStoreSettings({ is_bot_active: false });
    const shopperPhone = '2348066778899';
    chatSessionManager.resetSession(shopperPhone);

    let responseCode = 0;
    let responseData: any = null;
    const fakeReq = {
      body: {
        chat_id: shopperPhone,
        text: 'I want to buy chopping board',
      },
    } as any;
    const fakeRes = {
      status(code: number) { responseCode = code; return this; },
      json(data: any) { responseData = data; return this; },
    } as any;

    await handleBotSailorWebhook(fakeReq, fakeRes);

    // Webhook must drop message immediately
    assert.strictEqual(responseCode, 200);
    assert.strictEqual(responseData.status, 'ignored');
    assert.strictEqual(responseData.reason, 'bot_globally_disabled');

    // Direct engine test when killswitch is active
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'I want to buy chopping board',
    });
    assert.strictEqual(chatSessionManager.getSession(shopperPhone).state, 'IDLE');

    // Re-enable bot via settings
    await db.updateStoreSettings({ is_bot_active: true });
    const settings = await db.getStoreSettings();
    assert.strictEqual(settings.is_bot_active, true);
  });

  test('18. Layer 2: Admin API Manual Unpause & Human Takeover Inspection', () => {
    const phone = '2348099001122';
    chatSessionManager.activateHumanTakeover(phone);
    assert.strictEqual(chatSessionManager.isHumanTakeoverActive(phone), true);

    const activeList = chatSessionManager.getActiveHumanTakeovers();
    assert.ok(activeList.some(item => item.phoneNumber === phone));

    // Admin clears human takeover manually
    chatSessionManager.clearHumanTakeover(phone);
    assert.strictEqual(chatSessionManager.isHumanTakeoverActive(phone), false);
  });

  test('19. Photo Search Assistant: Handles Screenshots, Generic Inquiries & Passes Photo to Staff', async () => {
    const shopperPhone = '2348088990011';
    chatSessionManager.resetSession(shopperPhone);

    // Scenario A: Customer sends screenshot without text
    const screenshotUrl = 'https://example.com/ad-screenshot-123.jpg';
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: '',
      mediaUrl: screenshotUrl,
    });

    const sessionA = chatSessionManager.getSession(shopperPhone);
    assert.strictEqual(sessionA.context.lastSentMediaUrl, screenshotUrl);
    assert.strictEqual(sessionA.context.lastPrompt, 'PHOTO_INQUIRY');

    // Scenario B: Customer taps "Talk to Staff"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      buttonPayload: 'staff',
    });

    const sessionB = chatSessionManager.getSession(shopperPhone);
    assert.strictEqual(sessionB.state, 'HANDED_OVER_TO_SUPPORT');
    assert.strictEqual(sessionB.context.lastSentMediaUrl, screenshotUrl);

    // Scenario C: Another customer sends photo with generic inquiry "Do you have this?"
    const shopperPhone2 = '2348088990022';
    chatSessionManager.resetSession(shopperPhone2);
    const photoUrl2 = 'https://example.com/product-snapshot.jpg';

    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone2,
      text: 'Do you have this?',
      mediaUrl: photoUrl2,
    });

    const sessionC = chatSessionManager.getSession(shopperPhone2);
    assert.strictEqual(sessionC.context.lastSentMediaUrl, photoUrl2);
    assert.strictEqual(sessionC.context.lastPrompt, 'PHOTO_INQUIRY');

    // Customer taps "Enter Product Name"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone2,
      buttonPayload: 'enter_product',
    });
    assert.strictEqual(chatSessionManager.getSession(shopperPhone2).context.awaitingProductSearch, true);

    // Customer types "chopping board"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone2,
      text: 'chopping board',
    });

    const sessionD = chatSessionManager.getSession(shopperPhone2);
    assert.strictEqual(sessionD.state, 'SELECTING_VARIANT');
    assert.ok(sessionD.context.currentProduct);
    assert.strictEqual(sessionD.context.currentProduct.name, 'Premium Wooden Chopping Board');

    // Scenario D: Customer sends photo with explicit product name in caption
    const shopperPhone3 = '2348088990033';
    chatSessionManager.resetSession(shopperPhone3);
    const photoUrl3 = 'https://example.com/knapsack-photo.jpg';

    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone3,
      text: 'I want this knapsack sprayer you advertised',
      mediaUrl: photoUrl3,
    });

    const sessionE = chatSessionManager.getSession(shopperPhone3);
    assert.strictEqual(sessionE.state, 'SELECTING_VARIANT');
    assert.ok(sessionE.context.currentProduct);
    assert.strictEqual(sessionE.context.currentProduct.name, 'Heavy-Duty 2-in-1 Knapsack Sprayer');
    assert.strictEqual(sessionE.context.lastSentMediaUrl, photoUrl3);
  });

  test('20. Layer 3: Stale CRM Profile & Custom Fields Isolation', async () => {
    // 1. Webhook payload containing historical custom_fields with an old receipt/attachment
    const payloadWithStaleCRM = {
      chat_id: '2348077112233',
      text: 'hello',
      subscriber: {
        first_name: 'Blessing',
        custom_fields: {
          past_receipt_url: 'https://example.com/stale-crm-receipt.jpg',
          delivery_slip: 'https://example.com/stale-slip.jpg',
        },
      },
      custom_fields: {
        old_attachment: 'https://example.com/stale-attachment.jpg',
      },
    };

    // Verify media extractor refuses to scan passive CRM keys
    const extractedMedia = findMediaInPayload(payloadWithStaleCRM);
    assert.strictEqual(extractedMedia, undefined, 'Must NEVER extract media from passive subscriber CRM fields');

    // 2. Engine guard: Even if a stale mediaUrl is passed with "hello", it must NOT trigger photo inquiry
    const testPhone = '2348077112233';
    chatSessionManager.resetSession(testPhone);

    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'hello',
      mediaUrl: 'https://example.com/stale-receipt.jpg', // Stale CRM media
    });

    const session = chatSessionManager.getSession(testPhone);
    // Session should remain IDLE (smart greeting sent), NOT locked into PHOTO_INQUIRY
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'PHOTO_INQUIRY');
  });

  test('21. Layer 4: Session Inactivity Timeout (2 Hours) Automatically Resets Session to IDLE', () => {
    const testPhone = '2348077445566';
    chatSessionManager.resetSession(testPhone);

    // Put customer in middle of checkout
    chatSessionManager.setState(testPhone, 'AWAITING_DELIVERY_DETAILS');
    const session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'AWAITING_DELIVERY_DETAILS');

    // Simulate 2.5 hours of inactivity (> 2 hours timeout)
    const twoAndHalfHoursAgo = Date.now() - (2.5 * 60 * 60 * 1000);
    session.updatedAt = twoAndHalfHoursAgo;

    // Accessing session after timeout triggers auto-reset
    const refreshedSession = chatSessionManager.getSession(testPhone);
    assert.strictEqual(refreshedSession.state, 'IDLE', 'Session must auto-reset to IDLE after 2 hours of inactivity');
  });

  test('22. Layer 4: Customer In Uncompleted Checkout Returning With "Hello Good Morning" Resets to IDLE & Presents Main Menu (Never Demands Address)', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const shopperPhone = '2348077889900';
    chatSessionManager.resetSession(shopperPhone);

    // Customer was in the middle of awaiting address
    chatSessionManager.setState(shopperPhone, 'AWAITING_DELIVERY_DETAILS');
    chatSessionManager.setCurrentProduct(shopperPhone, {
      id: 'prod-test-chop',
      name: 'Premium Wooden Chopping Board',
      category_name: 'Kitchen',
      base_price: 8500,
      description: 'Teak board',
      media_urls: [],
      is_available: true,
    });
    chatSessionManager.setSelectedQuantity(shopperPhone, 2);

    assert.strictEqual(chatSessionManager.getSession(shopperPhone).state, 'AWAITING_DELIVERY_DETAILS');

    // Customer returns later and says "hello good morning"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: shopperPhone,
      text: 'hello good morning',
    });

    // Verification: Session was cleanly auto-reset to IDLE and did NOT demand delivery address
    const session = chatSessionManager.getSession(shopperPhone);
    assert.strictEqual(session.state, 'IDLE', 'Returning customer greeting must cleanly reset uncompleted flow to IDLE');
    assert.strictEqual(session.context.selectedQuantity, undefined, 'Temporary uncommitted drafts must be cleared');
  });

  test('23. Layer 4 & 5: Universal Reset Commands ("reset", "clear", "cancel") & SystemSettings Singleton', async () => {
    // 1. Verify SystemSettings singleton
    const isActive = await systemSettings.isBotGloballyActive();
    assert.strictEqual(isActive, true);

    await systemSettings.setBotGloballyActive(false, 'Maintenance test');
    assert.strictEqual(await systemSettings.isBotGloballyActive(), false);

    await systemSettings.setBotGloballyActive(true, 'Test restore');
    assert.strictEqual(await systemSettings.isBotGloballyActive(), true);

    // 2. Verify Universal Reset Commands across active states
    const testPhone = '2348077332211';
    chatSessionManager.resetSession(testPhone);

    // In SELECTING_VARIANT state, user types "reset"
    chatSessionManager.setState(testPhone, 'SELECTING_VARIANT');
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'reset',
    });
    assert.strictEqual(chatSessionManager.getSession(testPhone).state, 'IDLE');

    // In AWAITING_QUANTITY state, user types "clear"
    chatSessionManager.setState(testPhone, 'AWAITING_QUANTITY');
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'clear',
    });
    assert.strictEqual(chatSessionManager.getSession(testPhone).state, 'IDLE');

    // In AWAITING_DELIVERY_DETAILS state, user types "start over"
    chatSessionManager.setState(testPhone, 'AWAITING_DELIVERY_DETAILS');
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'start over',
    });
    assert.strictEqual(chatSessionManager.getSession(testPhone).state, 'IDLE');
  });

  test('24. Webhook Revocation & Protocol Event Blocker: Prevents infinite delete loops on "#ATTACHMENT:revoke#"', async () => {
    // 1. Verify isProtocolOrRevokeEvent detects BotSailor revoke strings and protocol messages
    assert.strictEqual(isProtocolOrRevokeEvent({ message: '#ATTACHMENT:revoke# |caption:' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ text: 'revoke' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ type: 'protocol' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ type: 'reaction' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ type: 'edit' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ event: 'message_edit' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ message: 'You deleted this message' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ message: '#ATTACHMENT:edit# |caption:new text' }), true);
    assert.strictEqual(isProtocolOrRevokeEvent({ message: 'I want to buy chopping board' }), false);

    // 2. Verify sanitizeBotSailorText cleanly extracts revoke status and strips wrappers
    const revokeSanitized = sanitizeBotSailorText('#ATTACHMENT:revoke# |caption:');
    assert.strictEqual(revokeSanitized.isRevoke, true);
    assert.strictEqual(revokeSanitized.cleanText, '');

    const editSanitized = sanitizeBotSailorText('#ATTACHMENT:edit# |caption:updated');
    assert.strictEqual(editSanitized.isRevoke, true);
    assert.strictEqual(editSanitized.cleanText, '');

    const imageSanitized = sanitizeBotSailorText('#ATTACHMENT:https://example.com/item.jpg# |caption:How much is this?');
    assert.strictEqual(imageSanitized.isRevoke, false);
    assert.strictEqual(imageSanitized.cleanText, 'How much is this?');
    assert.strictEqual(imageSanitized.attachmentUrl, 'https://example.com/item.jpg');

    // 3. Verify handleBotSailorWebhook safely ignores revoke events with HTTP 200 without triggering bot search
    let responseStatus = 0;
    let responseBody: any = null;
    const mockRes = {
      status(code: number) {
        responseStatus = code;
        return {
          json(body: any) {
            responseBody = body;
          },
        };
      },
    } as any;

    const mockReq = {
      body: {
        chat_id: '2347067297627',
        message: '#ATTACHMENT:revoke# |caption:',
      },
    } as any;

    await handleBotSailorWebhook(mockReq, mockRes);
    assert.strictEqual(responseStatus, 200);
    assert.strictEqual(responseBody?.status, 'ignored');
    assert.strictEqual(responseBody?.reason, 'message_revoked_or_deleted');

    // 4. Verify chatFlowEngine completely discards revoke strings directly
    const targetPhone = '2347067297627';
    chatSessionManager.resetSession(targetPhone);
    await chatFlowEngine.processInboundMessage({
      phoneNumber: targetPhone,
      text: '#ATTACHMENT:revoke# |caption:',
    });
    // Session context should have NO lastPrompt set to 'UNAVAILABLE'
    assert.notStrictEqual(chatSessionManager.getSession(targetPhone).context.lastPrompt, 'UNAVAILABLE');
  });

  test('25. Anti-Interference on Shared WhatsApp: "We\'ve seen it ma" & payment proof chatter remain 100% silent', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const customerPhone = '2347067297627';
    chatSessionManager.resetSession(customerPhone);

    // 1. Store agent replies to customer: "We've seen it ma"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: "We've seen it ma",
    });

    const session = chatSessionManager.getSession(customerPhone);
    assert.strictEqual(session.state, 'IDLE');
    // Must NOT trigger "Product Currently Unavailable"
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE');

    // 2. Customer confirms payment: "Sent the money"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'Sent the money',
    });
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE');

    // 3. Customer or staff asks: "Check receipt"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'Check receipt',
    });
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE');

    // 4. WhatsApp message delete placeholder: "You deleted this message."
    await chatFlowEngine.processInboundMessage({
      phoneNumber: customerPhone,
      text: 'You deleted this message.',
    });
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE');
  });

  test('26. Voice Notes, Stickers, and Pure Smileys/Emojis (😊, 👍) Remain 100% Silent (Never Trigger Bot)', async () => {
    await db.updateStoreSettings({ is_bot_active: true });
    const userPhone = '2348077998877';
    chatSessionManager.resetSession(userPhone);

    // 1. Voice Note / Audio payload: findMediaInPayload must refuse to extract it as a product photo
    const audioPayload = {
      chat_id: userPhone,
      type: 'audio',
      message: {
        type: 'audio',
        audio: { url: 'https://example.com/voice-note.ogg' },
      },
    };
    const extractedAudioMedia = findMediaInPayload(audioPayload);
    assert.strictEqual(extractedAudioMedia, undefined, 'Must NEVER treat audio voice notes as product photo media');
    assert.strictEqual(isProtocolOrRevokeEvent(audioPayload), true, 'Voice notes must be recognized as ignorable protocol events');

    // 2. WhatsApp Sticker payload: findMediaInPayload must refuse to extract it as a product photo
    const stickerPayload = {
      chat_id: userPhone,
      type: 'sticker',
      message: {
        type: 'sticker',
        sticker: { url: 'https://example.com/funny-sticker.webp' },
      },
    };
    const extractedStickerMedia = findMediaInPayload(stickerPayload);
    assert.strictEqual(extractedStickerMedia, undefined, 'Must NEVER treat stickers as product photo media');
    assert.strictEqual(isProtocolOrRevokeEvent(stickerPayload), true, 'Stickers must be recognized as ignorable protocol events');

    // 3. Pure Emojis / Smileys: isProtocolOrRevokeEvent must recognize pure smileys without words
    assert.strictEqual(isProtocolOrRevokeEvent({}, '😊'), true, 'Smiley 😊 must be recognized as non-order reaction');
    assert.strictEqual(isProtocolOrRevokeEvent({}, '👍'), true, 'Thumbs-up 👍 must be recognized as non-order reaction');
    assert.strictEqual(isProtocolOrRevokeEvent({}, '😂😂😂'), true, 'Laughter emojis must be recognized as non-order reaction');
    assert.strictEqual(isProtocolOrRevokeEvent({}, '❤️'), true, 'Heart emoji must be recognized as non-order reaction');

    // 4. Inbound Smiley in ChatFlowEngine: customer sends "😊" or "👍"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: '😊',
    });
    let session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE', 'Smiley must NEVER trigger "Product Unavailable" notice');

    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: '👍',
    });
    session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE', 'Thumbs up must NEVER trigger "Product Unavailable" notice');

    // 5. Inbound Sticker token: "#ATTACHMENT:sticker# |caption:"
    await chatFlowEngine.processInboundMessage({
      phoneNumber: userPhone,
      text: '#ATTACHMENT:sticker# |caption:',
    });
    session = chatSessionManager.getSession(userPhone);
    assert.strictEqual(session.state, 'IDLE');
    assert.notStrictEqual(session.context.lastPrompt, 'UNAVAILABLE');
    assert.notStrictEqual(session.context.lastPrompt, 'PHOTO_INQUIRY');
  });
});
