import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../api/client";
import { type AgentSettings, type EditableSettings, getAgent, getMe, saveAgent, testAgent } from "../api/endpoints";
import AccessBanner from "../components/AccessBanner";
import Icon from "../components/Icon";
import { ErrorBox, PageLoader, Segmented, Spinner, Toggle, toast } from "../components/ui";

const TEMPLATE = `Ты — консультант компании. Помогай клиентам выбрать услугу, отвечай на вопросы о ценах, адресе и графике работы, записывай клиентов.

Как вести диалог:
• В начале нового диалога поздоровайся и спроси, чем можешь помочь.
• Уточняй детали по одному вопросу за раз.
• Для записи собери имя, услугу, удобные дату и время — затем передай заявку менеджеру.
• Заканчивай сообщение вопросом, который ведёт к записи или покупке.

Ограничения:
• Не обсуждай темы, не связанные с компанией.
• Не давай скидок и не обещай того, чего нет в базе знаний.`;

const pick = (s: AgentSettings): EditableSettings => ({
  bot_name: s.bot_name,
  business_name: s.business_name,
  business_about: s.business_about,
  instructions: s.instructions,
  tone: s.tone,
  verbosity: s.verbosity,
  quality: s.quality,
  reply_delay_sec: s.reply_delay_sec,
  operator_pause_min: s.operator_pause_min,
  handoff_enabled: s.handoff_enabled,
  handoff_message: s.handoff_message,
  schedule_mode: s.schedule_mode,
  work_start: s.work_start,
  work_end: s.work_end,
  voice_enabled: s.voice_enabled,
});

type TestMsg = { role: "user" | "assistant"; content: string; handoff?: boolean; sources?: string[]; ms?: number };

