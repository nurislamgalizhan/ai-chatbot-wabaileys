import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { errorText } from "../api/client";
import { createKb, deleteKb, type KbEntry, listKb, updateKb } from "../api/endpoints";
import Icon from "../components/Icon";
import { Empty, ErrorBox, Modal, PageLoader, Segmented, Spinner, Toggle, toast } from "../components/ui";
import { nf, timeShort } from "../lib/format";

type Draft = { id?: number; kind: "faq" | "doc"; title: string; content: string; is_active: boolean };

const IDEAS: Draft[] = [
  { kind: "faq", title: "Сколько стоят ваши услуги?", content: "", is_active: true },
  { kind: "faq", title: "Где вы находитесь и как добраться?", content: "", is_active: true },
  { kind: "faq", title: "Какой у вас график работы?", content: "", is_active: true },
  { kind: "doc", title: "Прайс-лист", content: "", is_active: true },
];

function Editor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(draft);
  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const body = { kind: d.kind, title: d.title.trim(), content: d.content.trim(), is_active: d.is_active };
      if (d.id) await updateKb(d.id, body);
      else await createKb(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast(d.id ? "Запись обновлена" : "Запись добавлена");
      onClose();
    },
  });
  const faq = d.kind === "faq";
  return (
    <Modal
      title={d.id ? "Редактировать запись" : "Новая запись"}
      onClose={onClose}
      wide
      footer={
        <>
          <label className="inline-toggle">
            <Toggle checked={d.is_active} onChange={(v) => setD({ ...d, is_active: v })} label="Активна" />
            Агент использует эту запись
          </label>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn primary"
            disabled={!d.title.trim() || !d.content.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner /> : <Icon name="check" size={17} />} Сохранить
          </button>
        </>
      }
    >
      <Segmented
        value={d.kind}
        onChange={(kind) => setD({ ...d, kind })}
        options={[
          { value: "faq", label: "Вопрос — ответ" },
          { value: "doc", label: "Документ / текст" },
        ]}
      />
      <label htmlFor="kb-title">{faq ? "Вопрос клиента" : "Название"}</label>
      <input
        id="kb-title"
        className="input"
        autoFocus
        maxLength={200}
        placeholder={faq ? "Сколько стоит абонемент?" : "Прайс-лист на 2026 год"}
        value={d.title}
        onChange={(e) => setD({ ...d, title: e.target.value })}
      />
      <label htmlFor="kb-content">{faq ? "Ответ" : "Текст"}</label>
      <textarea
        id="kb-content"
        className="input"
        rows={faq ? 6 : 14}
        maxLength={30000}
        placeholder={
          faq
            ? "Безлимит на месяц — 18 000 ₸, утренний (до 16:00) — 12 000 ₸. Первое занятие бесплатно."
            : "Вставьте прайс, правила, описание услуг, условия доставки…"
        }
        value={d.content}
        onChange={(e) => setD({ ...d, content: e.target.value })}
      />
      <div className="hint split">
        <span>Агент перескажет это своими словами и на языке клиента.</span>
        <span>{nf(d.content.length)} / 30 000</span>
      </div>
      {save.isError && <div className="alert danger">{errorText(save.error)}</div>}
    </Modal>
  );
}

