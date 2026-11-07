import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorText } from "../api/client";
import type { ChatItem } from "../api/endpoints";
import { ColumnChart, SERIES, ShareBar } from "../components/charts";
import Icon, { type IconName, Logo } from "../components/Icon";
import { Bubble } from "../components/Message";
import { Avatar, Empty, PageLoader, Segmented, Spinner, Toaster, toast } from "../components/ui";
import { dateLong, dayLabel, duration, formatPhone, nf, shortDay, timeOnly, timeShort } from "../lib/format";
import {
  type CheckFilter,
  checkCalls,
  checkChat,
  checkChats,
  checkHistory,
  checkLogin,
  checkLogout,
  checkMe,
  checkMediaUrl,
  checkMessages,
  checkProfile,
  checkSearch,
  checkSummary,
  type CheckMe,
} from "./api";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});

const nameOf = (c: { name: string | null; phone: string | null }) => c.name?.trim() || formatPhone(c.phone) || "Клиент";

/* ---------- sign in with the access key ---------- */

function KeyLogin() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const mut = useMutation({
    mutationFn: () => checkLogin(key),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["check-me"] }),
  });
  const clean = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pretty = (clean.match(/.{1,4}/g) ?? []).join("-");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (clean.length === 24 && !mut.isPending) mut.mutate();
  }
  return (
    <div className="check-login">
      <div className="aurora" aria-hidden="true">
        <span className="a1" />
        <span className="a2" />
        <span className="a3" />
      </div>
      <form className="check-login-card" onSubmit={submit}>
        <div className="check-brand">
          <Logo size={40} />
          <div>
            <b>
              Alma <em>AI</em>
            </b>
            <span>Режим руководителя</span>
          </div>
        </div>
        <h1>Вход по ключу доступа</h1>
        <p className="lead">Ключ выдаёт администратор Alma AI. Вводить логин и пароль не нужно.</p>
        <label htmlFor="chk-key">Ключ доступа</label>
        <input
          id="chk-key"
          className="input key-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={pretty}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        {mut.isError && (
          <div className="alert danger">
            <Icon name="alert" size={17} />
            <div>{errorText(mut.error)}</div>
          </div>
        )}
        <button className="btn primary lg block" disabled={clean.length !== 24 || mut.isPending}>
          {mut.isPending ? <Spinner /> : <Icon name="lock" size={17} />} Войти
        </button>
        <ul className="check-promises">
          <li>
            <Icon name="eye-off" size={16} /> Клиенты и менеджеры не узнают, что вы смотрите
          </li>
          <li>
            <Icon name="smartphone" size={16} /> Без ещё одного связанного устройства на телефоне
          </li>
        </ul>
      </form>
    </div>
  );
}

/* ---------- contact profile ---------- */

