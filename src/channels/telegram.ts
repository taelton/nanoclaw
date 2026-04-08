import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot (caller handles this)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

// Cache of Api instances keyed by token — avoids creating a new instance per message
const dedicatedApis = new Map<string, Api>();

/**
 * Send a message using a dedicated bot token pinned to a specific group.
 * Unlike pool bots, this bot is never renamed and never shared.
 */
export async function sendWithDedicatedToken(
  chatId: string,
  text: string,
  token: string,
): Promise<void> {
  let api = dedicatedApis.get(token);
  if (!api) {
    api = new Api(token);
    dedicatedApis.set(token, api);
    logger.info({ chatId }, 'Dedicated group bot initialized');
  }
  // Handle synthetic DM JIDs: tg:<botId>_<userId> → send to <userId>
  const jidPart = chatId.replace(/^tg:/, '');
  const numericId = jidPart.includes('_') ? jidPart.split('_')[1] : jidPart;
  const MAX_LENGTH = 4096;
  try {
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(api, numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, length: text.length }, 'Dedicated bot message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send dedicated bot message');
  }
}

/**
 * Download a Telegram file to an agent group's attachments directory.
 * Shared by TelegramChannel and group polling bots.
 * Returns the container-relative path or null if the download fails.
 */
async function downloadTelegramFile(
  bot: Bot,
  botToken: string,
  fileId: string,
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'Telegram getFile returned no file_path');
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    const tgExt = path.extname(file.file_path);
    const localExt = path.extname(filename);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = localExt ? safeName : `${safeName}${tgExt}`;
    const destPath = path.join(attachDir, finalName);

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      logger.warn({ fileId, status: resp.status }, 'Telegram file download failed');
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);

    logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
    return `/workspace/group/attachments/${finalName}`;
  } catch (err) {
    logger.error({ fileId, err }, 'Failed to download Telegram file');
    return null;
  }
}

/**
 * Attach text and media message handlers to a bot instance.
 * Used by both TelegramChannel (main bot) and group polling bots.
 * If chatJidFilter is provided, only messages from that specific chat are processed.
 */
