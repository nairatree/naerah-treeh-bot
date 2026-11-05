import { test, describe } from 'node:test';
import assert from 'node:assert';
import { catalogService } from '../src/modules/catalog/catalogService.ts';
import { orderService } from '../src/modules/orders/orderService.ts';
import { chatSessionManager } from '../src/modules/chat/chatSessionManager.ts';
import { chatFlowEngine } from '../src/modules/chat/chatFlowEngine.ts';
import { db } from '../src/database/supabaseClient.ts';

describe('Nairatee Stores E-Commerce Chatbot Engine Tests', () => {
  test('1. Catalog Search & Multi-Variant Retrieval', async () => {
    const results = await catalogService.search('chopping board');
    assert.ok(results.length > 0, 'Should find chopping board product');
    const product = results[0];
    assert.strictEqual(product.name, 'Premium Wooden Chopping Board');
    assert.ok(product.variants && product.variants.length > 0, 'Product must have multi-variants');

    // Verify variants contain colors and sizes
    const colors = product.variants.map((v) => v.color).filter(Boolean);
    const sizes = product.variants.map((v) => v.size).filter(Boolean);
    assert.ok(colors.includes('Natural Wood'), 'Should include Natural Wood color');
    assert.ok(sizes.some((s) => s?.includes('Medium')), 'Should include Medium size');
  });

  test('2. Address Parser from Natural User WhatsApp Message', () => {
    const rawMessage = `My name is Joy Adebayo\nPhone: 08031112233\nAddress: 15 Admiralty Way, Lekki Phase 1, Lagos`;
    const parsed = orderService.parseAddressMessage(rawMessage, '2348031112233');

    assert.strictEqual(parsed.name, 'Joy Adebayo');
    assert.strictEqual(parsed.phone, '08031112233');
    assert.ok(parsed.address.includes('Admiralty Way'), 'Should extract full street address');
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

  test('4. Anti-Interference Filter: Casual Messages Ignored, Store Inquiries Processed', async () => {
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

  test('5. Chat Flow: Inbound Query -> Variant Selection -> Payment Method -> Order Placement', async () => {
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

    // Step B: Customer picks Variant Option 1 (16L Electric Blue)
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: '1',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'CHOOSING_PAYMENT_METHOD', 'State must advance to payment method choice');
    assert.ok(session.context.selectedVariant, 'Selected variant must be recorded');

    // Step C: Customer chooses Pay on Delivery (Option 1)
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: '1',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'AWAITING_DELIVERY_DETAILS', 'State must advance to awaiting delivery details');
    assert.strictEqual(session.context.selectedPaymentMethod, 'POD');

    // Step D: Customer provides Delivery Details
    await chatFlowEngine.processInboundMessage({
      phoneNumber: testPhone,
      text: 'Name: Emeka Eze\nPhone: 08022223344\nAddress: 24 Broad Street, Marina, Lagos',
    });

    session = chatSessionManager.getSession(testPhone);
    assert.strictEqual(session.state, 'IDLE', 'Session should reset to IDLE after order confirmation');

    // Verify order was saved to database
    const orders = await db.getOrders();
    const createdOrder = orders.find((o) => o.customer_name === 'Emeka Eze');
    assert.ok(createdOrder, 'Order must be saved in database');
    assert.strictEqual(createdOrder.payment_method, 'POD');
    assert.strictEqual(createdOrder.items[0].product_name, 'Heavy-Duty 2-in-1 Knapsack Sprayer');

    // Clean up: restore bot to PAUSED as requested by merchant!
    await db.updateStoreSettings({ is_bot_active: false });
  });

  test('6. Bulk CSV Catalog Import with Variants Generator', async () => {
    const sampleCSV = `Category,Name,Price,Sizes,Colors,Description,Image_URL
Kitchen Wares,Non-Stick Frying Pan,15000,"Small (20cm), Large (28cm)","Matte Black, Crimson Red","Granite coating pan with induction base",https://example.com/pan.jpg`;

    const result = await catalogService.bulkImportFromCSV(sampleCSV);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.successful, 1);

    // Verify product exists with 4 generated variants (2 sizes x 2 colors)
    const search = await catalogService.search('Non-Stick Frying Pan');
    assert.ok(search.length > 0);
    const pan = search[0];
    assert.strictEqual(pan.variants?.length, 4, 'Should auto-generate 4 color/size combinations');
  });
});