function ProfilePanel({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  const chat = useQuery({ queryKey: ["check-chat", chatId], queryFn: () => checkChat(chatId) });
  const prof = useQuery({ queryKey: ["check-profile", chatId], queryFn: () => checkProfile(chatId), staleTime: 3600_000 });
  const c = chat.data;
  const p = prof.data;
  return (
    <aside className="profile-panel">
      <header>
        <h3>Профиль клиента</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <Icon name="x" />
        </button>
      </header>
      {c && (
        <div className="profile-body">
          {p?.photo ? (
            <img className="profile-photo" src={p.photo} alt="" />
          ) : (
            <Avatar name={nameOf(c)} seed={c.phone ?? String(c.id)} size={96} />
          )}
          <h2>{nameOf(c)}</h2>
          <div className="muted">{formatPhone(c.phone) || "номер скрыт WhatsApp"}</div>
          {prof.isPending && <Spinner />}
          {p?.about && <p className="about">«{p.about}»</p>}
          {p?.business && (
            <div className="biz">
              <b>
                <Icon name="target" size={15} /> Бизнес-аккаунт
              </b>
              {p.business.category && <span>{p.business.category}</span>}
              {p.business.description && <span>{p.business.description}</span>}
              {p.business.address && <span>📍 {p.business.address}</span>}
              {p.business.website && <span>🌐 {p.business.website}</span>}
              {p.business.email && <span>✉️ {p.business.email}</span>}
            </div>
          )}
          <dl className="profile-stats">
            <dt>Первое сообщение</dt>
            <dd>{c.first_message_at ? dateLong(c.first_message_at) : "—"}</dd>
            <dt>Сообщений</dt>
            <dd>{nf(c.message_count)}</dd>
            <dt>Ответов AI</dt>
            <dd>{nf(c.ai_count)}</dd>
            <dt>Удалено</dt>
            <dd>{nf(c.deleted_count)}</dd>
            <dt>Изменено</dt>
            <dd>{nf(c.edited_count)}</dd>
          </dl>
        </div>
      )}
    </aside>
  );
}

/* ---------- one conversation, read-only ---------- */

function Conversation({ chatId, focus, onBack }: { chatId: number; focus: number | null; onBack: () => void }) {
  const [viewer, setViewer] = useState<string | null>(null);
  const [profile, setProfile] = useState(false);
  const [asked, setAsked] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const chat = useQuery({ queryKey: ["check-chat", chatId], queryFn: () => checkChat(chatId), refetchInterval: 15_000 });
  const msgs = useInfiniteQuery({
    queryKey: ["check-messages", chatId],
    queryFn: ({ pageParam }) => checkMessages(chatId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: 5000,
  });
  const messages = useMemo(() => {
    const seen = new Set<number>();
    return (msgs.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  }, [msgs.data]);
  const history = useMutation({
    mutationFn: () => checkHistory(chatId),
    onSuccess: () => {
      setAsked(true);
      toast("Запросили историю у телефона — сообщения появятся через несколько секунд");
    },
    onError: (e) => toast(errorText(e) ?? "Не удалось", "error"),
  });

  // Jump to a message found by search: load older pages until it is there.
  useEffect(() => {
    if (!focus || msgs.isFetching) return;
    if (messages.some((m) => m.id === focus)) {
      stick.current = false;
      scroller.current?.querySelector(`[data-mid="${focus}"]`)?.scrollIntoView({ block: "center" });
    } else if (msgs.hasNextPage && (msgs.data?.pages.length ?? 0) < 40) {
      void msgs.fetchNextPage();
    }
  }, [focus, messages, msgs]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && !focus) el.scrollTop = el.scrollHeight;
  }, [messages.length, chatId, focus]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);

  const c = chat.data;
  if (!c) {
    return (
      <section className="dialog center">
        <Spinner size={26} />
      </section>
    );
  }
  const name = nameOf(c);
  let lastDay = "";
  return (
    <section className={`dialog ${profile ? "with-profile" : ""}`}>
      <div className="dialog-main">
        <header className="dialog-head">
          <button className="icon-btn back" onClick={onBack} aria-label="К списку чатов">
            <Icon name="chevron-left" />
          </button>
          <button className="peer-btn" onClick={() => setProfile((v) => !v)} title="Профиль клиента">
            <Avatar name={name} seed={c.phone ?? String(c.id)} size={42} />
            <span className="peer">
              <span className="name">{name}</span>
              <span className="sub">
                {formatPhone(c.phone) || "номер скрыт WhatsApp"}
                <span className="hide-sm"> · {nf(c.message_count)} сообщ.</span>
              </span>
            </span>
          </button>
          <div className="dialog-actions">
            {c.deleted_count > 0 && (
              <span className="pill danger" title="Удалённые сообщения сохранены">
                <Icon name="trash" size={12} /> {c.deleted_count}
              </span>
            )}
            {c.needs_attention && <span className="pill warn">ждёт менеджера</span>}
            <button className="btn sm ghost" onClick={() => setProfile((v) => !v)}>
              <Icon name="user" size={15} /> <span className="hide-sm">Профиль</span>
            </button>
          </div>
        </header>
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
            messages.length > 0 && (
              <button className="load-earlier" onClick={() => history.mutate()} disabled={history.isPending || asked}>
                <Icon name="refresh" size={14} /> {asked ? "История запрошена у телефона" : "Загрузить более раннюю историю из WhatsApp"}
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
                <Bubble m={m} href={checkMediaUrl(chatId, m.id)} onOpen={setViewer} chief highlight={m.id === focus} />
              </Fragment>
            );
          })}
        </div>
        <div className="observer-bar">
          <Icon name="eye" size={16} /> Режим наблюдения: писать отсюда нельзя, и никто не видит, что вы читаете
        </div>
      </div>
      {profile && <ProfilePanel chatId={chatId} onClose={() => setProfile(false)} />}
      {viewer && (
        <div className="lightbox" role="dialog" aria-label="Просмотр фото" onClick={() => setViewer(null)}>
          <img src={viewer} alt="Фото" />
          <a className="lightbox-dl" href={viewer} download onClick={(e) => e.stopPropagation()}>
            <Icon name="download" size={16} /> Скачать
          </a>
        </div>
      )}
    </section>
  );
}