function attachMessageHandlers(
  bot: Bot,
  botToken: string,
  opts: TelegramChannelOpts,
  chatJidFilter?: string,
  privateChatOpts?: {
    botNumericId: number;
    canonicalChatJid: string;
    onDynamicJid?: (syntheticJid: string) => void;
  },
): void {
  // Telegram bot commands handled separately — skip them here so they don't get stored as messages.
  const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
      if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
    }

    const rawChatJid = `tg:${ctx.chat.id}`;
    const isPrivate = ctx.chat.type === 'private';

    // For dedicated group bots: use a synthetic JID for private chats so DMs
    // to different bots don't collide on the same user ID.
    let chatJid = rawChatJid;
    if (isPrivate && privateChatOpts) {
      chatJid = `tg:${privateChatOpts.botNumericId}_${ctx.from!.id}`;
      if (!opts.registeredGroups()[chatJid]) {
        privateChatOpts.onDynamicJid?.(chatJid);
      }
    }

    // For non-private chats, apply the optional filter
    if (!isPrivate && chatJidFilter && rawChatJid !== chatJidFilter) return;

    let content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id.toString() ||
      'Unknown';
    const sender = ctx.from?.id.toString() || '';
    const msgId = ctx.message.message_id.toString();
    const threadId = ctx.message.message_thread_id;

    const replyTo = ctx.message.reply_to_message;
    const replyToMessageId = replyTo?.message_id?.toString();
    const replyToContent = replyTo?.text || replyTo?.caption;
    const replyToSenderName = replyTo
      ? replyTo.from?.first_name ||
        replyTo.from?.username ||
        replyTo.from?.id?.toString() ||
        'Unknown'
      : undefined;

    const chatName =
      ctx.chat.type === 'private'
        ? senderName
        : (ctx.chat as any).title || chatJid;

    // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
    const botUsername = ctx.me?.username?.toLowerCase();
    if (botUsername) {
      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity) => {
        if (entity.type === 'mention') {
          const mentionText = content
            .substring(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          return mentionText === `@${botUsername}`;
        }
        return false;
      });
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const isGroup =
      ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    // For private chats on dedicated group bots, fall back to the canonical group
    const group = opts.registeredGroups()[chatJid]
      ?? (privateChatOpts ? opts.registeredGroups()[privateChatOpts.canonicalChatJid] : undefined);
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
      return;
    }

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      thread_id: threadId ? threadId.toString() : undefined,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSenderName,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
  });

  // Handle non-text messages: download files when possible, fall back to placeholders.
  const storeMedia = (
    ctx: any,
    placeholder: string,
    mediaOpts: { fileId?: string; filename?: string } = {},
  ) => {
    const rawChatJid = `tg:${ctx.chat.id}`;
    const isPrivate = ctx.chat.type === 'private';

    let chatJid = rawChatJid;
    if (isPrivate && privateChatOpts) {
      chatJid = `tg:${privateChatOpts.botNumericId}_${ctx.from!.id}`;
      if (!opts.registeredGroups()[chatJid]) {
        privateChatOpts.onDynamicJid?.(chatJid);
      }
    }

    if (!isPrivate && chatJidFilter && rawChatJid !== chatJidFilter) return;

    const group = opts.registeredGroups()[chatJid]
      ?? (privateChatOpts ? opts.registeredGroups()[privateChatOpts.canonicalChatJid] : undefined);
    if (!group) return;

    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown';
    const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

    const isGroup =
      ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    const deliver = (content: string) => {
      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    if (mediaOpts.fileId) {
      const msgId = ctx.message.message_id.toString();
      const filename =
        mediaOpts.filename ||
        `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
      downloadTelegramFile(bot, botToken, mediaOpts.fileId, group.folder, filename).then(
        (filePath) => {
          if (filePath) {
            deliver(`${placeholder} (${filePath})${caption}`);
          } else {
            deliver(`${placeholder}${caption}`);
          }
        },
      );
      return;
    }

    deliver(`${placeholder}${caption}`);
  };

  bot.on('message:photo', (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos?.[photos.length - 1];
    storeMedia(ctx, '[Photo]', {
      fileId: largest?.file_id,
      filename: `photo_${ctx.message.message_id}`,
    });
  });
  bot.on('message:video', (ctx) => {
    storeMedia(ctx, '[Video]', {
      fileId: ctx.message.video?.file_id,
      filename: `video_${ctx.message.message_id}`,
    });
  });
  bot.on('message:voice', (ctx) => {
    storeMedia(ctx, '[Voice message]', {
      fileId: ctx.message.voice?.file_id,
      filename: `voice_${ctx.message.message_id}`,
    });
  });
  bot.on('message:audio', (ctx) => {
    const name =
      ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
    storeMedia(ctx, '[Audio]', {
      fileId: ctx.message.audio?.file_id,
      filename: name,
    });
  });
  bot.on('message:document', (ctx) => {
    const name = ctx.message.document?.file_name || 'file';
    storeMedia(ctx, `[Document: ${name}]`, {
      fileId: ctx.message.document?.file_id,
      filename: name,
    });
  });
  bot.on('message:sticker', (ctx) => {
    const emoji = ctx.message.sticker?.emoji || '';
    storeMedia(ctx, `[Sticker ${emoji}]`);
  });
  bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
  bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));
}

// Map of chatJid → running Bot instance for group-specific polling
const groupPollingBots = new Map<string, Bot>();

/**
 * Start a dedicated polling loop for a registered group.
 * The group's bot token handles both sending and receiving for its chat.
 * Safe to call multiple times — skips if already polling for this chatJid.
 */
export async function startGroupPolling(
  token: string,
  canonicalChatJid: string,
  opts: TelegramChannelOpts,
  onDynamicJid?: (syntheticJid: string) => void,
): Promise<void> {
  if (groupPollingBots.has(canonicalChatJid)) {
    logger.warn({ canonicalChatJid }, 'Group polling already started, skipping');
    return;
  }

  const bot = new Bot(token, {
    client: { baseFetchConfig: { agent: https.globalAgent, compress: true } },
  });

  // Get bot's numeric ID for synthetic private-chat JIDs (avoids user ID collisions)
  const botInfo = await bot.api.getMe();
  const botNumericId = botInfo.id;

  // No chatJidFilter — the bot handles all chats it's in.
  // Synthetic JIDs prevent collisions for private chats.
  attachMessageHandlers(bot, token, opts, undefined, {
    botNumericId,
    canonicalChatJid,
    onDynamicJid,
  });

  bot.catch((err) => {
    logger.error({ err: err.message, canonicalChatJid }, 'Group polling bot error');
  });

  groupPollingBots.set(canonicalChatJid, bot);

  // Start polling in background (do not await — runs forever)
  bot.start({
    onStart: (info) => {
      logger.info(
        { username: info.username, botNumericId, canonicalChatJid },
        'Group polling bot started',
      );
    },
  });
}

/**
 * Stop polling for a specific group (e.g., on group unregistration).
 */
export async function stopGroupPolling(chatJid: string): Promise<void> {
  const bot = groupPollingBots.get(chatJid);
  if (bot) {
    await bot.stop();
    groupPollingBots.delete(chatJid);
    logger.info({ chatJid }, 'Group polling bot stopped');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    attachMessageHandlers(this.bot, this.botToken, this.opts);

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_LEO']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    envVars.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN_LEO ||
    envVars.TELEGRAM_BOT_TOKEN_LEO ||
    '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
