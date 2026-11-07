import { useState } from "react";
import type { WhatsAppState } from "../api/endpoints";
import { dateLong, formatPhone, isPhoneComplete, phoneDigits } from "../lib/format";
import Icon from "./Icon";
import { PhoneInput, Spinner, toast } from "./ui";

type LinkArgs = { method: "qr" } | { method: "code"; phone: string };

export default function WaLinker({
  state,
  busy,
  onLink,
  onCancel,
  onLogout,
  connectedNote,
}: {
  state: WhatsAppState | undefined;
  busy: boolean;
  onLink: (a: LinkArgs) => void;
  onCancel: () => void;
  onLogout: () => void;
  connectedNote: string;
}) {
  const [tab, setTab] = useState<"qr" | "code">("qr");
  const [phone, setPhone] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  if (!state) {
    return (
      <div className="wa-card center">
        <Spinner size={28} />
      </div>
    );
  }

  if (state.status === "connected") {
    return (
      <div className="wa-card connected">
        <div className="wa-ok-icon">
          <Icon name="check" size={30} strokeWidth={2.4} />
        </div>
        <h2>WhatsApp подключён</h2>
        <div className="wa-number">{formatPhone(state.phone)}</div>
        {state.name && <div className="muted">{state.name}</div>}
        {state.connected_at && <div className="muted small">Подключён с {dateLong(state.connected_at)}</div>}
        <p className="wa-note">{connectedNote}</p>
        {confirmOff ? (
          <div className="confirm-row">
            <span>Отключить номер? Бот перестанет отвечать.</span>
            <button className="btn danger" disabled={busy} onClick={onLogout}>
              {busy ? <Spinner /> : null} Да, отключить
            </button>
            <button className="btn ghost" onClick={() => setConfirmOff(false)}>
              Отмена
            </button>
          </div>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmOff(true)}>
            <Icon name="power" size={16} /> Отключить номер
          </button>
        )}
      </div>
    );
  }

  if (state.status === "connecting") {
    return (
      <div className="wa-card center">
        <Spinner size={32} />
        <h2>Подключаемся к WhatsApp…</h2>
        <p className="muted">Обычно это занимает несколько секунд.</p>
        <button className="btn ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    );
  }

  if (state.status === "qr" && state.qr) {
    return (
      <div className="wa-card linking">
        <div className="qr-frame">
          <img src={state.qr} alt="QR-код для подключения WhatsApp" width={280} height={280} />
          <span className="scanline" aria-hidden="true" />
        </div>
        <div className="steps">
          <h2>Отсканируйте QR-код</h2>
          <ol>
            <li>Откройте WhatsApp на телефоне</li>
            <li>
              Нажмите <b>Настройки</b> (iPhone) или <b>⋮</b> (Android) → <b>Связанные устройства</b>
            </li>
            <li>
              Нажмите <b>Привязка устройства</b> и наведите камеру на этот код
            </li>
          </ol>
          <p className="muted small">Код обновляется автоматически. Держите эту страницу открытой.</p>
          <button className="btn ghost" onClick={onCancel}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  if (state.status === "pairing" && state.pairing_code) {
    return (
      <div className="wa-card linking">
        <div className="pair-code">
          {state.pairing_code.split("").map((c, i) => (
            <span key={i} className={c === "-" ? "dash" : ""}>
              {c}
            </span>
          ))}
          <button
            className="btn ghost sm"
            onClick={() => {
              void navigator.clipboard?.writeText(state.pairing_code!.replace("-", ""));
              toast("Код скопирован");
            }}
          >
            <Icon name="copy" size={15} /> Скопировать
          </button>
        </div>
        <div className="steps">
          <h2>Введите код в WhatsApp</h2>
          <ol>
            <li>
              Откройте WhatsApp → <b>Связанные устройства</b>
            </li>
            <li>
              <b>Привязка устройства</b> → <b>Привязать по номеру телефона</b>
            </li>
            <li>Введите код, показанный слева</li>
          </ol>

          <button className="btn ghost" onClick={onCancel}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wa-card">
      <div className="tabs-pill">
        <button className={tab === "qr" ? "active" : ""} onClick={() => setTab("qr")}>
          <Icon name="qr" size={16} /> По QR-коду
        </button>
        <button className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>
          <Icon name="smartphone" size={16} /> По номеру телефона
        </button>
      </div>
      {state.last_error && (
        <div className="alert warn">
          <Icon name="alert" size={17} />
          <div>{state.last_error}</div>
        </div>
      )}
      {tab === "qr" ? (
        <div className="wa-start">
          <div className="wa-illus" aria-hidden="true">
            <Icon name="qr" size={44} strokeWidth={1.4} />
          </div>
          <p>
            Подходит, если вы открыли кабинет на компьютере: отсканируйте код камерой WhatsApp на телефоне.
          </p>
          <button className="btn primary lg" disabled={busy} onClick={() => onLink({ method: "qr" })}>
            {busy ? <Spinner /> : <Icon name="qr" size={18} />} Показать QR-код
          </button>
        </div>
      ) : (
        <form
          className="wa-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (isPhoneComplete(phone)) onLink({ method: "code", phone: phoneDigits(phone) });
          }}
        >
          <div className="wa-illus" aria-hidden="true">
            <Icon name="smartphone" size={44} strokeWidth={1.4} />
          </div>
          <p>Удобно с телефона: получите 8-значный код и введите его в WhatsApp.</p>
          <div className="inline-form">
            <PhoneInput value={phone} onChange={setPhone} />
            <button className="btn primary" disabled={busy || !isPhoneComplete(phone)}>
              {busy ? <Spinner /> : null} Получить код
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
