import { IssueStatus, IssueTypeName } from '@server/constants/issue';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { NotificationAgentDiscord } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import {
  Notification,
  hasNotificationType,
  shouldSendAdminNotification,
} from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

enum EmbedColors {
  DEFAULT = 0,
  AQUA = 1752220,
  GREEN = 3066993,
  BLUE = 3447003,
  PURPLE = 10181046,
  GOLD = 15844367,
  ORANGE = 15105570,
  RED = 15158332,
  GREY = 9807270,
  DARKER_GREY = 8359053,
  NAVY = 3426654,
  DARK_AQUA = 1146986,
  DARK_GREEN = 2067276,
  DARK_BLUE = 2123412,
  DARK_PURPLE = 7419530,
  DARK_GOLD = 12745742,
  DARK_ORANGE = 11027200,
  DARK_RED = 10038562,
  DARK_GREY = 9936031,
  LIGHT_GREY = 12370112,
  DARK_NAVY = 2899536,
  LUMINOUS_VIVID_PINK = 16580705,
  DARK_VIVID_PINK = 12320855,
}

interface DiscordImageEmbed {
  url?: string;
  proxy_url?: string;
  height?: number;
  width?: number;
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordRichEmbed {
  title?: string;
  type?: 'rich';
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    icon_url?: string;
    proxy_icon_url?: string;
  };
  image?: DiscordImageEmbed;
  thumbnail?: DiscordImageEmbed;
  provider?: {
    name?: string;
    url?: string;
  };
  author?: {
    name?: string;
    url?: string;
    icon_url?: string;
    proxy_icon_url?: string;
  };
  fields?: Field[];
}

interface DiscordWebhookPayload {
  embeds: DiscordRichEmbed[];
  username?: string;
  avatar_url?: string;
  tts: boolean;
  content?: string;
  allowed_mentions?: {
    parse?: ('users' | 'roles' | 'everyone')[];
    roles?: string[];
    users?: string[];
  };
}

class DiscordAgent
  extends BaseAgent<NotificationAgentDiscord>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentDiscord {
    if (this.settings) return this.settings;
    return getSettings().notifications.agents.discord;
  }

  private getStatusLabel(type: Notification, payload: NotificationPayload): string {
    if (payload.request) {
      switch (type) {
        case Notification.MEDIA_PENDING:
          return 'Pending Approval';
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_AUTO_APPROVED:
          return 'Processing';
        case Notification.MEDIA_AVAILABLE:
          return 'Available';
        case Notification.MEDIA_DECLINED:
          return 'Declined';
        case Notification.MEDIA_FAILED:
          return 'Failed';
      }
    }

    if (payload.issue) {
      switch (type) {
        case Notification.ISSUE_CREATED:
        case Notification.ISSUE_REOPENED:
          return 'Issue Reported';
        case Notification.ISSUE_COMMENT:
          return 'Issue Comment';
        case Notification.ISSUE_RESOLVED:
          return 'Issue Resolved';
      }
    }

    return '';
  }

  /** FIX — Correct media title extraction for Seerr develop */
  private getMediaTitle(payload: NotificationPayload): string {
    if (!payload.media) return 'Unknown';

    const info = (payload.media as any).mediaInfo;

    if (payload.media.mediaType === 'movie') {
      return (
        info?.title ||
        info?.originalTitle ||
        payload.subject ||
        'Unknown'
      );
    }

    // TV series
    return (
      info?.name ||
      info?.originalName ||
      payload.subject ||
      'Unknown'
    );
  }

  /** FIX — Correct year for movie + series */
  private getMediaYear(payload: NotificationPayload): string {
    const info = payload.media?.mediaInfo;
    if (!info) return '';

    const date = info.releaseDate || info.firstAirDate;
    if (!date) return '';

    const yr = new Date(date).getFullYear();
    return isNaN(yr) ? '' : `(${yr})`;
  }

  public buildEmbed(type: Notification, payload: NotificationPayload): DiscordRichEmbed {
    const { applicationUrl } = getSettings().main;
    let color = EmbedColors.DARK_PURPLE;
    const fields: Field[] = [];

    if (payload.request) {
      fields.push({
        name: 'Requested By',
        value: payload.request.requestedBy.displayName,
        inline: true,
      });

      switch (type) {
        case Notification.MEDIA_PENDING:
          color = EmbedColors.ORANGE;
          break;
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_AUTO_APPROVED:
          color = EmbedColors.PURPLE;
          break;
        case Notification.MEDIA_AVAILABLE:
          color = EmbedColors.GREEN;
          break;
        case Notification.MEDIA_DECLINED:
        case Notification.MEDIA_FAILED:
          color = EmbedColors.RED;
          break;
      }

      fields.push({
        name: 'Request Status',
        value: this.getStatusLabel(type, payload),
        inline: true,
      });
    }
for (const extra of payload.extra ?? []) {
  fields.push({
    name: extra.name,
    value: extra.value,
    inline: true,
  });
}

const url = applicationUrl
  ? payload.issue
    ? `${applicationUrl}/issues/${payload.issue.id}`
    : payload.media
      ? `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`
      : undefined
  : undefined;
    return {
      title: payload.subject,
      url,
      description: payload.message,
      color,
      timestamp: new Date().toISOString(),
      thumbnail: {
        url: payload.image,
      },
      fields,
    };
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();
    return settings.enabled && settings.options.webhookUrl ? true : false;
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();

    if (!payload.notifySystem || !hasNotificationType(type, settings.types ?? 0))
      return true;

    logger.debug('Sending Discord notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });

    const userMentions: string[] = [];

    try {
      // Mentions
      if (settings.options.enableMentions) {
        if (payload.notifyUser?.settings?.discordId) {
          userMentions.push(`<@${payload.notifyUser.settings.discordId}>`);
        }

        if (payload.notifyAdmin) {
          const repo = getRepository(User);
          const users = await repo.find();

          userMentions.push(
            ...users
              .filter(
                (u) =>
                  u.settings?.discordId &&
                  shouldSendAdminNotification(type, u, payload)
              )
              .map((u) => `<@${u.settings?.discordId}>`)
          );
        }
      }

      const embed = this.buildEmbed(type, payload);

      const statusLabel = this.getStatusLabel(type, payload);
      const mediaTitle = this.getMediaTitle(payload);
      const mediaYear = this.getMediaYear(payload);

      await axios.post(settings.options.webhookUrl, {
        username:
          settings.options.botUsername || getSettings().main.applicationTitle,
        avatar_url: settings.options.botAvatarUrl,
        embeds: [embed],
        content: `**${mediaTitle} ${mediaYear} — ${statusLabel}**\n${userMentions.join(' ')}`,
      } as DiscordWebhookPayload);

      return true;
    } catch (e) {
      logger.error('Error sending Discord notification', {
        label: 'Notifications',
        errorMessage: e.message,
        response: e.response?.data,
      });
      return false;
    }
  }
}

export default DiscordAgent;
