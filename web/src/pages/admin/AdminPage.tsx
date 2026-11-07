import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { errorText } from "../../api/client";
import {
  type AdminUser,
  type AuditItem,
  adminAudit,
  adminCancelSender,
  adminLinkSender,
  adminLogout,
  adminLogoutAll,
  adminLogoutSender,
  adminOverview,
  adminSender,
  adminSetAccess,
  adminSetCheck,
  type WhatsAppState,
} from "../../api/endpoints";
import Icon, { Logo } from "../../components/Icon";
import { Modal, Spinner, toast } from "../../components/ui";
import WaLinker from "../../components/WaLinker";
import { dateLong, formatPhone, nf, plural } from "../../lib/format";

const LINKING = new Set(["connecting", "qr", "pairing"]);

/* ---------- dates (Almaty, UTC+5 without DST) ---------- */
const almatyDate = (ms: number) => new Date(ms + 5 * 3600_000).toISOString().slice(0, 10);
function addToDate(iso: string, days: number, months = 0): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (months) dt.setUTCMonth(dt.getUTCMonth() + months);
  if (days) dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const ruDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

/* ---------- AI access editor ---------- */

function AccessModal({ user, today, onClose }: { user: AdminUser; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const current = user.ai_access.until ? almatyDate(user.ai_access.until) : null;
  const base = current && current > today ? current : today;
  const [date, setDate] = useState(current && current >= today ? current : addToDate(today, 0, 1));
  const save = useMutation({
    mutationFn: (until: string | null) => adminSetAccess(user.id, until),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin-overview"] });
      void qc.invalidateQueries({ queryKey: ["admin-audit"] });
      toast(r.ai_access.active ? `Доступ открыт до ${dateLong(r.ai_access.until!)}` : "Доступ к AI отозван");
      onClose();
    },
  });
  const presets: [string, string][] = [
    ["+7 дней", addToDate(base, 7)],
    ["+1 месяц", addToDate(base, 0, 1)],
    ["+3 месяца", addToDate(base, 0, 3)],
    ["+6 месяцев", addToDate(base, 0, 6)],
    ["+1 год", addToDate(base, 0, 12)],
  ];
  return (
    <Modal
      title="Доступ к AI"
      onClose={onClose}
      wide
      footer={
        <>
          {user.ai_access.active && (
            <button className="btn ghost danger-text" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Отозвать доступ
            </button>
          )}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn primary" disabled={!date || date < today || save.isPending} onClick={() => save.mutate(date)}>
            {save.isPending ? <Spinner /> : <Icon name="check" size={16} />} Открыть до {date ? ruDate(date) : "…"}
          </button>
        </>
      }
    >
      <div className="access-user">
        <b>{user.name}</b>
        <span className="muted">
          {user.company ? `${user.company} · ` : ""}
          {formatPhone(user.phone)}
        </span>
        <span className={`pill ${user.ai_access.active ? "green" : "warn"}`}>
          {user.ai_access.active
            ? `сейчас: до ${dateLong(user.ai_access.until!)}`
            : user.ai_access.until
              ? `истёк ${dateLong(user.ai_access.until)}`
              : "доступа не было"}
        </span>
      </div>
      <label>Быстро продлить {current && current > today ? "от текущей даты окончания" : "от сегодня"}</label>
      <div className="preset-row">
        {presets.map(([l, d]) => (
          <button key={l} className={`chip ${date === d ? "active" : ""}`} onClick={() => setDate(d)}>
            {l}
          </button>
        ))}
      </div>
      <label htmlFor="acc-date">Доступ действует по (включительно)</label>
      <input id="acc-date" type="date" className="input" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
      <p className="hint">До 23:59 по времени Алматы. За 3 дня до окончания клиент получит напоминание в WhatsApp.</p>
      {save.isError && <div className="alert danger">{errorText(save.error)}</div>}
    </Modal>
  );
}

/* ---------- chief's view (check.<domain>) ---------- */

const checkOrigin = () => {
  const host = window.location.hostname;
  if (host.startsWith("app.")) return `${window.location.protocol}//check.${host.slice(4)}`;
  return `${window.location.protocol}//check.localhost${window.location.port ? `:${window.location.port}` : ""}`;
};

