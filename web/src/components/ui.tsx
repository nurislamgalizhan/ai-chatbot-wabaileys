import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { avatarHue, initials, maskPhoneInput } from "../lib/format";
import Icon, { type IconName } from "./Icon";

/* ---------- Toggle ---------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/* ---------- Avatar ---------- */

export function Avatar({ name, seed, size = 40 }: { name: string | null; seed: string; size?: number }) {
  const hue = avatarHue(seed);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue} 70% 92%)`,
        color: `hsl(${hue} 45% 32%)`,
      }}
    >
      {initials(name, "#")}
    </span>
  );
}

/* ---------- Spinner / states ---------- */

export const Spinner = ({ size = 18 }: { size?: number }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-label="Загрузка" />
);

export function PageLoader() {
  return (
    <div className="page-loader">
      <Spinner size={26} />
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="alert danger" role="alert">
      <Icon name="alert" size={18} />
      <div>{children}</div>
      {onRetry && (
        <button className="btn sm ghost" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

/* ---------- Inputs ---------- */

export function PhoneInput({
  value,
  onChange,
  autoFocus,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      className="input"
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      placeholder="+7 700 000 00 00"
      value={value}
      autoFocus={autoFocus}
      onFocus={() => {
        if (!value) onChange("+7 ");
      }}
      onChange={(e) => onChange(maskPhoneInput(e.target.value))}
    />
  );
}

export function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input
        id={id}
        className="input"
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="input-addon"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Скрыть пароль" : "Показать пароль"}
      >
        <Icon name={show ? "eye-off" : "eye"} size={17} />
      </button>
    </div>
  );
}

/** Six boxes; paste-friendly; auto-submits when complete. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  const set = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, 6);
    onChange(clean);
    if (clean.length === 6) onComplete?.(clean);
    refs.current[Math.min(clean.length, 5)]?.focus();
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const cut = value[i] ? i : Math.max(0, i - 1);
      onChange(value.slice(0, cut));
      refs.current[cut]?.focus();
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    set(e.clipboardData.getData("text"));
  };
  return (
    <div className={`otp ${invalid ? "invalid" : ""}`} onPaste={onPaste}>
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Цифра ${i + 1}`}
          maxLength={6}
          disabled={disabled}
          value={value[i] ?? ""}
          className={value[i] ? "filled" : ""}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => onKey(i, e)}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, "");
            if (!typed) return;
            set(typed.length > 1 ? typed : value.slice(0, i) + typed);
          }}
        />
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Modal ---------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------- Toasts ---------- */

type Toast = { id: number; text: string; tone: "ok" | "error" };
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: Toast["tone"] = "ok") {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, text, tone }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 3200);
}

export function Toaster() {
  const items = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toaster" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <Icon name={t.tone === "ok" ? "check" : "alert"} size={16} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- Countdown for "resend code" ---------- */

export function useCountdown(seconds: number, key: unknown) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [seconds, key]);
  return left;
}
