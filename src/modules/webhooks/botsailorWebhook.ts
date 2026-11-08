import type { Request, Response } from 'express';
import { logger } from '../../utils/logger.ts';
import { chatFlowEngine } from '../chat/chatFlowEngine.ts';
import { chatSessionManager } from '../chat/chatSessionManager.ts';
import { systemSettings } from '../system/systemSettings.ts';
import { db } from '../../database/supabaseClient.ts';
import { config } from '../../config/environment.ts';

/**
 * LAYER 3: Blacklist of passive CRM / profile keys that must NEVER be recursively scanned for live message attachments.
 */
export const CRM_PASSIVE_PROFILE_KEYS = [
  'subscriber',
  'custom_fields',
  'subscriber_custom_fields',
  'contact_fields',
  'user_profile',
  'contact',
  'contacts',
  'user',
  'sender_profile',
  'profile',
];

/**
 * LAYER 3: Extract live media attached directly to the active incoming message event.
 * Explicitly ignores historical custom fields and passive CRM subscriber profiles.
 */
export function findMediaInPayload(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  // 1. Meta WhatsApp Cloud API active message format
  const msg0 = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (msg0) {
    const metaMedia =
      msg0.image?.url ||
      msg0.video?.url ||
      msg0.document?.url ||
      msg0.audio?.url;
    if (metaMedia) return String(metaMedia).trim();
  }

  // 2. BotSailor live message object format
  const activeMsg = payload.message;
  if (activeMsg && typeof activeMsg === 'object') {
    const msgMedia =
      activeMsg.image?.url ||
      activeMsg.video?.url ||
      activeMsg.document?.url ||
      activeMsg.media_url ||
      activeMsg.attachment_url ||
      activeMsg.url;
    if (msgMedia) return String(msgMedia).trim();
  }

  // 3. Direct top-level active message event fields (Explicitly ignore passive CRM keys)
  const directMedia =
    payload.attachment_url ||
    payload.media_url ||
    payload.image_url ||
    payload.video_url ||
    payload.media?.url ||
    payload.attachment?.url;

  if (directMedia && typeof directMedia === 'string') {
    return directMedia.trim();
  }

  return undefined;
}

/**
 * LAYER 1: Inspect incoming payloads and detect if the message was sent by the business or an agent.
 * Filters out WhatsApp coexistence echoes, live chat replies, and outbound messages.
 */
