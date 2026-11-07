import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { errorText } from "../api/client";
import {
  type ChatDetail,
  type ChatFilter,
  type ChatItem,
  type ChatMode,
  getAgent,
  getChat,
  getWhatsApp,
  listChats,
  listMessages,
  markRead,
  type Message,
  mediaUrl,
  requestHistory,
  resolveChat,
  sendMessage,
  setChatMode,
} from "../api/endpoints";
import Icon from "../components/Icon";
import { Bubble } from "../components/Message";
import { Avatar, Empty, Spinner, toast } from "../components/ui";
import { dayLabel, formatPhone, timeOnly, timeShort } from "../lib/format";

const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "attention", label: "Ждут ответа" },
  { key: "unread", label: "Непрочитанные" },
  { key: "human", label: "Без AI" },
  { key: "unresolved", label: "Открытые" },
];

function modeLabel(mode: ChatMode, until: number | null): string {
  switch (mode) {
    case "auto":
      return "AI отвечает";
    case "paused":
      return until ? `Пауза до ${timeOnly(until)}` : "Пауза";
    case "human":
      return "Отвечает менеджер";
    default:
      return "AI выключен";
  }
}

const displayName = (c: { name: string | null; phone: string | null }) =>
  c.name?.trim() || formatPhone(c.phone) || "Клиент";

/* ---------- AI mode menu ---------- */

