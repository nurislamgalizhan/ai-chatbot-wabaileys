import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { getAnalytics } from "../api/endpoints";
import { ColumnChart, SERIES, ShareBar } from "../components/charts";
import Icon, { type IconName } from "../components/Icon";
import { ErrorBox, PageLoader, Segmented } from "../components/ui";
import { duration, formatPhone, nf, shortDay } from "../lib/format";

function Kpi({ icon, label, value, sub }: { icon: IconName; label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-icon">
        <Icon name={icon} size={19} />
      </span>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const q = useQuery({ queryKey: ["analytics", days], queryFn: () => getAnalytics(Number(days)), placeholderData: (p) => p });

  if (q.isError) return <ErrorBox onRetry={() => void q.refetch()}>Не удалось загрузить аналитику</ErrorBox>;
  if (!q.data) return <PageLoader />;
  const a = q.data;
  const every = a.by_day.length > 31 ? 14 : a.by_day.length > 10 ? 5 : 1;

  return (
    <div className="analytics">
      <div className="toolbar">
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: "7", label: "7 дней" },
            { value: "30", label: "30 дней" },
            { value: "90", label: "90 дней" },
          ]}
        />
        <span className="muted small">По времени Алматы</span>
      </div>

      <div className="stats wide">
        <Kpi icon="chat" label="Сообщений от клиентов" value={nf(a.totals.incoming)} sub={`активных диалогов: ${nf(a.chats.active)}`} />
        <Kpi icon="users" label="Новых клиентов" value={nf(a.chats.new)} />
        <Kpi icon="sparkles" label="Ответов AI" value={nf(a.totals.ai)} sub={`передано менеджеру: ${nf(a.totals.handoffs)}`} />
        <Kpi icon="user" label="Ответов менеджеров" value={nf(a.totals.operator)} />
        <Kpi
          icon="bolt"
          label="Время до ответа AI"
          value={duration(a.median_first_reply_sec.ai)}
          sub={`менеджеры: ${duration(a.median_first_reply_sec.human)} · медиана`}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Доля ответов</h2>
          {a.ai_share !== null && <span className="pill green">AI ответил на {a.ai_share}%</span>}
        </div>
        <ShareBar
          parts={[
            { name: SERIES.ai.name, value: a.totals.ai, color: SERIES.ai.color },
            { name: SERIES.operator.name, value: a.totals.operator, color: SERIES.operator.color },
          ]}
        />
      </section>

      <div className="dash-grid even">
        <section className="card">
          <div className="card-head">
            <h2>Кто отвечал по дням</h2>
          </div>
          <ColumnChart
            labelEvery={every}
            data={a.by_day.map((d) => ({
              key: d.day,
              label: shortDay(d.day),
              tooltip: shortDay(d.day),
              values: [d.ai, d.operator],
            }))}
            series={[SERIES.ai, SERIES.operator]}
          />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Сообщения клиентов по дням</h2>
          </div>
          <ColumnChart
            labelEvery={every}
            data={a.by_day.map((d) => ({ key: d.day, label: shortDay(d.day), tooltip: shortDay(d.day), values: [d.incoming] }))}
            series={[SERIES.incoming]}
          />
        </section>
      </div>

      <div className="dash-grid">
        <section className="card">
          <div className="card-head">
            <h2>Когда пишут клиенты</h2>
            <span className="muted small">по часам</span>
          </div>
          <ColumnChart
            height={200}
            labelEvery={3}
            data={a.hours.map((v, h) => ({
              key: String(h),
              label: `${String(h).padStart(2, "0")}`,
              tooltip: `${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59`,
              values: [v],
            }))}
            series={[SERIES.incoming]}
          />
          {(() => {
            const night = a.hours.slice(0, 9).reduce((n, v) => n + v, 0) + a.hours.slice(20).reduce((n, v) => n + v, 0);
            return a.totals.incoming > 0 ? (
              <p className="insight">
                <Icon name="clock" size={16} /> {Math.round((night / a.totals.incoming) * 100)}% сообщений приходит с 20:00
                до 09:00 — когда менеджеры обычно не на связи.
              </p>
            ) : null;
          })()}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Самые активные диалоги</h2>
          </div>
          {a.top_chats.length === 0 ? (
            <p className="muted">Нет данных за период.</p>
          ) : (
            <table className="table">
              <tbody>
                {a.top_chats.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/chats/${c.id}`}>{c.name?.trim() || formatPhone(c.phone) || "Клиент"}</Link>
                    </td>
                    <td className="num">{nf(c.messages)} сообщ.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
