import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  Attachment,
} from 'discord.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.ts',
  '.py',
  '.java',
  '.cpp',
  '.c',
  '.go',
  '.rs',
  '.html',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.sql',
  '.csv',
  '.log',
]);

const MAX_INLINE_LENGTH = 5000;

function isTextFile(att: Attachment): boolean {
  const contentType = att.contentType || '';
  if (contentType.startsWith('text/') || contentType === 'application/json')
    return true;
  const name = att.name || '';
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

async function processAttachment(
  att: Attachment,
  inputDir: string,
): Promise<string> {
  const contentType = att.contentType || '';
  const fileName = att.name || `attachment-${att.id}`;

  const response = await fetch(att.url);
  if (!response.ok) {
    logger.warn(
      { url: att.url, status: response.status },
      'Failed to download attachment',
    );
    return `[Failed to download: ${fileName}]`;
  }

  if (isTextFile(att)) {
    const text = await response.text();
    const truncated =
      text.length > MAX_INLINE_LENGTH
        ? text.slice(0, MAX_INLINE_LENGTH) + '\n[...truncated]'
        : text;
    logger.info({ fileName, size: text.length }, 'Inlined text attachment');
    return `[File: ${fileName}]\n\`\`\`\n${truncated}\n\`\`\``;
  }

  if (contentType.startsWith('video/'))
    return `[Video: ${fileName} — not supported]`;
  if (contentType.startsWith('audio/'))
    return `[Audio: ${fileName} — not supported]`;

  // Images and other binary files: save to IPC input dir
  const filePath = join(inputDir, fileName);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  const containerPath = `/workspace/ipc/input/${fileName}`;
  const label = contentType.startsWith('image/') ? 'Image' : 'File';
  logger.info(
    { fileName, filePath },
    `Downloaded ${label.toLowerCase()} attachment`,
  );
  return `[${label}: ${fileName}]\nPath: ${containerPath}`;
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Handle attachments — download and make available to Claude
      if (message.attachments.size > 0) {
        const inputDir = join(resolveGroupIpcPath(group.folder), 'input');
        await mkdir(inputDir, { recursive: true });

        const descriptions = await Promise.all(
          [...message.attachments.values()].map(async (att) => {
            try {
              return await processAttachment(att, inputDir);
            } catch (err) {
              logger.error(
                { att: att.name, err },
                'Error processing attachment',
              );
              return `[Error processing: ${att.name || att.id}]`;
            }
          }),
        );

        const attachmentBlock = descriptions.join('\n\n');
        content = content
          ? `${content}\n\n${attachmentBlock}`
          : attachmentBlock;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}