function ModeMenu({ chat, onChanged }: { chat: ChatDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mut = useMutation({
    mutationFn: ({ mode, minutes }: { mode: ChatMode; minutes?: number }) => setChatMode(chat.id, mode, minutes),
    onSuccess: () => {
      setOpen(false);
      onChanged();
    },
    onError: (e) => toast(errorText(e) ?? "Ошибка", "error"),
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="mode-menu" ref={ref}>
      <button className={`mode-pill m-${chat.mode}`} onClick={() => setOpen((v) => !v)} disabled={mut.isPending}>
        <span className="dot" />
        <span className="txt">{modeLabel(chat.mode, chat.paused_until)}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button onClick={() => mut.mutate({ mode: "auto" })}>
            <Icon name="sparkles" size={16} /> AI отвечает
          </button>
          <div className="menu-sep">Поставить AI на паузу</div>
          <div className="menu-row">
            {[
              [30, "30 мин"],
              [60, "1 час"],
              [180, "3 часа"],
              [720, "12 часов"],
            ].map(([m, l]) => (
              <button key={m} onClick={() => mut.mutate({ mode: "paused", minutes: Number(m) })}>
                {l}
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          <button onClick={() => mut.mutate({ mode: "human" })}>
            <Icon name="hand" size={16} /> Отвечает менеджер
          </button>
          <button className="danger" onClick={() => mut.mutate({ mode: "off" })}>
            <Icon name="power" size={16} /> Выключить AI в этом чате
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- dialog ---------- */

function Dialog({ chatId, onBack }: { chatId: number; onBack: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [askedHistory, setAskedHistory] = useState(false);
  const stick = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const chat = useQuery({ queryKey: ["chat", chatId], queryFn: () => getChat(chatId), refetchInterval: 5000 });
  const agent = useQuery({ queryKey: ["agent"], queryFn: getAgent });
  const wa = useQuery({ queryKey: ["whatsapp"], queryFn: getWhatsApp, refetchInterval: 30_000 });
  const msgs = useInfiniteQuery({
    queryKey: ["messages", chatId],
    queryFn: ({ pageParam }) => listMessages(chatId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: 3000,
  });
  const messages = useMemo(() => {
    const all = (msgs.data?.pages ?? []).flatMap((p) => p.items);
    const seen = new Set<number>();
    return all
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  }, [msgs.data]);
  const lastIn = useMemo(() => [...messages].reverse().find((m) => m.direction === "in")?.id ?? 0, [messages]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["chat", chatId] });
    void qc.invalidateQueries({ queryKey: ["chats"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // Opening a dialog (and every new customer message while it is open)
  // marks it read and clears "needs attention".
  useEffect(() => {
    void markRead(chatId)
      .then(refresh)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, lastIn]);

  useEffect(() => {
    stick.current = true;
    setDraft("");
    setAskedHistory(false);
  }, [chatId]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setViewer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  // Keep the view pinned to the newest message unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, chatId]);

  const send = useMutation({
    mutationFn: (body: string) => sendMessage(chatId, body),
    onSuccess: () => {
      setDraft("");
      stick.current = true;
      void qc.invalidateQueries({ queryKey: ["messages", chatId] });
      refresh();
    },
    onError: (e) => toast(errorText(e) ?? "Не удалось отправить", "error"),
  });
  const history = useMutation({
    mutationFn: () => requestHistory(chatId),
    onSuccess: () => {
      setAskedHistory(true);
      toast("Запросили историю у телефона — сообщения появятся через несколько секунд");
    },
    onError: (e) => toast(errorText(e) ?? "Не удалось запросить историю", "error"),
  });
  const resolve = useMutation({
    mutationFn: (v: boolean) => resolveChat(chatId, v),
    onSuccess: (_r, v) => {
      refresh();
      toast(v ? "Диалог отмечен решённым" : "Диалог снова открыт");
    },
  });

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (draft.trim() && !send.isPending) send.mutate(draft.trim());
    }
  }

  useEffect(() => {
    const t = textarea.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  }, [draft]);

  const c = chat.data;
  if (chat.isError) {
    return (
      <section className="dialog">
        <Empty icon="chat" title="Чат не найден" action={<button className="btn ghost" onClick={onBack}>Назад</button>} />
      </section>
    );
  }
  if (!c) {
    return (
      <section className="dialog center">
        <Spinner size={26} />
      </section>
    );
  }
  const name = displayName(c);
  const offline = wa.data && wa.data.status !== "connected";

  let lastDay = "";
  return (
    <section className="dialog">
      <header className="dialog-head">
        <button className="icon-btn back" onClick={onBack} aria-label="К списку чатов">
          <Icon name="chevron-left" />
        </button>
        <Avatar name={name} seed={c.phone ?? String(c.id)} size={42} />
        <div className="peer">
          <div className="name">{name}</div>
          <div className="sub">
            {formatPhone(c.phone) || "номер скрыт WhatsApp"}
            <span className="hide-sm"> · {c.message_count} сообщ.</span>
          </div>
        </div>
        <div className="dialog-actions">
          <ModeMenu chat={c} onChanged={refresh} />
          <button
            className={`btn sm ${c.is_resolved ? "ghost" : "soft"}`}
            onClick={() => resolve.mutate(!c.is_resolved)}
            disabled={resolve.isPending}
            title={c.is_resolved ? "Открыть диалог снова" : "Отметить диалог решённым"}
          >
            <Icon name="check" size={15} />
            <span className="hide-sm">{c.is_resolved ? "Решён" : "Решено"}</span>
          </button>
        </div>
      </header>

      {c.needs_attention && (
        <div className="dialog-banner warn">
          <Icon name="bell" size={16} /> Клиент ждёт ответа менеджера
        </div>
      )}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {msgs.hasNextPage ? (
          <button className="load-earlier" onClick={() => void msgs.fetchNextPage()} disabled={msgs.isFetchingNextPage}>
            {msgs.isFetchingNextPage ? <Spinner size={14} /> : null} Показать более ранние
          </button>
        ) : (
          messages.length > 0 &&
          !offline && (
            <button className="load-earlier" onClick={() => history.mutate()} disabled={history.isPending || askedHistory}>
              {history.isPending ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}
              {askedHistory ? "История запрошена у телефона" : "Загрузить более раннюю историю из WhatsApp"}
            </button>
          )
        )}
        {msgs.isPending && (
          <div className="center grow">
            <Spinner />
          </div>
        )}
        {messages.map((m) => {
          const d = dayLabel(m.created_at);
          const sep = d !== lastDay;
          lastDay = d;
          return (
            <Fragment key={m.id}>
              {sep && <div className="day-sep">{d}</div>}
              <Bubble m={m} href={mediaUrl(chatId, m.id)} onOpen={setViewer} />
            </Fragment>
          );
        })}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !send.isPending) send.mutate(draft.trim());
        }}
      >
        {offline ? (
          <div className="composer-off">
            <Icon name="alert" size={16} /> WhatsApp не подключён. <Link to="/whatsapp">Подключить</Link>
          </div>
        ) : (
          <>
            <textarea
              ref={textarea}
              rows={1}
              placeholder="Написать клиенту…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              maxLength={4000}
            />
            <button className="send" disabled={!draft.trim() || send.isPending} aria-label="Отправить">
              {send.isPending ? <Spinner size={16} /> : <Icon name="send" size={19} />}
            </button>
          </>
        )}
      </form>
      {viewer && (
        <div className="lightbox" role="dialog" aria-label="Просмотр фото" onClick={() => setViewer(null)}>
          <img src={viewer} alt="Фото" />
          <a className="lightbox-dl" href={viewer} download onClick={(e) => e.stopPropagation()}>
            <Icon name="download" size={16} /> Скачать
          </a>
        </div>
      )}
      {!offline && agent.data && agent.data.operator_pause_min > 0 && (
        <div className="composer-hint">
          После вашего ответа AI замолчит в этом чате на {agent.data.operator_pause_min} мин · Enter — отправить,
          Shift+Enter — новая строка
        </div>
      )}
    </section>
  );
}

/* ---------- page ---------- */

export default function ChatsPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const selected = chatId ? Number(chatId) : null;
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ["chats", filter, q],
    queryFn: ({ pageParam }) => listChats(filter, q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 4000,
  });
  const chats: ChatItem[] = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  // ↑/↓ to move through the list (focus outside of inputs).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (chats.length === 0) return;
      e.preventDefault();
      const i = chats.findIndex((c) => c.id === selected);
      const next = e.key === "ArrowDown" ? Math.min(i + 1, chats.length - 1) : Math.max(i - 1, 0);
      navigate(`/chats/${chats[next]!.id}`, { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats, selected, navigate]);

  return (
    <div className={`chats ${selected ? "has-selection" : ""}`}>
      <aside className="chat-list">
        <div className="search">
          <Icon name="search" size={17} />
          <input placeholder="Поиск по имени, номеру, тексту" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="icon-btn sm" onClick={() => setSearch("")} aria-label="Очистить">
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? "active" : ""}`} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="list-scroll">
          {list.isPending && (
            <div className="center pad">
              <Spinner />
            </div>
          )}
          {!list.isPending && chats.length === 0 && (
            <Empty
              icon="chat"
              title={q || filter !== "all" ? "Ничего не найдено" : "Пока нет диалогов"}
              text={
                q || filter !== "all"
                  ? "Попробуйте другой фильтр или запрос."
                  : "Как только клиенты напишут на ваш WhatsApp, диалоги появятся здесь."
              }
            />
          )}
          {chats.map((c) => {
            const name = displayName(c);
            return (
              <button
                key={c.id}
                className={`chat-row ${c.id === selected ? "selected" : ""} ${c.unread_count > 0 ? "unread" : ""}`}
                onClick={() => navigate(`/chats/${c.id}`)}
              >
                <Avatar name={name} seed={c.phone ?? String(c.id)} size={44} />
                <span className="chat-row-body">
                  <span className="top">
                    <span className="name">{name}</span>
                    <span className="time">{timeShort(c.last_message_at)}</span>
                  </span>
                  <span className="bottom">
                    <span className="preview">{c.last_message_preview ?? "—"}</span>
                    {c.unread_count > 0 && <span className="count">{c.unread_count}</span>}
                  </span>
                  {(c.needs_attention || c.mode !== "auto" || c.is_resolved) && (
                    <span className="flags">
                      {c.needs_attention && <span className="flag warn">ждёт менеджера</span>}
                      {c.mode !== "auto" && <span className={`flag m-${c.mode}`}>{modeLabel(c.mode, c.paused_until)}</span>}
                      {c.is_resolved && <span className="flag ok">решён</span>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {list.hasNextPage && (
            <button className="load-earlier" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              Показать ещё
            </button>
          )}
        </div>
      </aside>

      {selected ? (
        <Dialog key={selected} chatId={selected} onBack={() => navigate("/chats")} />
      ) : (
        <section className="dialog placeholder">
          <div className="placeholder-art" aria-hidden="true">
            <Icon name="chat" size={40} strokeWidth={1.4} />
          </div>
          <h3>Выберите диалог</h3>
          <p className="muted">Слева — все переписки с клиентами. Навигация: ↑ / ↓</p>
        </section>
      )}
    </div>
  );
}
