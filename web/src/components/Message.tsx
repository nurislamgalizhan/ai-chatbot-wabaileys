import { useState } from "react";
import type { Message } from "../api/endpoints";
import { dateLong, timeOnly } from "../lib/format";
import Icon, { type IconName } from "./Icon";
import { Spinner } from "./ui";

/** A message as either view receives it. The chief's view adds the kept
 *  original of deleted messages and the edit history. */
export type ViewMessage = Message & {
  deleted?: boolean;
  deleted_by?: string | null;
  deleted_at?: number | null;
  edited?: boolean;
  edits?: { body: string | null; at: number }[];
};

export const KIND_ICON: Record<string, IconName> = {
  voice: "mic",
  audio: "mic",
  image: "image",
  video: "image",
  document: "file",
  location: "globe",
  contact: "user",
  other: "file",
};
export const KIND_LABEL: Record<string, string> = {
  voice: "Голосовое сообщение",
  audio: "Аудио",
  image: "Фото",
  video: "Видео",
  document: "Документ",
  location: "Геолокация",
  contact: "Контакт",
  other: "Вложение",
};

const fmtSize = (n: number | null) =>
  !n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`;

/** Photos, videos, voice notes and documents are shown to people only —
 *  none of them is ever sent to the AI. */
function MediaView({ m, href, onOpen }: { m: ViewMessage; href: string; onOpen: (url: string) => void }) {
  const [broken, setBroken] = useState(false);
  const label = KIND_LABEL[m.kind] ?? "Вложение";
  if (m.media_state === "none") return null;
  if (m.media_state === "too_large" || m.media_state === "expired" || broken) {
    return (
      <div className="media-note">
        <Icon name={KIND_ICON[m.kind] ?? "file"} size={15} /> {label}
        <span className="muted">
          {" "}
          ·{" "}
          {m.media_state === "too_large"
            ? "файл слишком большой — откройте на телефоне"
            : m.media_state === "expired"
              ? "удалён по сроку хранения"
              : "не удалось загрузить — откройте на телефоне"}
        </span>
      </div>
    );
  }
  if (m.media_state === "pending") {
    return (
      <div className="media-note">
        <Spinner size={13} /> {label} загружается…
      </div>
    );
  }
  if (m.kind === "image") {
    return (
      <button type="button" className="media-img" onClick={() => onOpen(href)} aria-label="Открыть фото">
        <img src={href} alt="Фото" loading="lazy" onError={() => setBroken(true)} />
      </button>
    );
  }
  if (m.kind === "video") {
    return <video className="media-video" src={href} controls preload="metadata" onError={() => setBroken(true)} />;
  }
  if (m.kind === "voice" || m.kind === "audio") {
    return <audio className="media-audio" src={href} controls preload="none" onError={() => setBroken(true)} />;
  }
  return (
    <a className="doc-card" href={href} download>
      <span className="doc-icon">
        <Icon name="file" size={20} />
      </span>
      <span className="doc-body">
        <b>{m.media_name || label}</b>
        <span>{fmtSize(m.media_size)} · скачать</span>
      </span>
      <Icon name="download" size={16} className="doc-dl" />
    </a>
  );
}

export function Bubble({
  m,
  href,
  onOpen,
  chief = false,
  highlight = false,
}: {
  m: ViewMessage;
  href: string;
  onOpen: (url: string) => void;
  /** Chief's view: show what was deleted and every earlier version. */
  chief?: boolean;
  highlight?: boolean;
}) {
  const [showEdits, setShowEdits] = useState(false);
  if (m.source === "system") {
    return (
      <div className="sys-note">
        <Icon name="alert" size={15} /> {m.body}
      </div>
    );
  }
  const out = m.direction === "out";
  const who =
    m.source === "ai"
      ? "Alma AI"
      : m.source === "operator_panel"
        ? "Менеджер · кабинет"
        : m.source === "operator_phone"
          ? "Менеджер · телефон"
          : null;
  const classes = ["msg", out ? "out" : "in", `src-${m.source}`];
  if (m.kind === "image" || m.kind === "video") classes.push("visual");
  if (m.deleted) classes.push("deleted");
  if (highlight) classes.push("focus");

  // Managers: WhatsApp-like placeholder, nothing of the original.
  if (m.deleted && !chief) {
    return (
      <div className={classes.join(" ")} data-mid={m.id}>
        <div className="bubble">
          <div className="text gone">
            <Icon name="x" size={13} /> Сообщение удалено
          </div>
          <div className="meta">
            <span>{timeOnly(m.created_at)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={classes.join(" ")} data-mid={m.id}>
      <div className="bubble">
        {m.deleted && chief && (
          <div className="deleted-tag">
            <Icon name="trash" size={12} /> Удалено {m.deleted_by === "business" ? "с телефона компании" : "клиентом"}
            {m.deleted_at ? ` · ${dateLong(m.deleted_at)} ${timeOnly(m.deleted_at)}` : ""}
          </div>
        )}
        {who && (
          <div className="who">
            <Icon name={m.source === "ai" ? "sparkles" : "user"} size={13} /> {who}
          </div>
        )}
        {m.kind !== "text" && m.media_state !== "none" && <MediaView m={m} href={href} onOpen={onOpen} />}
        {m.kind !== "text" && m.media_state === "none" && (
          <div className="media">
            <Icon name={KIND_ICON[m.kind] ?? "file"} size={15} /> {KIND_LABEL[m.kind] ?? "Вложение"}
          </div>
        )}
        {(m.kind === "voice" || m.kind === "audio") && (
          <div className="transcript">
            {m.transcript ? `«${m.transcript}»` : m.media_state === "stored" && !out ? "расшифровка недоступна" : null}
          </div>
        )}
        {m.body && <div className="text">{m.body}</div>}
        {chief && showEdits && m.edits && m.edits.length > 0 && (
          <div className="edit-history">
            {m.edits.map((e, i) => (
              <div key={i}>
                <span className="muted small">
                  было до {timeOnly(e.at)}:
                </span>{" "}
                <s>{e.body}</s>
              </div>
            ))}
          </div>
        )}
        <div className="meta">
          {m.handoff && <span className="handoff-tag">передано менеджеру</span>}
          {m.edited &&
            (chief && m.edits && m.edits.length > 0 ? (
              <button type="button" className="edited-btn" onClick={() => setShowEdits((v) => !v)}>
                изменено · {showEdits ? "скрыть" : "что было"}
              </button>
            ) : (
              <span>изменено</span>
            ))}
          <span>{timeOnly(m.created_at)}</span>
          {out && m.status === "pending" && <Icon name="clock" size={13} />}
          {out && (m.status === "sent" || m.status === "ok") && <Icon name="checks" size={14} />}
          {out && m.status === "failed" && (
            <span className="failed">
              <Icon name="alert" size={13} /> не доставлено
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
