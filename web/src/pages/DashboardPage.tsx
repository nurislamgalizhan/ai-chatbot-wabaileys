import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { getDashboard, getMe } from "../api/endpoints";
import AccessBanner from "../components/AccessBanner";
import { ColumnChart, SERIES } from "../components/charts";
import Icon, { type IconName } from "../components/Icon";
import { Avatar, ErrorBox, PageLoader } from "../components/ui";
import { formatPhone, nf, plural, shortDay, timeShort } from "../lib/format";

function Stat({ icon, label, value, sub, tone }: { icon: IconName; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="stat-icon">
        <Icon name={icon} size={19} />
      </span>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export default function DashboardPage() {
  const [params] = useSearchParams();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const q = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 20_000 });

  if (q.isPending) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorBox onRetry={() => void q.refetch()}>Не удалось загрузить сводку</ErrorBox>;
  const d = q.data;
  const waOk = d.whatsapp.status === "connected";
  const steps = [
    { done: waOk, title: "Подключите WhatsApp", text: "Отсканируйте QR-код — 1 минута", to: "/whatsapp", icon: "link" as const },
    {
      done: d.agent_configured,
      title: "Расскажите агенту о бизнесе",
      text: "Чем занимаетесь, как общаться с клиентами",
      to: "/agent",
      icon: "bot" as const,
    },
    {
      done: d.kb_count > 0,
      title: "Заполните базу знаний",
      text: "Цены, адреса, расписание, частые вопросы",
      to: "/knowledge",
      icon: "book" as const,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const firstName = me.data?.user.name.split(" ")[0] ?? "";
  const welcome = params.get("welcome") === "1";

  return (
    <div className="dash">
      <AccessBanner />
      {!d.ai_configured && (
        <div className="alert warn">
          <Icon name="alert" size={18} />
          <div>
            <b>AI пока не может отвечать:</b> на сервере не задан ключ OpenAI. Сообщите администратору платформы.
          </div>
        </div>
      )}

      {doneCount < steps.length && (
        <section className="onboard">
          <div className="onboard-head">
            <div>
              <h2>{welcome ? `Добро пожаловать, ${firstName}! 🎉` : "Запуск AI-менеджера"}</h2>
              <p>
                {doneCount === 0
                  ? "Три шага — и бот начнёт отвечать вашим клиентам."
                  : `Готово ${doneCount} из ${steps.length}. Осталось совсем немного.`}
              </p>
            </div>
            <div className="ring" aria-label={`Выполнено ${doneCount} из ${steps.length}`}>
              <svg viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.5" className="track" />
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  className="fill"
                  strokeDasharray={`${(doneCount / steps.length) * 97.4} 97.4`}
                />
              </svg>
              <span>
                {doneCount}/{steps.length}
              </span>
            </div>
          </div>
          <div className="onboard-steps">
            {steps.map((s, i) => (
              <Link key={s.to} to={s.to} className={`step ${s.done ? "done" : ""}`}>
                <span className="num">{s.done ? <Icon name="check" size={16} strokeWidth={2.6} /> : i + 1}</span>
                <span className="body">
                  <b>{s.title}</b>
                  <span>{s.text}</span>
                </span>
                <Icon name={s.done ? "check" : "arrow-right"} size={18} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="status-row">
        <Link to="/whatsapp" className={`status-card ${waOk ? "ok" : "off"}`}>
          <span className="status-icon">
            <Icon name={waOk ? "check" : "link"} size={20} />
          </span>
          <span>
            <span className="k">WhatsApp</span>
            <span className="v">{waOk ? formatPhone(d.whatsapp.phone) : "Не подключён"}</span>
          </span>
        </Link>
        <Link to="/agent" className={`status-card ${d.ai_access.active && d.ai_enabled ? "ok" : "off"}`}>
          <span className="status-icon">
            <Icon name={!d.ai_access.active ? "lock" : d.ai_enabled ? "sparkles" : "pause"} size={20} />
          </span>
          <span>
            <span className="k">AI-агент</span>
            <span className="v">
              {!d.ai_access.active ? "Доступ не активен" : d.ai_enabled ? "Отвечает клиентам" : "На паузе"}
            </span>
          </span>
        </Link>
        <Link to="/chats" className={`status-card ${d.needs_attention > 0 ? "warn" : "neutral"}`}>
          <span className="status-icon">
            <Icon name="bell" size={20} />
          </span>
          <span>
            <span className="k">Ждут менеджера</span>
            <span className="v">
              {d.needs_attention > 0
                ? `${d.needs_attention} ${plural(d.needs_attention, "диалог", "диалога", "диалогов")}`
                : "Никого — всё под контролем"}
            </span>
          </span>
        </Link>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Сегодня</h2>
          <span className="muted small">время Алматы</span>
        </div>
        <div className="stats">
          <Stat icon="chat" label="Сообщений от клиентов" value={nf(d.today.incoming)} />
          <Stat icon="sparkles" label="Ответил AI" value={nf(d.today.ai)} tone="green" />
          <Stat icon="user" label="Ответили менеджеры" value={nf(d.today.operator)} tone="blue" />
          <Stat icon="users" label="Новых клиентов" value={nf(d.today.new_chats)} sub={`всего диалогов: ${nf(d.total_chats)}`} />
        </div>
      </section>

      <div className="dash-grid">
        <section className="card">
          <div className="card-head">
            <h2>Кто отвечал клиентам — 7 дней</h2>
            {d.ai_share_week !== null && (
              <span className="pill green">AI закрыл {d.ai_share_week}% ответов</span>
            )}
          </div>
          <ColumnChart
            data={d.week.map((w) => ({
              key: w.day,
              label: shortDay(w.day),
              tooltip: `${shortDay(w.day)} · клиенты написали ${w.incoming}`,
              values: [w.ai, w.operator],
            }))}
            series={[SERIES.ai, SERIES.operator]}
          />
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Последние диалоги</h2>
            <Link to="/chats" className="small-link">
              Все чаты <Icon name="arrow-right" size={14} />
            </Link>
          </div>
          {d.recent.length === 0 ? (
            <p className="muted">Диалогов пока нет. Они появятся, как только клиенты напишут в WhatsApp.</p>
          ) : (
            <div className="recent">
              {d.recent.map((c) => {
                const name = c.name?.trim() || formatPhone(c.phone) || "Клиент";
                return (
                  <Link key={c.id} to={`/chats/${c.id}`} className="recent-row">
                    <Avatar name={name} seed={c.phone ?? String(c.id)} size={36} />
                    <span className="body">
                      <span className="top">
                        <b>{name}</b>
                        <span className="muted small">{timeShort(c.last_message_at)}</span>
                      </span>
                      <span className="preview">{c.last_message_preview ?? "—"}</span>
                    </span>
                    {c.needs_attention ? (
                      <span className="dot warn" title="Ждёт менеджера" />
                    ) : c.unread_count > 0 ? (
                      <span className="count">{c.unread_count}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
