import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, errorText } from "../../api/client";
import { registerStart, registerVerify } from "../../api/endpoints";
import Icon from "../../components/Icon";
import { OtpInput, PasswordInput, PhoneInput, Spinner, useCountdown } from "../../components/ui";
import { isPhoneComplete, phoneDigits } from "../../lib/format";
import AuthLayout from "./AuthLayout";

function strength(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-ZА-Я]/.test(pw) && /[a-zа-я]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^\p{L}\d]/u.test(pw)) s++;
  return { score: s, label: ["Слишком короткий", "Слабый", "Нормальный", "Хороший", "Отличный"][s] ?? "" };
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", company: "", phone: "", password: "" });
  const [step, setStep] = useState<"form" | "code">("form");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [resendIn, setResendIn] = useState(60);
  const left = useCountdown(resendIn, sentAt);

  const start = useMutation({
    mutationFn: () =>
      registerStart({ ...form, name: form.name.trim(), company: form.company.trim(), phone: phoneDigits(form.phone) }),
    onSuccess: (r) => {
      setStep("code");
      setCode("");
      setResendIn(r.resend_in);
      setSentAt(Date.now());
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "otp_too_soon") {
        setStep("code");
        setResendIn(Number(err.data.retry_after ?? 60));
        setSentAt(Date.now());
      }
    },
  });

  const verify = useMutation({
    mutationFn: (c: string) => registerVerify({ phone: phoneDigits(form.phone), code: c }),
    onSuccess: (r) => {
      qc.setQueryData(["me"], r);
      navigate("/?welcome=1", { replace: true });
    },
    onError: () => setCode(""),
  });

  const pw = strength(form.password);
  const canSubmit =
    form.name.trim().length >= 2 && isPhoneComplete(form.phone) && form.password.length >= 8 && !start.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canSubmit) start.mutate();
  }

  return (
    <AuthLayout>
      {step === "form" ? (
        <form onSubmit={submit} className="auth-form" noValidate>
          <h1>Создайте аккаунт</h1>
          <p className="lead">Подключите AI-менеджера к своему WhatsApp за 5 минут.</p>

          <label htmlFor="r-name">Ваше имя</label>
          <input
            id="r-name"
            className="input"
            autoComplete="name"
            placeholder="Айгерим"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />

          <label htmlFor="r-company">
            Компания <span className="muted">— необязательно</span>
          </label>
          <input
            id="r-company"
            className="input"
            autoComplete="organization"
            placeholder="Например, Dala Fitness"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />

          <label htmlFor="r-phone">Номер WhatsApp</label>
          <PhoneInput id="r-phone" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
          <p className="hint">
            <Icon name="chat" size={14} /> Пришлём код подтверждения в WhatsApp
          </p>

          <label htmlFor="r-pass">Пароль</label>
          <PasswordInput
            id="r-pass"
            autoComplete="new-password"
            placeholder="Минимум 8 символов"
            value={form.password}
            onChange={(password) => setForm({ ...form, password })}
          />
          {form.password && (
            <div className={`strength s${pw.score}`}>
              <span className="bars">
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} className={i < pw.score ? "on" : ""} />
                ))}
              </span>
              {pw.label}
            </div>
          )}

          {start.isError && !(start.error instanceof ApiError && start.error.code === "otp_too_soon") && (
            <div className="alert danger">
              <Icon name="alert" size={17} />
              <div>
                {errorText(start.error)}
                {start.error instanceof ApiError && start.error.code === "phone_taken" && (
                  <>
                    {" "}
                    <Link to="/login">Войти</Link>
                  </>
                )}
              </div>
            </div>
          )}

          <button className="btn primary lg block" disabled={!canSubmit}>
            {start.isPending ? <Spinner /> : <Icon name="chat" size={18} />}
            Получить код в WhatsApp
          </button>
          <p className="legal">
            Нажимая кнопку, вы соглашаетесь с условиями использования сервиса и обработкой персональных данных.
          </p>
          <p className="switch">
            Уже есть аккаунт? <Link to="/login">Войти</Link>
          </p>
        </form>
      ) : (
        <div className="auth-form">
          <button className="back-link" onClick={() => setStep("form")}>
            <Icon name="chevron-left" size={16} /> Изменить данные
          </button>
          <div className="otp-badge">
            <Icon name="chat" size={26} />
          </div>
          <h1>Введите код из WhatsApp</h1>
          <p className="lead">
            Мы отправили 6-значный код на <b>{form.phone}</b>. Сообщение придёт от Alma AI.
          </p>
          <OtpInput
            value={code}
            onChange={setCode}
            onComplete={(c) => verify.mutate(c)}
            disabled={verify.isPending}
            invalid={verify.isError}
          />
          {verify.isError && (
            <div className="alert danger">
              <Icon name="alert" size={17} />
              <div>{errorText(verify.error)}</div>
            </div>
          )}
          <button
            className="btn primary lg block"
            disabled={code.length !== 6 || verify.isPending}
            onClick={() => verify.mutate(code)}
          >
            {verify.isPending ? <Spinner /> : <Icon name="check" size={18} />}
            Подтвердить
          </button>
          <div className="resend">
            {left > 0 ? (
              <span className="muted">Отправить код повторно через {left} с</span>
            ) : (
              <button className="link-btn" disabled={start.isPending} onClick={() => start.mutate()}>
                <Icon name="refresh" size={15} /> Отправить код ещё раз
              </button>
            )}
          </div>
          {start.isError && step === "code" && !(start.error instanceof ApiError && start.error.code === "otp_too_soon") && (
            <div className="alert danger">
              <Icon name="alert" size={17} />
              <div>{errorText(start.error)}</div>
            </div>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
