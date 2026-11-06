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
}

export const orderService = new OrderService();
