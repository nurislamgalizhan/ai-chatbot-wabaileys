import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { getAgent, getDashboard, getMe, logout, toggleAi } from "../api/endpoints";
import { formatPhone } from "../lib/format";
import Icon, { type IconName, Logo } from "./Icon";
import { Avatar, toast } from "./ui";

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Обзор", icon: "grid", end: true },
  { to: "/chats", label: "Чаты", icon: "chat" },
  { to: "/whatsapp", label: "WhatsApp", icon: "link" },
  { to: "/agent", label: "AI-агент", icon: "bot" },
  { to: "/knowledge", label: "База знаний", icon: "book" },
  { to: "/analytics", label: "Аналитика", icon: "chart" },
];

const TITLES: Record<string, string> = {
  "/": "Обзор",
  "/chats": "Чаты",
  "/whatsapp": "Подключение WhatsApp",
  "/agent": "AI-агент",
  "/knowledge": "База знаний",
  "/analytics": "Аналитика",
  "/profile": "Профиль",
};

function AiSwitch() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const agent = useQuery({ queryKey: ["agent"], queryFn: getAgent });
  const mut = useMutation({
    mutationFn: toggleAi,
    onSuccess: (r) => {
      qc.setQueryData(["agent"], (old: Awaited<ReturnType<typeof getAgent>> | undefined) =>
        old ? { ...old, ai_enabled: r.ai_enabled } : old,
      );
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast(r.ai_enabled ? "AI-агент включён" : "AI-агент выключен во всех чатах");
    },
    onError: () => toast("Не удалось переключить AI", "error"),
  });
  if (!agent.data || !me.data) return null;
  if (!me.data.ai_access.active) {
    return (
      <button className="ai-pill locked" onClick={() => navigate("/")} title="Доступ к AI не активирован или истёк">
        <Icon name="lock" size={14} />
        <span className="label">AI не подключён</span>
      </button>
    );
  }
  const on = agent.data.ai_enabled;
  return (
    <button
      className={`ai-pill ${on ? "on" : "off"}`}
      disabled={mut.isPending}
      onClick={() => mut.mutate(!on)}
      title="Главный выключатель: останавливает AI во всех чатах сразу"
    >
      <span className="pulse" />
      <span className="label">{on ? "AI отвечает" : "AI на паузе"}</span>
      <Icon name="power" size={15} />
    </button>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 20_000 });

  useEffect(() => setMenuOpen(false), [pathname]);

  async function onLogout() {
    try {
      await logout();
    } finally {
      qc.clear();
      navigate("/login", { replace: true });
    }
  }

  const unread = dash.data?.unread_chats ?? 0;
  const waOk = dash.data?.whatsapp.status === "connected";
  const isChats = pathname.startsWith("/chats");
  const user = me.data?.user;

  return (
    <div className={`shell ${menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <Logo size={34} />
          <span>
            Alma <b>AI</b>
          </span>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon name={n.icon} size={19} />
              <span>{n.label}</span>
              {n.to === "/chats" && unread > 0 && <span className="nav-badge">{unread > 99 ? "99+" : unread}</span>}
              {n.to === "/whatsapp" && dash.data && (
                <span className={`nav-dot ${waOk ? "ok" : "off"}`} title={waOk ? "Подключён" : "Не подключён"} />
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/profile" className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name="user" size={19} />
            <span>Профиль</span>
          </NavLink>
          <button className="nav-btn" onClick={() => void onLogout()}>
            <Icon name="logout" size={19} />
            <span>Выйти</span>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setMenuOpen(false)} />

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-btn burger" onClick={() => setMenuOpen(true)} aria-label="Меню">
              <Icon name="menu" />
            </button>
            <h1>{TITLES[isChats ? "/chats" : pathname] ?? "Alma AI"}</h1>
          </div>
          <div className="topbar-right">
            <AiSwitch />
            {user && (
              <NavLink to="/profile" className="user-pill">
                <Avatar name={user.name} seed={user.phone} size={34} />
                <span className="who">
                  <span className="name">{user.name}</span>
                  <span className="sub">{user.company || formatPhone(user.phone)}</span>
                </span>
              </NavLink>
            )}
          </div>
        </header>
        {/* The chats screen manages its own scrolling inside panes: the page
            itself must be a fixed-height flex box, never a scrolling column.
            (That was the full-page dialog bug in the original panel.) */}
        <main className={isChats ? "page page--fill" : "page"}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
