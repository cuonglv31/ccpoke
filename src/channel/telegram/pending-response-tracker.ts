import TelegramBot from "node-telegram-bot-api";

import { SessionState, type SessionMap } from "../../tmux/session-map.js";
import { logger } from "../../utils/log.js";

const PROGRESS_INTERVAL_MS = 30_000; // 30 seconds
const MAX_DURATION_MS = 20 * 60 * 1000; // 20 minutes

interface PendingEntry {
  chatId: number;
  messageId: number;
  sessionId: string;
  project: string;
  startTime: number;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s > 0 ? `${min}:${s.toString().padStart(2, "0")}` : `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

export class PendingResponseTracker {
  private entries = new Map<string, PendingEntry>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private bot: TelegramBot,
    private sessionMap: SessionMap | null,
    private getT: (key: string, params?: Record<string, string>) => string
  ) {}

  add(chatId: number, messageId: number, sessionId: string, project: string): void {
    const key = `${chatId}:${messageId}`;
    this.entries.set(key, { chatId, messageId, sessionId, project, startTime: Date.now() });
    this.ensureInterval();
  }

  removeByMessage(chatId: number, messageId: number): void {
    this.entries.delete(`${chatId}:${messageId}`);
  }

  removeBySession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(key);
        break;
      }
    }
  }

  private ensureInterval(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), PROGRESS_INTERVAL_MS);
    logger.debug("[PendingResponse] started progress interval");
  }

  private tick(): void {
    if (!this.sessionMap || this.entries.size === 0) {
      if (this.entries.size === 0 && this.interval) {
        clearInterval(this.interval);
        this.interval = null;
        logger.debug("[PendingResponse] stopped progress interval");
      }
      return;
    }

    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, entry] of this.entries) {
      const session = this.sessionMap.getBySessionId(entry.sessionId);
      const elapsed = now - entry.startTime;

      if (elapsed > MAX_DURATION_MS) {
        toRemove.push(key);
        continue;
      }

      if (!session || session.state !== SessionState.Busy) {
        toRemove.push(key);
        continue;
      }

      const elapsedStr = formatElapsed(elapsed);
      const text = this.getT("chat.processingElapsed", {
        project: entry.project,
        elapsed: elapsedStr,
      });

      this.bot
        .editMessageText(text, {
          chat_id: entry.chatId,
          message_id: entry.messageId,
        })
        .catch((err) => {
          logger.debug({ err, key }, "[PendingResponse] editMessageText failed");
          toRemove.push(key);
        });
    }

    for (const key of toRemove) {
      this.entries.delete(key);
    }
  }

  destroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.entries.clear();
  }
}
