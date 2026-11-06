import { test, describe } from 'node:test';
import assert from 'node:assert';
import { catalogService } from '../src/modules/catalog/catalogService.ts';
import { orderService } from '../src/modules/orders/orderService.ts';
import { chatSessionManager } from '../src/modules/chat/chatSessionManager.ts';
import { chatFlowEngine } from '../src/modules/chat/chatFlowEngine.ts';
import { followupService } from '../src/modules/followup/followupService.ts';
import { db } from '../src/database/supabaseClient.ts';

describe('Nairatee Stores E-Commerce Chatbot Engine Tests', () => {
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

    // Clean up: restore bot to PAUSED as requested by merchant
    await db.updateStoreSettings({ is_bot_active: false });
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
});
