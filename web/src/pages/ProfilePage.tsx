import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { errorText } from "../api/client";
import { changePassword, deleteAccount, getMe, updateMe } from "../api/endpoints";
import Icon from "../components/Icon";
import { Avatar, PageLoader, PasswordInput, Spinner, toast } from "../components/ui";
import { dateLong, formatPhone } from "../lib/format";

export default function ProfilePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [delPass, setDelPass] = useState("");

  useEffect(() => {
    if (me.data) {
      setName(me.data.user.name);
      setCompany(me.data.user.company);
    }
  }, [me.data]);

  const save = useMutation({
    mutationFn: () => updateMe({ name: name.trim(), company: company.trim() }),
    onSuccess: (r) => {
      qc.setQueryData(["me"], r);
      toast("Профиль сохранён");
    },
    onError: (e) => toast(errorText(e) ?? "Ошибка", "error"),
  });
  const pass = useMutation({
    mutationFn: () => changePassword({ current_password: cur, new_password: next }),
    onSuccess: () => {
      setCur("");
      setNext("");
      toast("Пароль изменён. Другие сеансы завершены.");
    },
  });
  const del = useMutation({
    mutationFn: () => deleteAccount({ password: delPass }),
    onSuccess: () => {
      qc.clear();
      navigate("/register", { replace: true });
    },
  });

  if (!me.data) return <PageLoader />;
  const u = me.data.user;
  const dirty = name.trim() !== u.name || company.trim() !== u.company;

  return (
    <div className="profile">
      <section className="card profile-head">
        <Avatar name={u.name} seed={u.phone} size={64} />
        <div>
          <h2>{u.name}</h2>
          <div className="muted">
            {formatPhone(u.phone)} · с нами с {dateLong(u.created_at)}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Личные данные</h2>
        </div>
        <div className="grid-2">
          <div>
            <label htmlFor="p-name">Имя</label>
            <input id="p-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="p-company">Компания</label>
            <input id="p-company" className="input" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
          </div>
        </div>
        <label>Телефон для входа</label>
        <input className="input" value={formatPhone(u.phone)} disabled />
        <div className="card-actions">
          <button className="btn primary" disabled={!dirty || name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner /> : null} Сохранить
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Смена пароля</h2>
        </div>
        <div className="grid-2">
          <div>
            <label>Текущий пароль</label>
            <PasswordInput autoComplete="current-password" value={cur} onChange={setCur} />
          </div>
          <div>
            <label>Новый пароль</label>
            <PasswordInput autoComplete="new-password" placeholder="Минимум 8 символов" value={next} onChange={setNext} />
          </div>
        </div>
        {pass.isError && <div className="alert danger">{errorText(pass.error)}</div>}
        <div className="card-actions">
          <button className="btn primary" disabled={!cur || next.length < 8 || pass.isPending} onClick={() => pass.mutate()}>
            {pass.isPending ? <Spinner /> : <Icon name="lock" size={16} />} Изменить пароль
          </button>
        </div>
      </section>

      <section className="card danger-zone">
        <div className="card-head">
          <h2>Удаление аккаунта</h2>
        </div>
        <p className="muted">
          Удалятся все диалоги, настройки агента и база знаний, а WhatsApp будет отключён. Действие нельзя отменить.
        </p>
        {delOpen ? (
          <div className="inline-form">
            <PasswordInput autoComplete="current-password" placeholder="Пароль для подтверждения" value={delPass} onChange={setDelPass} />
            <button className="btn danger" disabled={!delPass || del.isPending} onClick={() => del.mutate()}>
              {del.isPending ? <Spinner /> : null} Удалить навсегда
            </button>
            <button className="btn ghost" onClick={() => setDelOpen(false)}>
              Отмена
            </button>
          </div>
        ) : (
          <button className="btn ghost danger-text" onClick={() => setDelOpen(true)}>
            <Icon name="trash" size={16} /> Удалить аккаунт
          </button>
        )}
        {del.isError && <div className="alert danger">{errorText(del.error)}</div>}
      </section>
    </div>
  );
}
