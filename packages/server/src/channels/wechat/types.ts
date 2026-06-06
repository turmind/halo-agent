/**
 * WeChat bot API types. Minimal subset used by Halo — JSON over HTTP.
 */

export interface BaseInfo {
  channel_version?: string
}

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export interface TextItem {
  text?: string
}

export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  /** hex string of 16 raw bytes (32 chars) — preferred over media.aes_key when present */
  aeskey?: string
  /** Ciphertext size of original image. */
  mid_size?: number
  hd_size?: number
}

export interface VoiceItem {
  media?: CDNMedia
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex (WeChat voice is usually 6) */
  encode_type?: number
  playtime?: number
  /** Server-side speech-to-text transcript, if the platform provides one. */
  text?: string
}

export interface FileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  /** Plaintext file size as a decimal string. */
  len?: string
}

export interface VideoItem {
  media?: CDNMedia
  /** Ciphertext size. */
  video_size?: number
  play_length?: number
  thumb_media?: CDNMedia
}

export interface MessageItem {
  type?: number
  msg_id?: string
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  create_time_ms?: number
  is_completed?: boolean
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
}

export interface GetUpdatesReq {
  get_updates_buf?: string
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WeixinMessage
}

export interface NotifyResp {
  ret?: number
  errmsg?: string
}

export interface QRCodeResp {
  qrcode: string
  qrcode_img_content: string
}

export interface QRStatusResp {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

export interface GetUploadUrlReq {
  filekey: string
  media_type: number
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb?: boolean
  aeskey: string
}

export interface GetUploadUrlResp {
  upload_param?: string
  upload_full_url?: string
}