function TestChat({ settings, botName }: { settings: EditableSettings; botName: string }) {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const locked = me.data ? !me.data.ai_access.active : false;
  const [msgs, setMsgs] = useState<TestMsg[]>([]);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const run = useMutation({
    mutationFn: (history: TestMsg[]) =>
      testAgent({ messages: history.map((m) => ({ role: m.role, content: m.content })), settings }),
    onSuccess: (r) =>
      setMsgs((m) => [...m, { role: "assistant", content: r.reply, handoff: r.handoff, sources: r.sources, ms: r.latency_ms }]),
  });
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length, run.isPending]);

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || run.isPending) return;
    const next = [...msgs, { role: "user" as const, content: text }].slice(-19);
    setMsgs(next);
    setDraft("");
    run.mutate(next);
  }

  return (
    <aside className="test-chat">
      <header>
        <div>
          <h3>
            <Icon name="sparkles" size={17} /> Тест-чат
          </h3>
          <span className="muted small">Проверка с текущими настройками — даже несохранёнными</span>
        </div>
        {msgs.length > 0 && (
          <button className="icon-btn" onClick={() => setMsgs([])} title="Начать заново" aria-label="Начать заново">
            <Icon name="refresh" size={17} />
          </button>
        )}
      </header>
      <div className="test-body" ref={box}>
        {locked && (
          <div className="test-empty">
            <Icon name="lock" size={26} />
            <p>Тест-чат заработает, когда будет активирован доступ к AI.</p>
          </div>
        )}
        {!locked && msgs.length === 0 && (
          <div className="test-empty">
            <p>Напишите как клиент — например:</p>
            {["Здравствуйте, сколько стоит?", "Где вы находитесь?", "Можно поговорить с менеджером?"].map((s) => (
              <button key={s} className="chip" onClick={() => setDraft(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`tmsg ${m.role === "user" ? "in" : "out"}`}>
            <div className="bubble">
              {m.role === "assistant" && (
                <div className="who">
                  <Icon name="sparkles" size={12} /> {botName}
                </div>
              )}
              <div className="text">{m.content}</div>
              {m.role === "assistant" && (
                <div className="tmeta">
                  {m.handoff && <span className="handoff-tag">передано менеджеру</span>}
                  {m.sources && m.sources.length > 0 && <span title={m.sources.join("\n")}>📚 {m.sources.length}</span>}
                  {m.ms !== undefined && <span>{(m.ms / 1000).toFixed(1)} с</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {run.isPending && (
          <div className="tmsg out">
            <div className="bubble typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {run.isError && <div className="alert danger small">{errorText(run.error)}</div>}
      </div>
      <form className="test-input" onSubmit={send}>
        <input
          placeholder={locked ? "Доступ к AI не активирован" : "Сообщение клиента…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          disabled={locked}
        />
        <button className="send" disabled={locked || !draft.trim() || run.isPending} aria-label="Отправить">
          <Icon name="send" size={18} />
        </button>
      </form>
    </aside>
  );
}

export default function AgentPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent"], queryFn: getAgent });
  const [form, setForm] = useState<EditableSettings | null>(null);
  const [showTest, setShowTest] = useState(false);

  useEffect(() => {
    if (q.data && !form) setForm(pick(q.data));
  }, [q.data, form]);

  const save = useMutation({
    mutationFn: saveAgent,
    onSuccess: (s) => {
      qc.setQueryData(["agent"], s);
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      setForm(pick(s));
      toast("Настройки сохранены");
    },
    onError: (e) => toast(errorText(e) ?? "Не удалось сохранить", "error"),
  });

  const dirty = useMemo(
    () => Boolean(q.data && form && JSON.stringify(pick(q.data)) !== JSON.stringify(form)),
    [q.data, form],
  );

  if (q.isError) return <ErrorBox onRetry={() => void q.refetch()}>Не удалось загрузить настройки</ErrorBox>;
  if (!q.data || !form) return <PageLoader />;
  const set = <K extends keyof EditableSettings>(k: K, v: EditableSettings[K]) => setForm({ ...form, [k]: v });

  return (
    <div className={`agent ${showTest ? "test-open" : ""}`}>
      <div className="agent-form">
        <AccessBanner compact />
        {!q.data.ai_configured && (
          <div className="alert warn">
            <Icon name="alert" size={18} />
            <div>На сервере не задан ключ OpenAI — агент не сможет отвечать, пока администратор его не добавит.</div>
          </div>
        )}

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="bot" size={19} /> Кто отвечает клиентам
            </h2>
          </div>
          <div className="grid-2">
            <div>
              <label htmlFor="a-bot">Имя ассистента</label>
              <input id="a-bot" className="input" value={form.bot_name} maxLength={40} onChange={(e) => set("bot_name", e.target.value)} />
            </div>
            <div>
              <label htmlFor="a-biz">Название компании</label>
              <input
                id="a-biz"
                className="input"
                placeholder="Dala Fitness"
                value={form.business_name}
                maxLength={120}
                onChange={(e) => set("business_name", e.target.value)}
              />
            </div>
          </div>
          <label htmlFor="a-about">О компании</label>
          <textarea
            id="a-about"
            className="input"
            rows={4}
            maxLength={4000}
            placeholder="Чем вы занимаетесь, для кого, чем отличаетесь. Например: «Фитнес-клуб в Алматы для взрослых и детей, бассейн 25 м, групповые программы…»"
            value={form.business_about}
            onChange={(e) => set("business_about", e.target.value)}
          />
          <div className="label-row">
            <label htmlFor="a-instr">Инструкция для агента</label>
            {!form.instructions.trim() && (
              <button type="button" className="link-btn" onClick={() => set("instructions", TEMPLATE)}>
                <Icon name="sparkles" size={14} /> Вставить шаблон
              </button>
            )}
          </div>
          <textarea
            id="a-instr"
            className="input mono-ish"
            rows={10}
            maxLength={12000}
            placeholder="Как вести диалог, что спрашивать у клиента, чего не делать…"
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
          />
          <p className="hint">
            Факты — цены, адреса, расписание — лучше хранить в «Базе знаний»: агент берёт их оттуда и не выдумывает.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="chat" size={19} /> Стиль общения
            </h2>
          </div>
          <div className="field-row">
            <div>
              <b>Тон</b>
              <span className="muted small">Как агент обращается к клиенту</span>
            </div>
            <Segmented
              value={form.tone}
              onChange={(v) => set("tone", v)}
              options={[
                { value: "friendly", label: "Дружелюбный" },
                { value: "formal", label: "Официальный" },
                { value: "concise", label: "Краткий" },
              ]}
            />
          </div>
          <div className="field-row">
            <div>
              <b>Длина ответов</b>
              <span className="muted small">В мессенджере лучше коротко</span>
            </div>
            <Segmented
              value={form.verbosity}
              onChange={(v) => set("verbosity", v)}
              options={[
                { value: "low", label: "Коротко" },
                { value: "medium", label: "Средне" },
                { value: "high", label: "Подробно" },
              ]}
            />
          </div>
          <div className="field-row">
            <div>
              <b>Модель</b>
              <span className="muted small">
                {form.quality === "quality" ? q.data.models.quality : q.data.models.balanced} · OpenAI
              </span>
            </div>
            <Segmented
              value={form.quality}
              onChange={(v) => set("quality", v)}
              options={[
                { value: "balanced", label: "Оптимальная", hint: "Быстрые и недорогие ответы" },
                { value: "quality", label: "Максимум качества", hint: "Лучше следует сложным инструкциям" },
              ]}
            />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="hand" size={19} /> Менеджер и AI
            </h2>
          </div>
          <div className="field-row">
            <div>
              <b>Передавать диалог менеджеру</b>
              <span className="muted small">
                Когда клиент просит человека, хочет оформить заказ или у агента нет ответа — чат помечается «ждёт
                менеджера»
              </span>
            </div>
            <Toggle checked={form.handoff_enabled} onChange={(v) => set("handoff_enabled", v)} label="Передача менеджеру" />
          </div>
          {form.handoff_enabled && (
            <>
              <label htmlFor="a-handoff">Что агент скажет клиенту при передаче</label>
              <input
                id="a-handoff"
                className="input"
                maxLength={500}
                value={form.handoff_message}
                onChange={(e) => set("handoff_message", e.target.value)}
              />
            </>
          )}
          <div className="field-row">
            <div>
              <b>Пауза AI после ответа менеджера</b>
              <span className="muted small">
                Если вы ответили сами — с телефона или из кабинета — бот не вмешивается в этот диалог
              </span>
            </div>
            <div className="num-input">
              <input
                type="number"
                min={0}
                max={1440}
                className="input"
                value={form.operator_pause_min}
                onChange={(e) => set("operator_pause_min", Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
              />
              <span>мин</span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="clock" size={19} /> Когда работает агент
            </h2>
          </div>
          <Segmented
            value={form.schedule_mode}
            onChange={(v) => set("schedule_mode", v)}
            options={[
              { value: "always", label: "Круглосуточно" },
              { value: "off_hours", label: "Когда менеджеры не работают" },
              { value: "work_hours", label: "Только в рабочие часы" },
            ]}
          />
          {form.schedule_mode !== "always" && (
            <div className="hours">
              <span>Рабочие часы менеджеров:</span>
              <input type="time" className="input" value={form.work_start} onChange={(e) => set("work_start", e.target.value)} />
              <span>—</span>
              <input type="time" className="input" value={form.work_end} onChange={(e) => set("work_end", e.target.value)} />
              <span className="muted small">время Алматы</span>
            </div>
          )}
          <div className="field-row">
            <div>
              <b>Задержка перед ответом: {form.reply_delay_sec} с</b>
              <span className="muted small">
                Агент ждёт, пока клиент допишет мысль, и отвечает одним сообщением на несколько подряд
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={30}
              value={form.reply_delay_sec}
              onChange={(e) => set("reply_delay_sec", Number(e.target.value))}
              className="range"
              aria-label="Задержка перед ответом"
            />
          </div>
          <div className="field-row">
            <div>
              <b>Голосовые сообщения</b>
              <span className="muted small">
                Агент расшифровывает голосовые (gpt-transcribe) и отвечает текстом. Фото, видео и документы в AI не
                передаются — они видны только вам в «Чатах».
              </span>
            </div>
            <span className="pill green">
              <Icon name="mic" size={13} /> всегда включено
            </span>
          </div>
        </section>
        <div className="save-spacer" />
      </div>

      <TestChat settings={form} botName={form.bot_name || "Алма"} />

      <button className="test-fab" onClick={() => setShowTest((v) => !v)}>
        <Icon name={showTest ? "x" : "sparkles"} size={18} /> {showTest ? "Закрыть" : "Тест-чат"}
      </button>

      <div className={`save-bar ${dirty ? "show" : ""}`} aria-hidden={!dirty}>
        <span>
          <Icon name="info" size={17} /> Есть несохранённые изменения
        </span>
        <button className="btn ghost" onClick={() => setForm(pick(q.data))} disabled={save.isPending}>
          Отменить
        </button>
        <button className="btn primary" onClick={() => save.mutate(form)} disabled={save.isPending}>
          {save.isPending ? <Spinner /> : <Icon name="check" size={17} />} Сохранить
        </button>
      </div>
    </div>
  );
}
