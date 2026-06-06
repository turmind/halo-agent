/**
 * Send a local file (image / video / other) to a WeChat user.
 *
 * Pipeline:
 *   1. Read + hash file
 *   2. getUploadUrl → pre-signed CDN target
 *   3. AES-128-ECB encrypt + POST to CDN, receive downloadEncryptedQueryParam
 *   4. sendMessage with an Image/Video/File item referencing the uploaded media
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getUploadUrl, sendMessage } from './api.js'
import { prepareUpload, uploadCiphertext } from './cdn.js'
import {
  MessageItemType, MessageState, MessageType, UploadMediaType,
  type MessageItem, type SendMessageReq,
} from './types.js'

import { classifyMedia } from '../shared/media.js'

export type MediaKind = 'image' | 'video' | 'file'

export function inferKind(filePath: string): MediaKind {
  const cls = classifyMedia(filePath)
  if (cls === 'image') return 'image'
  if (cls === 'video') return 'video'
  // WeChat doesn't have a separate "voice" item type — voice files
  // ride along as generic file attachments.
  return 'file'
}

export async function sendMediaFile(params: {
  baseUrl: string
  token: string
  toUserId: string
  contextToken?: string
  filePath: string
  kind?: MediaKind
}): Promise<{ clientId: string }> {
  const { baseUrl, token, toUserId, contextToken, filePath } = params
  const kind = params.kind ?? inferKind(filePath)

  const plaintext = await fs.readFile(filePath)
  const prep = prepareUpload(plaintext)
  console.log(`[weixin] sendMediaFile: path=${filePath} kind=${kind} rawsize=${prep.rawsize} filesize=${prep.filesize}`)

  const mediaType = kind === 'image' ? UploadMediaType.IMAGE
    : kind === 'video' ? UploadMediaType.VIDEO
    : UploadMediaType.FILE

  const upResp = await getUploadUrl({
    baseUrl, token,
    body: {
      filekey: prep.filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: prep.rawsize,
      rawfilemd5: prep.rawfilemd5,
      filesize: prep.filesize,
      no_need_thumb: true,
      aeskey: prep.aeskeyHex,
    },
  })
  console.log(`[weixin] sendMediaFile: getUploadUrl resp hasFullUrl=${Boolean(upResp.upload_full_url)} hasParam=${Boolean(upResp.upload_param)}`)

  if (!upResp.upload_full_url && !upResp.upload_param) {
    throw new Error(`[weixin] getUploadUrl returned no upload target (kind=${kind})`)
  }

  const { downloadEncryptedQueryParam } = await uploadCiphertext({
    plaintext,
    aeskey: prep.aeskey,
    filekey: prep.filekey,
    uploadFullUrl: upResp.upload_full_url,
    uploadParam: upResp.upload_param,
    label: `upload-${kind}`,
  })
  console.log(`[weixin] sendMediaFile: uploaded, dl_param_len=${downloadEncryptedQueryParam.length}`)

  // Match Tencent plugin's wire format: base64 of the hex-string ASCII bytes
  // (NOT base64 of the raw 16-byte key). WeChat clients parse both forms but
  // media delivery only works reliably with this encoding.
  const aesKeyBase64 = Buffer.from(prep.aeskeyHex, 'utf8').toString('base64')
  const item = buildMessageItem({
    kind,
    downloadEncryptedQueryParam,
    aesKeyBase64,
    fileSizeCiphertext: prep.filesize,
    fileSize: prep.rawsize,
    fileName: path.basename(filePath),
  })

  const clientId = `halo-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const body: SendMessageReq = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      context_token: contextToken,
    },
  }
  await sendMessage({ baseUrl, token, body })
  console.log(`[weixin] sendMediaFile: sendMessage success clientId=${clientId}`)
  return { clientId }
}

function buildMessageItem(args: {
  kind: MediaKind
  downloadEncryptedQueryParam: string
  aesKeyBase64: string
  fileSizeCiphertext: number
  fileSize: number
  fileName: string
}): MessageItem {
  const media = {
    encrypt_query_param: args.downloadEncryptedQueryParam,
    aes_key: args.aesKeyBase64,
    encrypt_type: 1,
  }
  if (args.kind === 'image') {
    return {
      type: MessageItemType.IMAGE,
      image_item: { media, mid_size: args.fileSizeCiphertext },
    }
  }
  if (args.kind === 'video') {
    return {
      type: MessageItemType.VIDEO,
      video_item: { media, video_size: args.fileSizeCiphertext },
    }
  }
  return {
    type: MessageItemType.FILE,
    file_item: { media, file_name: args.fileName, len: String(args.fileSize) },
  }
}
