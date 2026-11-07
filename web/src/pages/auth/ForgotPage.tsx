import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, errorText } from "../../api/client";
import { resetStart, resetVerify } from "../../api/endpoints";
import Icon from "../../components/Icon";
import { OtpInput, PasswordInput, PhoneInput, Spinner, useCountdown } from "../../components/ui";
import { isPhoneComplete, phoneDigits } from "../../lib/format";
import AuthLayout from "./AuthLayout";

export default function ForgotPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<"phone" | "reset">("phone");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [resendIn, setResendIn] = useState(60);
  const left = useCountdown(resendIn, sentAt);

  const start = useMutation({
    mutationFn: () => resetStart({ phone: phoneDigits(phone) }),
    onSuccess: (r) => {
      setStep("reset");
      setResendIn(r.resend_in);
      setSentAt(Date.now());
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "otp_too_soon") {
        setStep("reset");
        setResendIn(Number(err.data.retry_after ?? 60));
        setSentAt(Date.now());
      }
    },
  });
  const verify = useMutation({
    mutationFn: () => resetVerify({ phone: phoneDigits(phone), code, password }),
    onSuccess: (r) => {
      qc.setQueryData(["me"], r);
      navigate("/", { replace: true });
    },
  });

  function submitPhone(e: FormEvent) {
    e.preventDefault();
    if (isPhoneComplete(phone) && !start.isPending) start.mutate();
  }
  function submitReset(e: FormEvent) {
    e.preventDefault();
    if (code.length === 6 && password.length >= 8 && !verify.isPending) verify.mutate();
  }

  return (
    <AuthLayout>
      {step === "phone" ? (
        <form className="auth-form" onSubmit={submitPhone} noValidate>
          <Link to="/login" className="back-link">
            <Icon name="chevron-left" size={16} /> Ко входу
          </Link>
          <h1>Восстановление пароля</h1>
          <p className="lead">Укажите номер, с которым регистрировались. Код придёт в WhatsApp.</p>
          <label htmlFor="f-phone">Номер телефона</label>
          <PhoneInput id="f-phone" value={phone} onChange={setPhone} autoFocus />
          {start.isError && !(start.error instanceof ApiError && start.error.code === "otp_too_soon") && (
            <div className="alert danger">
              <Icon name="alert" size={17} />
              <div>{errorText(start.error)}</div>
            </div>
          )}
          <button className="btn primary lg block" disabled={!isPhoneComplete(phone) || start.isPending}>
            {start.isPending ? <Spinner /> : <Icon name="chat" size={18} />}
            Получить код
          </button>
        </form>
      ) : (
        <form className="auth-form" onSubmit={submitReset} noValidate>
          <button type="button" className="back-link" onClick={() => setStep("phone")}>
            <Icon name="chevron-left" size={16} /> Изменить номер
          </button>
          <h1>Новый пароль</h1>
          <p className="lead">
            Если номер <b>{phone}</b> зарегистрирован, мы отправили на него код в WhatsApp.
          </p>
          <label>Код из WhatsApp</label>
          <OtpInput value={code} onChange={setCode} invalid={verify.isError} />
          <label htmlFor="f-pass">Новый пароль</label>
          <PasswordInput
            id="f-pass"
            autoComplete="new-password"
            placeholder="Минимум 8 символов"
            value={password}
            onChange={setPassword}
          />
          {verify.isError && (
            <div className="alert danger">
              <Icon name="alert" size={17} />
              <div>{errorText(verify.error)}</div>
            </div>
          )}
          <button
            className="btn primary lg block"
            disabled={code.length !== 6 || password.length < 8 || verify.isPending}
          >
            {verify.isPending ? <Spinner /> : <Icon name="lock" size={18} />}
            Сохранить и войти
          </button>
          <div className="resend">
            {left > 0 ? (
              <span className="muted">Повторить отправку через {left} с</span>
            ) : (
              <button type="button" className="link-btn" onClick={() => start.mutate()}>
                <Icon name="refresh" size={15} /> Отправить код ещё раз
              </button>
            )}
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
