import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { errorText } from "../../api/client";
import { login, twoFactorCancel, twoFactorRecovery, twoFactorVerify } from "../../api/endpoints";
import Icon from "../../components/Icon";
import { OtpInput, PasswordInput, PhoneInput, Spinner } from "../../components/ui";
import { isPhoneComplete, phoneDigits } from "../../lib/format";
import AuthLayout from "./AuthLayout";

/** Second step — shown only after a correct password that requires it. */
function SecondFactor({ whatsapp, onCancel }: { whatsapp: boolean; onCancel: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [method, setMethod] = useState<"whatsapp" | "recovery">(whatsapp ? "whatsapp" : "recovery");
  const [code, setCode] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const recovery = useMutation({
    mutationFn: twoFactorRecovery,
    onSuccess: (r) => {
      setMethod("recovery");
      setFile(r.file);
      setCode("");
    },
  });
  const verify = useMutation({
    mutationFn: (c: string) => twoFactorVerify(method, c),
    onSuccess: () => {
      qc.clear();
      navigate("/admin", { replace: true });
    },
    onError: () => setCode(""),
  });
  const need = method === "whatsapp" ? 6 : 10;

  return (
    <div className="auth-form">
      <button type="button" className="back-link" onClick={onCancel}>
        <Icon name="chevron-left" size={16} /> Назад
      </button>
      <div className="otp-badge">
        <Icon name="shield" size={26} />
      </div>
      {method === "whatsapp" ? (
        <>
          <h1>Подтвердите вход</h1>
          <p className="lead">Мы отправили 6-значный код в WhatsApp.</p>
          <OtpInput value={code} onChange={setCode} onComplete={(c) => verify.mutate(c)} invalid={verify.isError} disabled={verify.isPending} />
        </>
      ) : (
        <>
          <h1>Код с сервера</h1>
          {file ? (
            <>
              <p className="lead">Код записан в файл на сервере. Выполните на сервере:</p>
              <pre className="cmd">docker compose exec app cat data/{file}</pre>
              <label htmlFor="rec-code">10 цифр из файла</label>
              <input
                id="rec-code"
                className="input code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))}
              />
            </>
          ) : (
            <p className="lead">Создайте одноразовый код — он будет записан в файл на сервере.</p>
          )}
        </>
      )}
      {(verify.isError || recovery.isError) && (
        <div className="alert danger">
          <Icon name="alert" size={17} />
          <div>{errorText(verify.error ?? recovery.error)}</div>
        </div>
      )}
      {method === "recovery" && !file ? (
        <button className="btn primary lg block" disabled={recovery.isPending} onClick={() => recovery.mutate()}>
          {recovery.isPending ? <Spinner /> : <Icon name="file" size={18} />} Создать код
        </button>
      ) : (
        <button className="btn primary lg block" disabled={code.length !== need || verify.isPending} onClick={() => verify.mutate(code)}>
          {verify.isPending ? <Spinner /> : <Icon name="check" size={18} />} Подтвердить
        </button>
      )}
      {method === "whatsapp" && (
        <div className="resend">
          <button className="link-btn" onClick={() => recovery.mutate()} disabled={recovery.isPending}>
            Нет доступа к WhatsApp?
          </button>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [second, setSecond] = useState<{ whatsapp: boolean } | null>(null);
  const mut = useMutation({
    mutationFn: () => login({ phone: phoneDigits(phone), password }),
    onSuccess: (r) => {
      setPassword("");
      if ("two_factor" in r) {
        setSecond({ whatsapp: r.whatsapp });
        return;
      }
      qc.setQueryData(["me"], r);
      navigate("/", { replace: true });
    },
  });
  const can = isPhoneComplete(phone) && password.length > 0 && !mut.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (can) mut.mutate();
  }

  if (second) {
    return (
      <AuthLayout>
        <SecondFactor
          whatsapp={second.whatsapp}
          onCancel={() => {
            void twoFactorCancel().catch(() => undefined);
            setSecond(null);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={submit} noValidate>
        <h1>С возвращением 👋</h1>
        <p className="lead">Войдите, чтобы посмотреть диалоги и настроить AI-агента.</p>

        <label htmlFor="l-phone">Номер телефона</label>
        <PhoneInput id="l-phone" value={phone} onChange={setPhone} autoFocus />

        <div className="label-row">
          <label htmlFor="l-pass">Пароль</label>
          <Link to="/forgot" className="small-link">
            Забыли пароль?
          </Link>
        </div>
        <PasswordInput id="l-pass" autoComplete="current-password" value={password} onChange={setPassword} />

        {mut.isError && (
          <div className="alert danger">
            <Icon name="alert" size={17} />
            <div>{errorText(mut.error)}</div>
          </div>
        )}

        <button className="btn primary lg block" disabled={!can}>
          {mut.isPending ? <Spinner /> : <Icon name="arrow-right" size={18} />}
          Войти
        </button>
        <p className="switch">
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
