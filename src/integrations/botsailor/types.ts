export interface BotSailorButton {
  type: 'reply' | 'url' | 'call';
  text: string;
  payload?: string;
  url?: string;
}

export interface BotSailorListRow {
  id: string;
  title: string;
  description?: string;
}

export interface BotSailorListSection {
  title: string;
  rows: BotSailorListRow[];
}

export interface BotSailorMessagePayload {
  subscriber_id?: string;
  phone_number?: string;
  message_type: 'text' | 'button' | 'image' | 'video' | 'interactive';
  text?: string;
  media_url?: string;
  buttons?: BotSailorButton[];
  custom_fields?: Record<string, any>;
}
