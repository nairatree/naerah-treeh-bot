import type { Request, Response } from 'express';
import { logger } from '../../utils/logger.ts';
import { chatFlowEngine } from '../chat/chatFlowEngine.ts';

export async function handleBotSailorWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body || {};

  logger.info('BotSailor Webhook Received Inbound Payload:', {
    snippet: JSON.stringify(payload).substring(0, 300),
  });

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

  // Extract Media Attachment
  let mediaUrl: string | undefined =
    payload.media_url ||
    payload.attachment_url ||
    payload.image_url ||
    payload.video_url ||
    payload.media?.url ||
    payload.attachment?.url ||
    payload.message?.media_url ||
    payload.message?.image?.url ||
    payload.message?.video?.url ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.image?.url ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.video?.url;

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
