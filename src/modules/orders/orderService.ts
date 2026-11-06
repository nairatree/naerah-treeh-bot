import { db } from '../../database/supabaseClient.ts';
import { config } from '../../config/environment.ts';
import type { Order, OrderItem, PaymentMethod } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

export class OrderService {
  generateOrderNumber(): string {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const dateStr = new Date().getFullYear();
    return `NT-${dateStr}-${randomSuffix}`;
  }

  /**
   * Parse a raw user address message
   * Users often send:
   * "Name: Joy Adebayo, Phone: 08012345678, Address: 12 Allen Avenue, Ikeja, Lagos"
   * or line-by-line
   */
  parseAddressMessage(text: string, defaultPhone: string): { name: string; phone: string; address: string; cityState?: string; quantity?: number } {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let name = '';
    let phone = defaultPhone;
    let address = '';
    let quantity: number | undefined;

    // Check for inline quantity (e.g. "2 pieces", "qty: 3", "quantity: 2", "3 pcs")
    const qtyMatch = text.match(/(?:qty|quantity)[\s:]*([0-9]+)|([0-9]+)\s*(?:pieces|piece|pcs)/i);
    if (qtyMatch) {
      const qVal = parseInt(qtyMatch[1] || qtyMatch[2], 10);
      if (!isNaN(qVal) && qVal > 0) quantity = qVal;
    }

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.startsWith('name:') || lower.startsWith('full name:')) {
        name = line.replace(/^(name:|full name:)/i, '').trim();
      } else if (lower.startsWith('my name is ')) {
        name = line.replace(/^my name is /i, '').trim();
      } else if (lower.startsWith('i am ')) {
        name = line.replace(/^i am /i, '').trim();
      } else if (lower.startsWith('phone:') || lower.startsWith('number:') || lower.startsWith('tel:')) {
        phone = line.replace(/^(phone:|number:|tel:)/i, '').trim().replace(/\D/g, '') || defaultPhone;
      } else if (lower.startsWith('address:') || lower.startsWith('location:') || lower.startsWith('delivery address:')) {
        address = line.replace(/^(address:|location:|delivery address:)/i, '').trim();
      }
    }

    // If no explicit prefixes were used, try position-based extraction
    if (!name && lines.length >= 2) {
      name = lines[0].replace(/^my name is /i, '').trim();
      const secondLineDigits = lines[1].replace(/\D/g, '');
      if (secondLineDigits.length >= 10) {
        phone = secondLineDigits;
        address = lines.slice(2).join(', ');
      } else {
        address = lines.slice(1).join(', ');
      }
    } else if (!address) {
      address = text.trim();
    }

    if (!name) name = 'Valued Customer';

    return {
      name,
      phone,
      address,
      quantity,
    };
  }

  async createCustomerOrder(params: {
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    cityState?: string;
    items: OrderItem[];
    paymentMethod?: PaymentMethod;
  }): Promise<Order> {
    const orderNumber = this.generateOrderNumber();
    const totalAmount = params.items.reduce((sum, item) => sum + item.subtotal, 0);

    const order = await db.createOrder({
      order_number: orderNumber,
      customer_name: params.customerName,
      customer_phone: params.customerPhone,
      delivery_address: params.deliveryAddress,
      city_state: params.cityState,
      items: params.items,
      total_amount: totalAmount,
      payment_method: params.paymentMethod || 'POD',
      payment_status: 'UNPAID',
      order_status: 'PENDING',
      customer_notes: 'Awaiting staff delivery fee calculation & contact',
    });

    logger.info(`New Order Intent Created: ${order.order_number} for ₦${totalAmount} (Awaiting staff delivery fee)`);
    return order;
  }

  formatOrderConfirmation(order: Order, groupLink?: string): string {
    const formattedTotal = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(order.total_amount);
    const item = order.items[0];
    const itemDetails = item
      ? `${item.product_name}${item.color || item.size ? ` (${[item.color, item.size].filter(Boolean).join(' / ')})` : ''} x${item.quantity || 1}`
      : 'Products';

    let msg = `🎉 *THANK YOU FOR YOUR ORDER!*\n\n`;
    msg += `🔖 *Order Ref:* ${order.order_number}\n`;
    msg += `📦 *Item:* ${itemDetails}\n`;
    msg += `💰 *Item Total:* ${formattedTotal}\n`;
    msg += `📍 *Delivery Address:*\n${order.delivery_address}\n\n`;
    msg += `🚚 One of our *staff* will contact you right away on WhatsApp to confirm your exact delivery fee and finalize delivery.\n\n`;

    if (groupLink) {
      msg += `📲 *Join our VIP WhatsApp Group for daily new arrivals & wholesale deals:*\n${groupLink}`;
    }

    return msg;
  }

  /**
   * Check if inbound message is inquiring about an existing order, package or delivery
   */
  isDeliveryInquiry(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // 1. Explicit Order Ref detection
    if (/NT-\d{4}-\d+/i.test(lower)) {
      return true;
    }

    // 2. Explicit Tracking & Status Phrases
    const explicitPhrases = [
      'track order',
      'track my order',
      'order status',
      'delivery status',
      'track delivery',
      'dispatch status',
      'status of my order',
      'where is my order',
      'where is my delivery',
      'where is my product',
      'where is my package',
      'when will my order',
      'when will my product',
      'when will you deliver',
      'when are you delivering',
      'when will you be doing the delivery',
      'when will the delivery',
      'when is my delivery',
      'when is delivery',
      'when am i getting my order',
      'when am i getting my product',
      'is my order ready',
      'when will my products be ready',
      'when will my product be ready',
      'when will it be ready',
      'how far with my order',
      'how far with my delivery',
      'update on my delivery',
      'update on my order',
    ];

    if (explicitPhrases.some((p) => lower.includes(p))) {
      return true;
    }

    // 3. Subject + Inquiry Combination (e.g. "when will you do the delivery", "what is happening with my order")
    const hasSubject = /\b(delivery|order|package|dispatch|parcel)\b/i.test(lower);
    const hasInquiry = /\b(when|where|status|track|ready|arrived|arrive|reach|coming|update|delay|progress)\b/i.test(lower);

    if (hasSubject && hasInquiry) {
      return true;
    }

    // 4. "products be ready" / "product be ready"
    if (/\bproduct(s)?\b/i.test(lower) && /\b(ready|deliver|arrive|sent)\b/i.test(lower)) {
      return true;
    }

    return false;
  }

  /**
   * Extract potential order number from text
   */
  extractOrderNumber(text: string): string | null {
    const match = text.match(/NT-\d{4}-\d+/i);
    return match ? match[0].toUpperCase() : null;
  }

  /**
   * Find most recent customer order by order number or customer phone
   */
  async findCustomerOrder(phoneNumber: string, text?: string): Promise<Order | null> {
    if (text) {
      const orderNum = this.extractOrderNumber(text);
      if (orderNum) {
        const order = await db.getOrderByNumber(orderNum);
        if (order) return order;
      }
    }

    const orders = await db.getOrdersByPhone(phoneNumber);
    if (orders && orders.length > 0) {
      return orders[0];
    }

    return null;
  }

  /**
   * Format friendly, reassuring Order Status for WhatsApp
   */
  formatOrderStatus(order: Order): string {
    const statusMap: Record<string, string> = {
      PENDING: '⏳ Preparing for Dispatch (Awaiting delivery fee confirmation)',
      CONFIRMED: '✅ Confirmed & Being Packaged',
      DISPATCHED: '🚚 Out for Delivery / In Transit',
      DELIVERED: '🎉 Delivered Successfully',
      CANCELLED: '❌ Cancelled',
    };
    const statusText = statusMap[order.order_status] || order.order_status;
    const item = order.items?.[0];
    const itemText = item
      ? `${item.product_name}${item.color || item.size ? ` (${[item.color, item.size].filter(Boolean).join(' / ')})` : ''} x${item.quantity || 1}`
      : 'Ordered item(s)';

    let msg = `📦 *ORDER STATUS UPDATE*\n\n`;
    msg += `🔖 *Ref:* ${order.order_number}\n`;
    msg += `🛍️ *Product:* ${itemText}\n`;
    msg += `📊 *Status:* ${statusText}\n`;
    if (order.delivery_address) {
      msg += `📍 *Delivery Address:*\n${order.delivery_address}\n`;
    }
    msg += `\n💬 Our *staff* is actively coordinating your dispatch and will message you shortly! 🙏`;
    return msg;
  }
}

export const orderService = new OrderService();