/* ---------- chats tab ---------- */

const FILTERS: { key: CheckFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "attention", label: "Ждут менеджера" },
  { key: "human", label: "Без AI" },
  { key: "deleted", label: "С удалёнными" },
];

function ChatsTab({ open, onOpen }: { open: { chat: number; focus: number | null } | null; onOpen: (o: { chat: number; focus: number | null } | null) => void }) {
  const [filter, setFilter] = useState<CheckFilter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const list = useInfiniteQuery({
    queryKey: ["check-chats", filter, q],
    queryFn: ({ pageParam }) => checkChats(filter, q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 6000,
  });
  const chats: ChatItem[] = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  return (
    <div className={`chats ${open ? "has-selection" : ""}`}>
      <aside className="chat-list">
        <div className="search">
          <Icon name="search" size={17} />
          <input placeholder="Имя, номер или текст" value={search} onChange={(e) => setSearch(e.target.value)} />
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
          {!list.isPending && chats.length === 0 && <Empty icon="chat" title="Нет диалогов" />}
          {chats.map((c) => {
            const name = nameOf(c);
            return (
              <button
                key={c.id}
                className={`chat-row ${c.id === open?.chat ? "selected" : ""}`}
                onClick={() => onOpen({ chat: c.id, focus: null })}
              >
                <Avatar name={name} seed={c.phone ?? String(c.id)} size={44} />
                <span className="chat-row-body">
                  <span className="top">
                    <span className="name">{name}</span>
                    <span className="time">{timeShort(c.last_message_at)}</span>
                  </span>
                  <span className="bottom">
                    <span className="preview">{c.last_message_preview ?? "—"}</span>
                  </span>
                  {(c.needs_attention || c.mode !== "auto") && (
                    <span className="flags">
                      {c.needs_attention && <span className="flag warn">ждёт менеджера</span>}
                      {c.mode !== "auto" && <span className="flag m-human">AI не отвечает</span>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {list.hasNextPage && (
            <button className="load-earlier" onClick={() => void list.fetchNextPage()}>
              Показать ещё
            </button>
          )}
        </div>
      </aside>
      {open ? (
        <Conversation key={`${open.chat}`} chatId={open.chat} focus={open.focus} onBack={() => onOpen(null)} />
      ) : (
        <section className="dialog placeholder">
          <div className="placeholder-art" aria-hidden="true">
            <Icon name="eye" size={40} strokeWidth={1.4} />
          </div>
          <h3>Выберите диалог</h3>
          <p className="muted">Вся переписка рабочего номера — с ответами AI и менеджеров, удалёнными и изменёнными сообщениями.</p>
        </section>
      )}
    </div>
  );
}

/* ---------- search tab ---------- */

function Highlight({ text }: { text: string }) {
  // Markers \u0002…\u0003 come from the server; rendered as React text (no HTML).
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0002") ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}

function SearchTab({ onOpen }: { onOpen: (chat: number, focus: number) => void }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const res = useQuery({ queryKey: ["check-search", q], queryFn: () => checkSearch(q), enabled: q.length >= 2 });
  const who: Record<string, string> = { customer: "Клиент", ai: "Alma AI", operator_panel: "Менеджер", operator_phone: "Менеджер (телефон)" };
  return (
    <div className="check-page">
      <form
        className="big-search"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <Icon name="search" size={20} />
        <input autoFocus placeholder="Поиск по всей переписке: «скидка», «бағасы», номер заказа…" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn primary" disabled={input.trim().length < 2}>
          Найти
        </button>
      </form>
      {res.isFetching && (
        <div className="center pad">
          <Spinner />
        </div>
      )}
      {res.data && res.data.items.length === 0 && <Empty icon="search" title="Ничего не найдено" text="Попробуйте другое слово или начало слова." />}
      <div className="hits">
        {res.data?.items.map((h) => (
          <button key={h.id} className="hit" onClick={() => onOpen(h.chat_id, h.id)}>
            <Avatar name={nameOf(h)} seed={h.phone ?? String(h.chat_id)} size={38} />
            <span className="hit-body">
              <span className="top">
                <b>{nameOf(h)}</b>
                <span className="muted small">
                  {dateLong(h.created_at)} {timeOnly(h.created_at)}
                </span>
              </span>
              <span className="who-line">
                {who[h.source] ?? h.source}
                {h.deleted && <span className="flag danger">удалено</span>}
              </span>
              <span className="snippet">
                <Highlight text={h.snippet ?? ""} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- calls tab ---------- */

function CallsTab({ onOpen }: { onOpen: (chat: number) => void }) {
  const calls = useQuery({ queryKey: ["check-calls"], queryFn: checkCalls, refetchInterval: 20_000 });
  const label = { missed: "Пропущенный", answered: "Принят", rejected: "Отклонён" } as const;
  const icon: Record<string, IconName> = { missed: "phone", answered: "check", rejected: "x" };
  if (calls.isPending) return <PageLoader />;
  const items = calls.data?.items ?? [];
  return (
    <div className="check-page">
      <p className="muted">
        Входящие звонки на рабочий номер. Alma AI их не принимает и не отклоняет — только записывает, чтобы пропущенные не
        терялись.
      </p>
      {items.length === 0 ? (
        <Empty icon="phone" title="Звонков пока нет" />
      ) : (
        <div className="calls">
          {items.map((c) => (
            <button key={c.id} className={`call-row ${c.outcome}`} disabled={!c.chat_id} onClick={() => c.chat_id && onOpen(c.chat_id)}>
              <span className="call-icon">
                <Icon name={icon[c.outcome] ?? "phone"} size={17} />
              </span>
              <span className="call-body">
                <b>{c.name?.trim() || formatPhone(c.phone) || "Неизвестный номер"}</b>
                <span className="muted small">
                  {label[c.outcome]} · {c.is_video ? "видеозвонок" : "аудиозвонок"}
                </span>
              </span>
              <span className="muted small">
                {dateLong(c.started_at)} {timeOnly(c.started_at)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- summary tab ---------- */

function SummaryTab() {
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const s = useQuery({ queryKey: ["check-summary", days], queryFn: () => checkSummary(Number(days)), placeholderData: (p) => p });
  if (!s.data) return <PageLoader />;
  const d = s.data;
  const tile = (icon: IconName, label: string, value: string, sub?: string, tone?: string) => (
    <div className={`stat ${tone ?? ""}`}>
      <span className="stat-icon">
        <Icon name={icon} size={19} />
      </span>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
  return (
    <div className="check-page">
      <div className="toolbar">
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: "1", label: "Сегодня" },
            { value: "7", label: "7 дней" },
            { value: "30", label: "30 дней" },
          ]}
        />
        <span className="muted small">По времени Алматы</span>
      </div>
      <div className="stats wide">
        {tile("chat", "Сообщений от клиентов", nf(d.totals.incoming))}
        {tile("sparkles", "Ответил AI", nf(d.totals.ai), `передано менеджеру: ${nf(d.totals.handoffs)}`, "green")}
        {tile("user", "Ответили менеджеры", nf(d.totals.operator), `кабинет ${nf(d.operator_split.panel)} · телефон ${nf(d.operator_split.phone)}`, "blue")}
        {tile("bolt", "Время до ответа", duration(d.median_first_reply_sec.ai), `AI · менеджеры: ${duration(d.median_first_reply_sec.human)}`)}
        {tile("bell", "Ждут ответа сейчас", nf(d.waiting_now), undefined, d.waiting_now > 0 ? "warn" : "")}
        {tile("phone", "Пропущенные звонки", nf(d.calls.missed), `всего звонков: ${nf(d.calls.total)}`)}
        {tile("trash", "Удалено клиентами", nf(d.deleted.customer))}
        {tile("trash", "Удалено с телефона компании", nf(d.deleted.business), "сообщения менеджеров")}
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Доля ответов</h2>
          {d.ai_share !== null && <span className="pill green">AI ответил на {d.ai_share}%</span>}
        </div>
        <ShareBar
          parts={[
            { name: SERIES.ai.name, value: d.totals.ai, color: SERIES.ai.color },
            { name: SERIES.operator.name, value: d.totals.operator, color: SERIES.operator.color },
          ]}
        />
      </section>
      {d.days > 1 && (
        <section className="card">
          <div className="card-head">
            <h2>Кто отвечал по дням</h2>
          </div>
          <ColumnChart
            labelEvery={d.by_day.length > 10 ? 5 : 1}
            data={d.by_day.map((x) => ({ key: x.day, label: shortDay(x.day), tooltip: `${shortDay(x.day)} · клиенты написали ${x.incoming}`, values: [x.ai, x.operator] }))}
            series={[SERIES.ai, SERIES.operator]}
          />
        </section>
      )}
    </div>
  );
}

/* ---------- shell ---------- */

type Tab = "chats" | "search" | "calls" | "summary";
const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: "chats", label: "Чаты", icon: "chat" },
  { key: "search", label: "Поиск", icon: "search" },
  { key: "calls", label: "Звонки", icon: "phone" },
  { key: "summary", label: "Сводка", icon: "chart" },
];

function Shell({ me }: { me: CheckMe }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("chats");
  const [open, setOpen] = useState<{ chat: number; focus: number | null } | null>(null);
  const out = useMutation({ mutationFn: checkLogout, onSuccess: () => qc.clear() });
  const waOk = me.whatsapp.status === "connected";
  return (
    <div className="check-shell">
      <header className="check-top">
        <div className="check-brand small">
          <Logo size={32} />
          <div>
            <b>{me.company}</b>
            <span className={waOk ? "ok" : "off"}>
              <i /> {waOk ? `WhatsApp ${formatPhone(me.whatsapp.phone)}` : "WhatsApp не подключён"}
            </span>
          </div>
        </div>
        <nav className="check-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={17} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <button className="icon-btn" title="Выйти" aria-label="Выйти" onClick={() => out.mutate()}>
          <Icon name="logout" />
        </button>
      </header>
      <main className={`check-main ${tab === "chats" ? "fill" : ""}`}>
        {tab === "chats" && <ChatsTab open={open} onOpen={setOpen} />}
        {tab === "search" && (
          <SearchTab
            onOpen={(chat, focus) => {
              setOpen({ chat, focus });
              setTab("chats");
            }}
          />
        )}
        {tab === "calls" && (
          <CallsTab
            onOpen={(chat) => {
              setOpen({ chat, focus: null });
              setTab("chats");
            }}
          />
        )}
        {tab === "summary" && <SummaryTab />}
      </main>
    </div>
  );
}

function Root() {
  const me = useQuery({ queryKey: ["check-me"], queryFn: checkMe, retry: false, refetchInterval: 60_000 });
  useEffect(() => {
    document.title = "Alma AI — руководитель";
  }, []);
  if (me.isPending) return <PageLoader />;
  if (me.error instanceof ApiError && me.error.status === 401) return <KeyLogin />;
  if (!me.data) return <PageLoader />;
  return <Shell me={me.data} />;
}

export default function CheckApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
      <Toaster />
    </QueryClientProvider>
  );
}
