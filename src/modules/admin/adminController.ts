import type { Request, Response } from 'express';
import { db } from '../../database/supabaseClient.ts';
import { catalogService } from '../catalog/catalogService.ts';
import { chatFlowEngine } from '../chat/chatFlowEngine.ts';
import { config } from '../../config/environment.ts';
import { logger } from '../../utils/logger.ts';

export const adminController = {
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const [products, orders] = await Promise.all([db.getProducts(), db.getOrders()]);
      const totalVariants = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);
      const totalRevenue = orders
        .filter((o) => o.order_status !== 'CANCELLED')
        .reduce((sum, o) => sum + Number(o.total_amount), 0);
      const podOrders = orders.filter((o) => o.payment_method === 'POD').length;
      const transferOrders = orders.filter((o) => o.payment_method === 'BANK_TRANSFER').length;
      const pendingOrders = orders.filter((o) => o.order_status === 'PENDING').length;

      res.json({
        totalProducts: products.length,
        totalVariants,
        totalOrders: orders.length,
        totalRevenue,
        podOrders,
        transferOrders,
        pendingOrders,
        databaseType: db.isLive ? 'Supabase Live' : 'In-Memory Development Mock',
        storeName: config.STORE_NAME,
      });
    } catch (err: any) {
      logger.error('Error in admin getStats:', err.message);
      res.status(500).json({ error: 'Failed to retrieve stats' });
    }
  },

  async getProducts(req: Request, res: Response): Promise<void> {
    try {
      const products = await db.getProducts();
      res.json(products);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  },

  async createProduct(req: Request, res: Response): Promise<void> {
    try {
      const { name, category_name, base_price, description, media_urls, variants } = req.body;
      if (!name || !base_price) {
        res.status(400).json({ error: 'Product name and base price are required' });
        return;
      }

      const created = await db.createProduct(
        {
          name,
          category_name: category_name || 'General',
          base_price: Number(base_price),
          description: description || '',
          media_urls: Array.isArray(media_urls) ? media_urls : (media_urls ? [media_urls] : []),
        },
        Array.isArray(variants) ? variants : []
      );

      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create product' });
    }
  },

  async deleteProduct(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const success = await db.deleteProduct(id);
      if (!success) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      res.json({ status: 'success', deletedId: id });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to delete product' });
    }
  },

  async bulkImport(req: Request, res: Response): Promise<void> {
    try {
      const { csv_content } = req.body;
      if (!csv_content || typeof csv_content !== 'string') {
        res.status(400).json({ error: 'Missing csv_content string in request body' });
        return;
      }

      const result = await catalogService.bulkImportFromCSV(csv_content);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Bulk import failed' });
    }
  },

  async getOrders(req: Request, res: Response): Promise<void> {
    try {
      const orders = await db.getOrders();
      res.json(orders);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  },

  async updateOrderStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { order_status, payment_status } = req.body;

      const updated = await db.updateOrderStatus(id, order_status, payment_status);
      if (!updated) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to update order status' });
    }
  },

  /**
   * Browser Simulator Endpoint:
   * Lets the admin simulate an incoming WhatsApp message and see the bot's reaction!
   */
  async simulateMessage(req: Request, res: Response): Promise<void> {
    try {
      const { phone = '2348011223344', text = 'Hi', media_url } = req.body;
      await chatFlowEngine.processInboundMessage({
        phoneNumber: phone,
        text,
        mediaUrl: media_url,
      });

      res.json({
        status: 'processed',
        phone,
        input: text,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Simulation error' });
    }
  },
};