function CheckModal({ user, today, onClose }: { user: AdminUser; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const c = user.check;
  const current = c.until ? almatyDate(c.until) : null;
  const base = current && current > today ? current : today;
  const [date, setDate] = useState(current && current >= today ? current : addToDate(today, 0, 1));
  const [key, setKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "off" | null>(null);
  const save = useMutation({
    mutationFn: (v: { until: string | null; rotate?: boolean }) => adminSetCheck(user.id, v.until, v.rotate ?? false),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin-overview"] });
      void qc.invalidateQueries({ queryKey: ["admin-audit"] });
      setConfirm(null);
      if (r.key) setKey(r.key);
      else {
        toast(r.check.active ? `Режим руководителя до ${dateLong(r.check.until!)}` : "Режим руководителя выключен");
        onClose();
      }
    },
  });
  const presets: [string, string][] = [
    ["+1 месяц", addToDate(base, 0, 1)],
    ["+3 месяца", addToDate(base, 0, 3)],
    ["+6 месяцев", addToDate(base, 0, 6)],
    ["+1 год", addToDate(base, 0, 12)],
  ];

  if (key) {
    return (
      <Modal title="Ключ доступа руководителя" onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Готово</button>}>
        <p>
          Передайте ключ руководителю компании <b>{user.company || user.name}</b>. Вход:{" "}
          <a href={checkOrigin()} target="_blank" rel="noopener noreferrer">
            {checkOrigin().replace(/^https?:\/\//, "")}
          </a>
        </p>
        <div className="key-reveal">
          <code>{key}</code>
          <button
            className="btn sm soft"
            onClick={() => {
              void navigator.clipboard?.writeText(key);
              toast("Ключ скопирован");
            }}
          >
            <Icon name="copy" size={15} /> Скопировать
          </button>
        </div>
        <div className="alert warn">
          <Icon name="lock" size={17} />
          <div>
            Ключ показывается <b>один раз</b> и хранится у нас только в виде хеша. Потеряли — перевыпустите: старый ключ и
            все его входы сразу перестанут работать. Менеджеры компании этот ключ не видят.
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Режим руководителя"
      onClose={onClose}
      wide
      footer={
        confirm ? (
          <>
            <span className="grow">{confirm === "rotate" ? "Старый ключ перестанет работать. Продолжить?" : "Руководитель потеряет доступ. Выключить?"}</span>
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              Нет
            </button>
            <button
              className="btn danger"
              disabled={save.isPending}
              onClick={() => save.mutate(confirm === "rotate" ? { until: date, rotate: true } : { until: null })}
            >
              {save.isPending ? <Spinner /> : null} Да
            </button>
          </>
        ) : (
          <>
            {c.active && (
              <>
                <button className="btn ghost danger-text" onClick={() => setConfirm("off")}>
                  Выключить
                </button>
                <button className="btn ghost" onClick={() => setConfirm("rotate")}>
                  <Icon name="refresh" size={15} /> Новый ключ
                </button>
              </>
            )}
            <span className="grow" />
            <button className="btn primary" disabled={!date || date < today || save.isPending} onClick={() => save.mutate({ until: date })}>
              {save.isPending ? <Spinner /> : <Icon name="check" size={16} />} {c.active ? "Продлить" : "Включить"} до {ruDate(date)}
            </button>
          </>
        )
      }
    >
      <div className="access-user">
        <b>{user.name}</b>
        <span className="muted">
          {user.company ? `${user.company} · ` : ""}
          {formatPhone(user.phone)}
        </span>
        <span className={`pill ${c.active ? "green" : ""}`}>
          {c.active ? `включён до ${dateLong(c.until!)}` : c.until ? `истёк ${dateLong(c.until)}` : "выключен"}
        </span>
      </div>
      <p className="muted small check-explain">
        Руководитель видит всю переписку рабочего номера (ответы AI и менеджеров, удалённые и изменённые сообщения, звонки,
        поиск, сводку) на отдельном адресе {checkOrigin().replace(/^https?:\/\//, "")} по ключу. Используется уже
        подключённый WhatsApp компании — нового связанного устройства не нужно. Менеджеры ничего не видят.
      </p>
      <label>Быстро {c.active ? "продлить" : "выбрать срок"}</label>
      <div className="preset-row">
        {presets.map(([l, d]) => (
          <button key={l} className={`chip ${date === d ? "active" : ""}`} onClick={() => setDate(d)}>
            {l}
          </button>
        ))}
      </div>
      <label htmlFor="chk-date">Доступ действует по (включительно)</label>
      <input id="chk-date" type="date" className="input" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
      {save.isError && <div className="alert danger">{errorText(save.error)}</div>}
    </Modal>
  );
}

/* ---------- security journal ---------- */

function auditText(i: AuditItem, names: Map<string, string>): string {
  const who = i.target && names.get(i.target) ? names.get(i.target) : i.target;
  const to = typeof i.meta?.to === "number" ? dateLong(i.meta.to) : "";
  switch (i.action) {
    case "admin_login":
      return i.result === "ok"
        ? `Вход в админ-панель (${i.meta?.factor === "recovery" ? "код с сервера" : "код из WhatsApp"})`
        : `Неудачная попытка входа (${i.meta?.step === "password" ? "неверный пароль" : "неверный код"})`;
    case "admin_password_ok":
      return "Пароль принят, ожидается второй фактор";
    case "admin_recovery_issued":
      return "Создан код восстановления на сервере";
    case "admin_logout_all":
      return "Завершены все сеансы администратора";
    case "sender_link_start":
      return "Начато подключение номера-отправителя";
    case "sender_logout":
      return "Номер-отправитель отключён";
    case "ai_access_grant":
      return `Доступ к AI: ${who} — до ${to}`;
    case "ai_access_revoke":
      return `Доступ к AI отозван: ${who}`;
    case "check_grant":
      return `Режим руководителя включён: ${who} — до ${to}, выдан ключ`;
    case "check_extend":
      return `Режим руководителя продлён: ${who} — до ${to}`;
    case "check_key_rotate":
      return `Перевыпущен ключ руководителя: ${who}`;
    case "check_revoke":
      return `Режим руководителя выключен: ${who}`;
    default:
      return i.action;
  }
}

/* ---------- admin home ---------- */

type Filter = "all" | "active" | "soon" | "none";

function AdminHome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: ["admin-overview"], queryFn: adminOverview, refetchInterval: 30_000 });
  const audit = useQuery({ queryKey: ["admin-audit"], queryFn: adminAudit, refetchInterval: 60_000 });
  const sender = useQuery({
    queryKey: ["admin-sender"],
    queryFn: adminSender,
    refetchInterval: (q) => (LINKING.has(q.state.data?.status ?? "") ? 2000 : 15000),
  });
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [checkFor, setCheckFor] = useState<AdminUser | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmAll, setConfirmAll] = useState(false);

  const done = (s: WhatsAppState) => qc.setQueryData(["admin-sender"], s);
  const err = (e: unknown) => toast(errorText(e) ?? "Ошибка", "error");
  const link = useMutation({ mutationFn: adminLinkSender, onSuccess: done, onError: err });
  const cancel = useMutation({ mutationFn: adminCancelSender, onSuccess: done, onError: err });
  const off = useMutation({ mutationFn: adminLogoutSender, onSuccess: done, onError: err });
  const leave = () => {
    qc.clear();
    navigate("/login", { replace: true });
  };
  const out = useMutation({ mutationFn: adminLogout, onSuccess: leave });
  const outAll = useMutation({ mutationFn: adminLogoutAll, onSuccess: leave });

  const users = overview.data?.users ?? [];
  const today = overview.data?.today ?? almatyDate(Date.now());
  const names = useMemo(() => new Map(users.map((u) => [`user:${u.id}`, u.name])), [users]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return users.filter((u) => {
      if (filter === "active" && !u.ai_access.active) return false;
      if (filter === "soon" && !(u.ai_access.active && u.ai_access.days_left <= 7)) return false;
      if (filter === "none" && u.ai_access.active) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) || u.company.toLowerCase().includes(q) || (digits.length >= 3 && u.phone.includes(digits))
      );
    });
  }, [users, search, filter]);
  const counts = {
    active: users.filter((u) => u.ai_access.active).length,
    soon: users.filter((u) => u.ai_access.active && u.ai_access.days_left <= 7).length,
  };

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">
          <Logo size={34} />
          <div>
            <b>Alma AI</b>
            <span>Администрирование</span>
          </div>
        </div>
        <div className="admin-actions">
          {confirmAll ? (
            <>
              <span className="muted small hide-sm">Выйти на всех устройствах?</span>
              <button className="btn sm danger" onClick={() => outAll.mutate()} disabled={outAll.isPending}>
                Да, завершить все
              </button>
              <button className="btn sm ghost" onClick={() => setConfirmAll(false)}>
                Нет
              </button>
            </>
          ) : (
            <button className="btn sm ghost" onClick={() => setConfirmAll(true)}>
              <Icon name="shield" size={15} /> <span className="hide-sm">Завершить все сеансы</span>
            </button>
          )}
          <button className="btn sm ghost" onClick={() => out.mutate()}>
            <Icon name="logout" size={15} /> Выйти
          </button>
        </div>
      </header>

      <main className="admin-main">
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Клиентов</span>
            <span className="stat-value">{nf(users.length)}</span>
          </div>
          <div className="stat green">
            <span className="stat-label">С доступом к AI</span>
            <span className="stat-value">{nf(counts.active)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Истекает за 7 дней</span>
            <span className="stat-value">{nf(counts.soon)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">WhatsApp подключён</span>
            <span className="stat-value">{nf(users.filter((u) => u.wa_status === "connected").length)}</span>
          </div>
        </div>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="users" size={19} /> Клиенты и доступ к AI
            </h2>
          </div>
          <div className="admin-toolbar">
            <div className="search">
              <Icon name="search" size={17} />
              <input placeholder="Имя, компания или телефон" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="chips">
              {(
                [
                  ["all", "Все"],
                  ["active", "С доступом"],
                  ["soon", "Истекает"],
                  ["none", "Без доступа"],
                ] as [Filter, string][]
              ).map(([k, l]) => (
                <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {overview.isPending ? (
            <div className="center pad">
              <Spinner />
            </div>
          ) : shown.length === 0 ? (
            <p className="muted pad center">{users.length === 0 ? "Пока никто не зарегистрировался." : "Никого не нашли."}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Доступ к AI</th>
                    <th>Руководитель</th>
                    <th>WhatsApp бота</th>
                    <th className="num">Диалогов</th>
                    <th className="num">Сообщ. 30 дн.</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <b>{u.name}</b>
                        <div className="muted small">
                          {u.company ? `${u.company} · ` : ""}
                          {formatPhone(u.phone)}
                        </div>
                      </td>
                      <td>
                        {u.ai_access.active ? (
                          <span className={`pill ${u.ai_access.days_left <= 7 ? "warn" : "green"}`}>
                            до {dateLong(u.ai_access.until!)}
                            {u.ai_access.days_left <= 7 &&
                              ` · ${u.ai_access.days_left} ${plural(u.ai_access.days_left, "день", "дня", "дней")}`}
                          </span>
                        ) : u.ai_access.until ? (
                          <span className="pill danger">истёк {dateLong(u.ai_access.until)}</span>
                        ) : (
                          <span className="pill">нет доступа</span>
                        )}
                      </td>
                      <td>
                        <button className={`pill-btn ${u.check.active ? "on" : ""}`} onClick={() => setCheckFor(u)} title="Режим руководителя (check)">
                          <Icon name="eye" size={13} /> {u.check.active ? `до ${almatyDate(u.check.until!).split("-").reverse().join(".")}` : "выкл"}
                        </button>
                      </td>
                      <td>
                        {u.wa_status === "connected" ? (
                          <span className="pill green">{formatPhone(u.wa_phone) || "подключён"}</span>
                        ) : (
                          <span className="muted small">не подключён</span>
                        )}
                      </td>
                      <td className="num">{nf(u.chats)}</td>
                      <td className="num">{nf(u.messages_30d)}</td>
                      <td className="num">
                        <button className="btn sm soft" onClick={() => setEditing(u)}>
                          <Icon name="clock" size={14} /> {u.ai_access.active ? "Изменить" : "Открыть доступ"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="chat" size={19} /> Номер для кодов подтверждения
            </h2>
            {sender.data?.status === "connected" ? (
              <span className="pill green">работает</span>
            ) : (
              <span className="pill warn">не подключён</span>
            )}
          </div>
          <p className="muted">
            С этого WhatsApp клиенты получают коды при регистрации и сбросе пароля, а вы — код входа в эту панель
            {overview.data && !overview.data.admin_phone_set ? " (задайте ADMIN_PHONE на сервере)" : ""}. Кто
            управляет этим номером, видит все коды — подключайте только свой телефон.
          </p>
          <WaLinker
            state={sender.data}
            busy={link.isPending || cancel.isPending || off.isPending}
            onLink={(a) => link.mutate(a)}
            onCancel={() => cancel.mutate()}
            onLogout={() => off.mutate()}
            connectedNote="Коды подтверждения отправляются с этого номера. Не выходите из WhatsApp на телефоне и держите его в сети."
          />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="shield" size={19} /> Журнал безопасности
            </h2>
            <span className="muted small">последние события, изменить или удалить их нельзя</span>
          </div>
          {(audit.data?.items ?? []).length === 0 ? (
            <p className="muted">Событий пока нет.</p>
          ) : (
            <ul className="audit">
              {audit.data!.items.map((i, idx) => (
                <li key={idx} className={i.result === "fail" ? "fail" : ""}>
                  <span className="dot" />
                  <span className="what">{auditText(i, names)}</span>
                  <span className="when muted small">
                    {new Date(i.at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {i.ip ? ` · ${i.ip}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      {editing && <AccessModal user={editing} today={today} onClose={() => setEditing(null)} />}
      {checkFor && <CheckModal user={checkFor} today={today} onClose={() => setCheckFor(null)} />}
    </div>
  );
}

/** Rendered only after AdminGate (App.tsx) confirmed a full admin session. */
export default function AdminPage() {
  return <AdminHome />;
}
