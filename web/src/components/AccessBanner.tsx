import { useQuery } from "@tanstack/react-query";
import { getMe } from "../api/endpoints";
import { dateLong, plural } from "../lib/format";
import Icon from "./Icon";

/** Where the client stands with AI access (granted by the platform admin). */
export default function AccessBanner({ compact = false }: { compact?: boolean }) {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  if (!me.data) return null;
  const { ai_access: a, support_whatsapp: support } = me.data;
  const contact = support ? (
    <a className="btn sm primary" href={`https://wa.me/${support}`} target="_blank" rel="noopener noreferrer">
      <Icon name="chat" size={15} /> Написать нам
    </a>
  ) : null;

  if (a.active && a.days_left > 7) {
    return compact ? null : (
      <div className="access ok">
        <Icon name="shield" size={18} />
        <div>
          <b>AI-агент подключён</b> до {dateLong(a.until!)}
        </div>
      </div>
    );
  }
  if (a.active) {
    return (
      <div className="access warn">
        <Icon name="clock" size={18} />
        <div>
          <b>
            Доступ к AI заканчивается через {a.days_left} {plural(a.days_left, "день", "дня", "дней")}
          </b>{" "}
          ({dateLong(a.until!)}). Продлите, чтобы бот отвечал без перерыва.
        </div>
        {contact}
      </div>
    );
  }
  return (
    <div className="access off">
      <Icon name="lock" size={18} />
      <div>
        {a.until ? (
          <>
            <b>Доступ к AI закончился {dateLong(a.until)}.</b> Бот не отвечает клиентам — диалоги по-прежнему видны в
            «Чатах».
          </>
        ) : (
          <>
            <b>AI-агент ещё не подключён.</b> Пока можно подключить WhatsApp, настроить агента и заполнить базу знаний —
            бот начнёт отвечать, как только мы активируем доступ.
          </>
        )}
      </div>
      {contact}
    </div>
  );
}
