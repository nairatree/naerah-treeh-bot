import { db } from '../../database/supabaseClient.ts';
import type { Product, ProductVariant, Category } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

export class CatalogService {
  async getCategories(): Promise<Category[]> {
    return db.getCategories();
  }

  async search(query: string): Promise<Product[]> {
    return db.searchProducts(query);
  }

  async getProduct(id: string): Promise<Product | null> {
    return db.getProductById(id);
  }

  /**
   * Format product message for WhatsApp presentation (Prioritizes video if available, falls back to picture)
   */
  formatProductMessage(product: Product): { text: string; mediaUrl?: string; mediaType: 'image' | 'video' } {
    const urls = product.media_urls || [];
    // Prioritize video if available, otherwise picture
    const videoUrl = urls.find((u) => /\.(mp4|mov|webm|avi|m4v)($|\?)/i.test(u) || u.toLowerCase().includes('/video/'));
    const imageUrl = urls.find((u) => !/\.(mp4|mov|webm|avi|m4v)($|\?)/i.test(u) && !u.toLowerCase().includes('/video/')) || urls[0];

    const selectedMedia = videoUrl || imageUrl;
    const mediaType: 'image' | 'video' = videoUrl ? 'video' : 'image';
    const baseFormattedPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(product.base_price);

    let text = `🛍️ *${product.name.toUpperCase()}*\n`;
    text += `📂 *Category:* ${product.category_name}\n`;
    text += `💰 *Starting Price:* ${baseFormattedPrice}\n\n`;
    text += `📝 *Description:*\n${product.description}\n\n`;

    const variants = product.variants || [];
    if (variants.length > 0) {
      text += `🎨 *AVAILABLE SIZES & COLORS:*\n`;
      variants.forEach((v, idx) => {
        const variantPrice = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(v.price);
        const sizeInfo = v.size ? `Size: ${v.size}` : '';
        const colorInfo = v.color ? `Color: ${v.color}` : '';
        const combo = [colorInfo, sizeInfo].filter(Boolean).join(' | ');
        text += `${idx + 1}️⃣ *Option ${idx + 1}:* ${combo} — *${variantPrice}*\n`;
      });
      text += `\n👉 *Reply with the number (e.g. 1) to select your option.*`;
    } else {
      text += `👉 *Reply "BUY" to place your order.*`;
    }

    return { text, mediaUrl: selectedMedia, mediaType };
  }

  /**
   * Helper to parse a CSV line accounting for quoted fields with commas and spaces
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  /**
   * Bulk import products from CSV content
   * Columns: Category, Name, SKU, Description, BasePrice, Sizes, Colors, ImageURL
   */
  async bulkImportFromCSV(csvText: string): Promise<{ total: number; successful: number; errors: string[] }> {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) {
      return { total: 0, successful: 0, errors: ['CSV file is empty or missing data rows'] };
    }

    const headers = this.parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
    const rows = lines.slice(1);
    let successful = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const line = rows[i];
      const cleanCols = this.parseCSVLine(line);

      const rowData: Record<string, string> = {};
      headers.forEach((h, idx) => {
        rowData[h] = cleanCols[idx] || '';
      });

      const name = rowData['name'] || rowData['product_name'] || rowData['title'];
      const category = rowData['category'] || rowData['category_name'] || 'General';
      const price = parseFloat(rowData['price'] || rowData['base_price'] || '0') || 0;
      const description = rowData['description'] || name;
      const imageUrl = rowData['image_url'] || rowData['image'] || rowData['picture'];
      const videoUrl = rowData['video_url'] || rowData['video'];
      const mediaList: string[] = [];
      if (videoUrl) mediaList.push(videoUrl);
      if (imageUrl) mediaList.push(imageUrl);
      if (mediaList.length === 0 && rowData['media_url']) mediaList.push(rowData['media_url']);

      const sizes = (rowData['sizes'] || rowData['size'] || '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      const colors = (rowData['colors'] || rowData['color'] || '').split(/[,;|]/).map((c) => c.trim()).filter(Boolean);

      if (!name) {
        errors.push(`Row ${i + 2}: Missing product name`);
        continue;
      }

      try {
        const variantsData: Partial<ProductVariant>[] = [];

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
                is_available: true,
              });
            });
          });
        }

        await db.createProduct(
          {
            name,
            category_name: category,
            base_price: price,
            description,
            media_urls: mediaList,
          },
          variantsData
        );
        successful++;
      } catch (err: any) {
        errors.push(`Row ${i + 2} (${name}): ${err.message}`);
      }
    }

    logger.info(`Bulk CSV import finished: ${successful}/${rows.length} successful`);
    return { total: rows.length, successful, errors };
  }
}

export const catalogService = new CatalogService();
