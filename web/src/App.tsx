import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router";
import { ApiError } from "./api/client";
import { adminMe, getMe } from "./api/endpoints";
import Layout from "./components/Layout";
import { onlyWhenSignedIn, PageLoader, Toaster, useFirstLoad } from "./components/ui";
import AgentPage from "./pages/AgentPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import ForgotPage from "./pages/auth/ForgotPage";
import LoginPage from "./pages/auth/LoginPage";
import RegisterPage from "./pages/auth/RegisterPage";
import ChatsPage from "./pages/ChatsPage";
import DashboardPage from "./pages/DashboardPage";
import KnowledgePage from "./pages/KnowledgePage";
import ProfilePage from "./pages/ProfilePage";
import WhatsAppPage from "./pages/WhatsAppPage";

// The admin UI is a separate chunk, fetched only when /admin is opened —
// it is not part of the bundle every visitor downloads.
const AdminPage = lazy(() => import("./pages/admin/AdminPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});

function RequireAuth() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, refetchOnWindowFocus: onlyWhenSignedIn });
  if (useFirstLoad(me)) return <PageLoader />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Signed-in users skip the auth screens. */
function GuestOnly() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, refetchOnWindowFocus: onlyWhenSignedIn });
  // Never swap the login/registration form for a spinner after the first
  // check — that is what wiped the code step when the tab lost focus.
  if (useFirstLoad(me)) return <PageLoader />;
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** /admin for anyone without a full admin session behaves like an unknown
 *  page, and the admin chunk is never even downloaded. */
function AdminGate() {
  const me = useQuery({ queryKey: ["admin-me"], queryFn: adminMe, retry: false });
  if (useFirstLoad(me)) return <PageLoader />;
  if (!me.data) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<PageLoader />}>
      <AdminPage />
    </Suspense>
  );
}

const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/register", element: <RegisterPage /> },
      { path: "/forgot", element: <ForgotPage /> },
    ],
  },
  { path: "/admin", element: <AdminGate /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: "/", element: <DashboardPage /> },
          { path: "/chats", element: <ChatsPage /> },
          { path: "/chats/:chatId", element: <ChatsPage /> },
          { path: "/whatsapp", element: <WhatsAppPage /> },
          { path: "/agent", element: <AgentPage /> },
          { path: "/knowledge", element: <KnowledgePage /> },
          { path: "/analytics", element: <AnalyticsPage /> },
          { path: "/profile", element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