export function isOutboundAgentMessage(payload: any, settings?: Record<string, any>): boolean {
  if (!payload || typeof payload !== 'object') return false;

  // 1. Explicit boolean echo/outbound flags
  if (
    payload.from_me === true ||
    payload.message?.from_me === true ||
    payload.is_outbound === true ||
    payload.is_echo === true ||
    payload.message?.is_echo === true ||
    payload.message?.is_outbound === true
  ) {
    return true;
  }

  // 2. Direction indicators
  const direction = String(payload.direction || payload.message?.direction || '').toLowerCase().trim();
  if (direction === 'outbound' || direction === 'outgoing') {
    return true;
  }
  const typeField = String(payload.type || payload.message?.type || '').toLowerCase().trim();
  if (typeField === 'outbound' || typeField === 'outgoing') {
    return true;
  }

  // 3. Meta WhatsApp Cloud API coexistence fields
  const changes = payload.entry?.[0]?.changes?.[0];
  if (changes?.field === 'smb_message_echoes' || changes?.value?.message_echoes) {
    return true;
  }
  if (changes?.value?.messages?.[0]?.from_me === true) {
    return true;
  }

  // 4. BotSailor / CRM Event Types
  const event = String(
    payload.event ||
    payload.event_type ||
    payload.event_name ||
    payload.action ||
    changes?.field ||
    ''
  ).toLowerCase().trim();

  const outboundEvents = [
    'smb_message_echoes',
    'message_sent',
    'outgoing_message',
    'outbound',
    'echo',
    'agent_reply',
    'live_chat_message',
  ];
  if (outboundEvents.includes(event)) {
    return true;
  }

  // 5. Sender role / source
  const senderType = String(
    payload.sender_type ||
    payload.message?.sender_type ||
    payload.sent_by ||
    payload.role ||
    payload.sender_role ||
    payload.author_type ||
    payload.source ||
    payload.message?.source ||
    ''
  ).toLowerCase().trim();

  const agentSenderTypes = ['agent', 'business', 'bot', 'admin', 'live_chat'];
  if (agentSenderTypes.includes(senderType)) {
    return true;
  }

  // 6. Phone number matching business's own display phone number
  const metadataPhone = String(changes?.value?.metadata?.display_phone_number || '').replace(/\D/g, '');
  const supportPhone = String(settings?.support_phone || config.SUPPORT_PHONE_NUMBER || '').replace(/\D/g, '');
  const botId = String(config.BOTSAILOR_WHATSAPP_BOT_ID || '').replace(/\D/g, '');
  const messageFrom = String(changes?.value?.messages?.[0]?.from || payload.from || payload.sender || '').replace(/\D/g, '');

  if (messageFrom && messageFrom.length >= 7) {
    if (
      (metadataPhone && messageFrom === metadataPhone) ||
      (supportPhone && supportPhone !== '2348000000000' && messageFrom === supportPhone) ||
      (botId && messageFrom === botId)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts the recipient customer's phone number from outbound / echo payloads
 */
export function extractTargetRecipientPhone(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const raw =
    payload.recipient ||
    payload.to ||
    payload.recipient_id ||
    payload.target_phone ||
    payload.customer_phone ||
    payload.chat_id ||
    payload.phone ||
    payload.phone_number ||
    payload.user_phone ||
    payload.subscriber?.phone ||
    payload.subscriber?.phone_number ||
    payload.subscriber_phone ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.recipient_id ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.to ||
    payload.entry?.[0]?.changes?.[0]?.value?.message_echoes?.[0]?.to ||
    payload.entry?.[0]?.changes?.[0]?.value?.message_echoes?.[0]?.recipient_id ||
    payload.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id;

  if (raw) {
    const clean = String(raw).replace(/\D/g, '');
    if (clean.length >= 7) return clean;
  }
  return undefined;
}

export async function handleBotSailorWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body || {};

  logger.info('BotSailor Webhook Received Inbound Payload:', {
    snippet: JSON.stringify(payload).substring(0, 300),
  });

  const settings = await db.getStoreSettings();

  // LAYER 5: Global Master Bot Killswitch (Immediate Discard when disabled)
  const isBotActive = await systemSettings.isBotGloballyActive();
  if (!isBotActive) {
    logger.info('[KILLSWITCH] Bot is globally disabled. Webhook dropping incoming message.');
    res.status(200).json({ status: 'ignored', reason: 'bot_globally_disabled' });
    return;
  }

  // LAYER 1: Outbound & Echo Blocker (Filter Out Messages Sent by the Store/Agent)
  if (isOutboundAgentMessage(payload, settings)) {
    const targetPhone = extractTargetRecipientPhone(payload);
    if (targetPhone) {
      // Trigger LAYER 2: Automatic Human Takeover & Bot Auto-Mute for that recipient
      chatSessionManager.activateHumanTakeover(targetPhone);
      logger.info(`[LAYER 1 & 2] Outbound agent message detected for customer ${targetPhone}. Human takeover activated for 24 hours.`);
    } else {
      logger.info('[LAYER 1] Outbound agent message detected without recipient phone. Echo dropped.');
    }
    res.status(200).json({ status: 'ignored', reason: 'outbound_agent_echo' });
    return;
  }

  // Extract Phone Number across all BotSailor payload formats
  const phoneNumber: string | undefined =
    payload.chat_id ||
    payload.phone ||
    payload.phone_number ||
    payload.user_phone ||
    payload.sender_phone ||
    payload.sender ||
    payload.from ||
    payload.mobile ||
    payload.subscriber?.phone ||
    payload.subscriber?.phone_number ||
    payload.subscriber_phone ||
    payload.contacts?.[0]?.wa_id ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;

  if (!phoneNumber) {
    logger.warn('BotSailor Webhook: No phone number identified in payload.');
    res.status(200).json({ status: 'ignored', reason: 'no_phone_found' });
    return;
  }

  // Extract interactive button payload or title (supports all WhatsApp & BotSailor formats)
  const buttonPayload: string = (
    payload.button_payload ||
    payload.interactive?.button_reply?.id ||
    payload.interactive?.button_reply?.payload ||
    payload.message?.interactive?.button_reply?.id ||
    payload.message?.interactive?.button_reply?.payload ||
    payload.message?.button_reply?.id ||
    payload.message?.button_reply?.payload ||
    payload.button_id ||
    payload.payload ||
    payload.postback?.payload ||
    payload.data?.payload ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.payload ||
    ''
  ).trim();

  const buttonTitle: string = (
    payload.interactive?.button_reply?.title ||
    payload.message?.interactive?.button_reply?.title ||
    payload.message?.button_reply?.title ||
    payload.button_text ||
    payload.button_reply?.title ||
    payload.postback?.title ||
    payload.data?.title ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.title ||
    ''
  ).trim();

  // Extract Text Content (Button clicks, list selection, text message, or caption)
  let userText: string = (
    (typeof payload.message === 'string' ? payload.message : '') ||
    payload.message?.text ||
    payload.message?.caption ||
    payload.user_message ||
    payload.message_content ||
    payload.text ||
    payload.caption ||
    payload.body ||
    buttonTitle ||
    buttonPayload ||
    payload.interactive?.list_reply?.title ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.list_reply?.title ||
    ''
  ).trim();

  // LAYER 3: Extract Media Attachment safely (Isolated from stale CRM profile fields)
  let mediaUrl: string | undefined = findMediaInPayload(payload);

  // Extract media caption if userText is empty
  if (!userText && (payload.media_caption || payload.message?.caption)) {
    userText = (payload.media_caption || payload.message?.caption || '').trim();
  }

  // Acknowledge BotSailor immediately with 200 OK
  res.status(200).json({ status: 'success' });

  // Process asynchronously without blocking HTTP response
  try {
    await chatFlowEngine.processInboundMessage({
      phoneNumber,
      text: userText,
      buttonPayload,
      mediaUrl,
      userName: payload.subscriber?.first_name || payload.first_name,
    });
  } catch (err: any) {
    logger.error('Error processing BotSailor inbound flow:', err.message);
  }
}
