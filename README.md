# 🛍️ Nairatee Stores - WhatsApp E-Commerce Assistant & Multi-Variant Platform

> Complete WhatsApp E-Commerce Chatbot, Variant Management, Order Processing, and Admin Control Platform for Nairatee Stores.

---

## 🏗️ Approved System Architecture

- **WhatsApp Gateway:** [BotSailor](https://botsailor.com) (Webhook Receiver & Cloud API Bridge)
- **Primary Database:** [Supabase PostgreSQL](https://supabase.com) (Catalog, Multi-Variants, Orders)
- **Backend Service:** Node.js (v22+) with Native TypeScript, Express, and Zod
- **Admin Control Center:** Responsive Web Portal (`/admin`) for Catalog, Multi-Variants, Bulk CSV Import, and Order Tracking
- **Payment Modes:** Pay on Delivery (POD) & Direct Bank Transfer

```
Meta / Instagram Ad ──▶ WhatsApp (BotSailor) ──▶ Webhook (`/api/webhook`) ──▶ Chat Flow Engine
                                                                                     │
                       ┌─────────────────────────────────────────────────────────────┤
                       ▼                                                             ▼
         Product Search & Multi-Variants                               Checkout & Order Confirmation
         (Colors, Sizes, Custom Pricing)                             (Pay on Delivery / Bank Transfer)
                       │                                                             │
                       ▼                                                             ▼
           Supabase Product Catalog                                      Supabase Orders Table
```

---

## 🚀 Key Features Built

### 1. Multi-Variant Support (Colors & Sizes)
* Full support for products with different colors (e.g. *Red*, *Blue*, *Natural Wood*) and sizes (e.g. *Medium 30cm*, *Large 40cm*, *16 Litres*, *20 Litres*).
* Automatically presents options to the customer on WhatsApp with variant-specific prices.
* Customer selects their option simply by replying with the number (e.g. `1`, `2`).

### 2. Dual Checkout Options
* **Pay on Delivery (POD):** Confirms order immediately, creates a unique Order ID (`#NT-2026-XXXX`), and instructs customer to have cash or transfer ready for the delivery rider.
* **Pay Now (Bank Transfer):** Displays official company bank account details (Bank Name, Account Number, Account Name) and collects payment receipt screenshot.

### 3. One-Message Address Capture
* Intelligent parser accepts natural WhatsApp messages like:
  ```text
  Name: Joy Adebayo
  Phone: 08012345678
  Address: 15 Admiralty Way, Lekki Phase 1, Lagos
  ```
  or single-line messages.

### 4. How the Merchant Uploads 1,000 to 5,000 Products
1. **Bulk CSV / Excel Upload (via Admin Portal `/admin`):**
   * Download sample template.
   * Paste or upload thousands of rows.
   * Auto-generates color/size variant combinations in seconds.
2. **WhatsApp Admin Quick-Add (`/add` command):**
   * Authorized admin phones can send an image or video with:
     ```text
     /add
     Category: Kitchen
     Name: Wooden Chopping Board
     Price: 8500
     Sizes: Medium, Large
     Colors: Natural Wood, Red
     Description: High quality teak cutting board.
     ```

### 5. Live Customer Support Fallback
* Whenever a customer types `support`, `agent`, or `human`, automated bot replies pause for that user and a human agent is notified to take over in BotSailor.

---

## 🖥️ Running the Project

### 1. Start Server in Development Mode
```bash
npm run dev
```
Server runs at `http://localhost:4000`.

### 2. Run Automated Verification Tests
```bash
npm test
```

### 3. Open Admin Control Center
Open your browser and visit:
👉 **[http://localhost:4000/admin](http://localhost:4000/admin)**
* Default Admin Secret: `nairatee_admin_secret_2026`

---

## 🔑 Production Environment Variables (`.env`)

```env
PORT=4000
ADMIN_API_KEY=nairatee_admin_secret_2026

# BotSailor
BOTSAILOR_BASE_URL=https://use.botsailor.com/api/v1
BOTSAILOR_API_KEY=your_botsailor_api_key
BOTSAILOR_WHATSAPP_BOT_ID=your_whatsapp_bot_id

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_ANON_KEY=your_anon_key

# Store & Bank Details
STORE_NAME=Nairatee Stores
BANK_NAME=Access Bank
BANK_ACCOUNT_NUMBER=0123456789
BANK_ACCOUNT_NAME=Nairatee Stores Enterprise
SUPPORT_PHONE_NUMBER=2348000000000

# Authorized Admin WhatsApp Numbers for /add command
ADMIN_PHONES=2348000000000,2348012345678
```

---

## 🗄️ Supabase Migration
Run the SQL script located in `supabase/migrations/20261104_initial_ecommerce_schema.sql` in your Supabase SQL Editor. It creates all tables, foreign keys, full-text search indexes, and initial seed data.