export default function KnowledgePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["kb"], queryFn: listKb, refetchInterval: (s) => (s.state.data?.items.some((i) => i.index_state === "pending") ? 2000 : false) });
  const [filter, setFilter] = useState<"all" | "faq" | "doc">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = useMutation({
    mutationFn: (e: KbEntry) => updateKb(e.id, { kind: e.kind, title: e.title, content: e.content, is_active: !e.is_active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kb"] }),
    onError: (e) => toast(errorText(e) ?? "Ошибка", "error"),
  });
  const del = useMutation({
    mutationFn: deleteKb,
    onSuccess: () => {
      setConfirmDel(null);
      void qc.invalidateQueries({ queryKey: ["kb"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast("Запись удалена");
    },
  });

  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.items ?? []).filter(
      (i) =>
        (filter === "all" || i.kind === filter) &&
        (!s || i.title.toLowerCase().includes(s) || i.content.toLowerCase().includes(s)),
    );
  }, [q.data, filter, search]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 200_000) {
      toast("Файл слишком большой (до 200 КБ текста)", "error");
      return;
    }
    const text = (await file.text()).trim();
    if (!text) {
      toast("Файл пустой", "error");
      return;
    }
    setEditing({
      kind: "doc",
      title: file.name.replace(/\.(txt|md|csv)$/i, ""),
      content: text.slice(0, 30000),
      is_active: true,
    });
  }

  if (q.isError) return <ErrorBox onRetry={() => void q.refetch()}>Не удалось загрузить базу знаний</ErrorBox>;
  if (!q.data) return <PageLoader />;
  const stats = q.data.stats;
  const total = q.data.items.length;

  return (
    <div className="kb">
      <div className="kb-hero">
        <div>
          <h2>Чему научить агента</h2>
          <p className="muted">
            Цены, услуги, адреса, график, условия — всё, что клиенты спрашивают чаще всего. Агент отвечает только по этим
            данным и не выдумывает.
          </p>
        </div>
        <div className="kb-actions">
          <input ref={fileRef} type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" hidden onChange={(e) => void onFile(e)} />
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={17} /> Загрузить .txt
          </button>
          <button className="btn primary" onClick={() => setEditing({ kind: "faq", title: "", content: "", is_active: true })}>
            <Icon name="plus" size={17} /> Добавить
          </button>
        </div>
      </div>

      {total > 0 && (
        <div className={`kb-mode ${stats.mode}`}>
          <Icon name={stats.mode === "full" ? "target" : "search"} size={18} />
          {stats.mode === "full" ? (
            <span>
              База знаний ({nf(stats.active_chars)} симв.) целиком передаётся агенту в каждом ответе — максимальная точность.
            </span>
          ) : (
            <span>
              База большая ({nf(stats.active_chars)} симв.) — для каждого вопроса агент находит самые подходящие фрагменты.
            </span>
          )}
        </div>
      )}

      {total === 0 ? (
        <section className="card">
          <Empty
            icon="book"
            title="База знаний пока пустая"
            text="Начните с 3–5 самых частых вопросов клиентов. Нажмите на подсказку, чтобы заполнить:"
            action={
              <div className="ideas">
                {IDEAS.map((i) => (
                  <button key={i.title} className="chip" onClick={() => setEditing(i)}>
                    <Icon name="plus" size={14} /> {i.title}
                  </button>
                ))}
              </div>
            }
          />
        </section>
      ) : (
        <>
          <div className="kb-toolbar">
            <div className="search">
              <Icon name="search" size={17} />
              <input placeholder="Поиск по базе знаний" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `Все · ${total}` },
                { value: "faq", label: "Вопрос-ответ" },
                { value: "doc", label: "Документы" },
              ]}
            />
          </div>
          <div className="kb-list">
            {items.map((e) => (
              <article key={e.id} className={`kb-item ${e.is_active ? "" : "inactive"}`}>
                <span className={`kb-kind ${e.kind}`}>
                  <Icon name={e.kind === "faq" ? "chat" : "file"} size={18} />
                </span>
                <button className="kb-main" onClick={() => setEditing({ ...e })}>
                  <b>{e.title}</b>
                  <span className="kb-preview">{e.content}</span>
                  <span className="kb-meta">
                    {e.kind === "faq" ? "Вопрос-ответ" : "Документ"} · {nf(e.content.length)} симв. · {timeShort(e.updated_at)}
                    {e.index_state === "pending" && (
                      <span className="indexing">
                        <Spinner size={11} /> обрабатывается
                      </span>
                    )}
                    {e.index_state === "error" && <span className="idx-err">поиск по смыслу недоступен</span>}
                  </span>
                </button>
                <div className="kb-side">
                  <Toggle checked={e.is_active} onChange={() => toggle.mutate(e)} label="Активна" />
                  {confirmDel === e.id ? (
                    <span className="confirm-inline">
                      <button className="btn sm danger" onClick={() => del.mutate(e.id)} disabled={del.isPending}>
                        Удалить
                      </button>
                      <button className="btn sm ghost" onClick={() => setConfirmDel(null)}>
                        Нет
                      </button>
                    </span>
                  ) : (
                    <button className="icon-btn" onClick={() => setConfirmDel(e.id)} aria-label="Удалить">
                      <Icon name="trash" size={17} />
                    </button>
                  )}
                </div>
              </article>
            ))}
            {items.length === 0 && <p className="muted center pad">Ничего не найдено</p>}
          </div>
        </>
      )}
      {editing && <Editor draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
