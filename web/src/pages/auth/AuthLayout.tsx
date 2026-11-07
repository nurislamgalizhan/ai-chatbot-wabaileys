import type { ReactNode } from "react";
import Icon, { Logo } from "../../components/Icon";

export function landingUrl(): string {
  const host = window.location.hostname;
  if (host.startsWith("app.")) return `${window.location.protocol}//${host.slice(4)}`;
  return "/";
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="aurora" aria-hidden="true">
          <span className="a1" />
          <span className="a2" />
          <span className="a3" />
        </div>
        <a className="auth-brand" href={landingUrl()}>
          <Logo size={38} />
          <span>
            Alma <b>AI</b>
          </span>
        </a>
        <div className="auth-pitch">
          <h2>
            Ваш AI-менеджер
            <br />
            <em>в WhatsApp</em>
          </h2>
          <p>Отвечает клиентам за секунды, днём и ночью. Передаёт менеджеру то, что требует человека.</p>
          <ul>
            <li>
              <Icon name="bolt" size={18} /> Ответ за секунды, 24/7
            </li>
            <li>
              <Icon name="globe" size={18} /> Русский, қазақша, English
            </li>
            <li>
              <Icon name="hand" size={18} /> Менеджер подключается в один клик
            </li>
          </ul>
        </div>
        <div className="auth-chat" aria-hidden="true">
          <div className="bubble in">Сәлеметсіз бе! Ертеңге жазылуға бола ма?</div>
          <div className="bubble out">
            Әрине! Ертең 11:00 және 16:00 бос. Қай уақыт ыңғайлы? 🙂
            <span className="tag">Alma AI</span>
          </div>
        </div>
        <p className="auth-since">Работаем с 2024 года</p>
      </aside>
      <main className="auth-main">
        <a className="auth-brand mobile" href={landingUrl()}>
          <Logo size={32} />
          <span>
            Alma <b>AI</b>
          </span>
        </a>
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
