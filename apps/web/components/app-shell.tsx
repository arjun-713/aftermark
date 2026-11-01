"use client";
import { createContext, useContext, useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListTree,
  Inbox,
  SlidersHorizontal,
  Layers,
  FlaskConical,
  Plug,
  Settings,
  BookOpen,
  ArrowUpRight,
  Menu,
  LogOut,
  ScanEye,
  X,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../lib/api";
import { ErrorState, Loading, Empty } from "./ui";
type Scope = {
  workspaceId: string;
  projectId: string;
  role: string;
  user: any;
  workspaces: any[];
  projects: any[];
  authMode: string;
  notify: (message: string) => void;
};
const ScopeContext = createContext<Scope | null>(null);
export const useScope = () => useContext(ScopeContext)!;
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: true },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AppShell>{children}</AppShell>
    </QueryClientProvider>
  );
}
const items = [
  ["Overview", "/app", LayoutDashboard],
  ["Runs", "/app/runs", ListTree],
  ["Review inbox", "/app/reviews", Inbox],
  ["Policies", "/app/policies", SlidersHorizontal],
  ["Datasets", "/app/datasets", Layers],
  ["Experiments", "/app/experiments", FlaskConical],
  ["Connections", "/app/connections", Plug],
] as const;
function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const me = useQuery({ queryKey: ["me"], queryFn: () => api("/me") });
  useEffect(() => {
    if (me.data && !workspaceId) {
      const stored = localStorage.getItem("aq-workspace");
      setWorkspaceId(
        me.data.workspaces.find((w: any) => w.id === stored)?.id ??
          me.data.workspaces[0]?.id ??
          "",
      );
    }
  }, [me.data, workspaceId]);
  const projects = useQuery<any[]>({
    queryKey: ["projects", workspaceId],
    queryFn: () => api("/projects", workspaceId),
    enabled: !!workspaceId,
  });
  useEffect(() => {
    if (projects.data) {
      const stored = localStorage.getItem(`aq-project-${workspaceId}`);
      setProjectId(
        projects.data.find((p) => p.id === stored)?.id ??
          projects.data[0]?.id ??
          "",
      );
    }
  }, [projects.data, workspaceId]);
  useEffect(() => {
    setMenu(false);
  }, [path]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const overview = useQuery({
    queryKey: ["overview", workspaceId, projectId],
    queryFn: () => api(`/overview?projectId=${projectId}`, workspaceId),
    enabled: !!projectId && !!workspaceId,
    refetchInterval: 15000,
  });
  const workspace = me.data?.workspaces.find((w: any) => w.id === workspaceId);
  const project = projects.data?.find((p) => p.id === projectId);
  const navigation = (
    <>
      <Link className="wordmark" href="/app">
        <ScanEye size={25} strokeWidth={1.5} />
        <span>Agent Quality</span>
      </Link>
      <div className="nav-group-label">Workspace</div>
      <nav aria-label="Primary navigation">
        {items.map(([name, href, Icon]) => (
          <Link
            className={`nav-item ${path === href || (href !== "/app" && path.startsWith(href)) ? "active" : ""}`}
            href={href}
            key={name}
          >
            <Icon size={17} strokeWidth={1.5} />
            <span>{name}</span>
            {name === "Review inbox" &&
              overview.data?.metrics.open_reviews > 0 && (
                <span className="nav-count">
                  {overview.data.metrics.open_reviews}
                </span>
              )}
          </Link>
        ))}
      </nav>
      <div className="nav-bottom">
        <Link
          className={`nav-item ${path.startsWith("/app/settings") ? "active" : ""}`}
          href="/app/settings"
        >
          <Settings size={17} strokeWidth={1.5} />
          Settings
        </Link>
        <Link className="nav-item" href="/help">
          <BookOpen size={17} strokeWidth={1.5} />
          Documentation
          <ArrowUpRight size={13} />
        </Link>
        <div className="user-row">
          <span className="avatar">
            {me.data?.user?.name
              ?.split(" ")
              .map((n: string) => n[0])
              .join("")
              .slice(0, 2) ?? "—"}
          </span>
          <span>
            <strong>{me.data?.user?.name ?? "Workspace member"}</strong>
            <small>{workspace?.role ?? "Signing in…"}</small>
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={async () => {
              await api("/auth/logout", undefined, { method: "POST" });
              location.href = "/login";
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </>
  );
  if (me.error)
    return (
      <main className="auth">
        <h1>Agent Quality</h1>
        <ErrorState error={me.error} retry={() => me.refetch()} />
      </main>
    );
  return (
    <ScopeContext.Provider
      value={{
        workspaceId,
        projectId,
        role: workspace?.role ?? "viewer",
        user: me.data?.user,
        workspaces: me.data?.workspaces ?? [],
        projects: projects.data ?? [],
        authMode: me.data?.authMode ?? "",
        notify: setToast,
      }}
    >
      <div className="app-frame">
        <aside className="sidebar">{navigation}</aside>
        <div className="workspace-main">
          <header className="topbar">
            <Dialog.Root open={menu} onOpenChange={setMenu}>
              <Dialog.Trigger
                className="icon-button mobile-menu"
                aria-label="Open navigation"
              >
                <Menu size={20} />
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="modal-overlay" />
                <Dialog.Content className="mobile-nav">
                  <Dialog.Title className="sr-only">
                    Workspace navigation
                  </Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Switch workspace views and account settings.
                  </Dialog.Description>
                  <Dialog.Close
                    className="icon-button mobile-close"
                    aria-label="Close navigation"
                  >
                    <X size={18} />
                  </Dialog.Close>
                  {navigation}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <div className="scope-select">
              <select
                aria-label="Workspace"
                value={workspaceId}
                onChange={(e) => {
                  setProjectId("");
                  setWorkspaceId(e.target.value);
                  localStorage.setItem("aq-workspace", e.target.value);
                }}
              >
                {me.data?.workspaces.map((w: any) => (
                  <option value={w.id} key={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <span className="slash">/</span>
              <select
                aria-label="Project"
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  localStorage.setItem(
                    `aq-project-${workspaceId}`,
                    e.target.value,
                  );
                }}
              >
                <option value="" disabled>
                  Select a project
                </option>
                {projects.data?.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="topbar-right">
              {me.data?.authMode === "local" && (
                <span className="local-label">Local development</span>
              )}
              <Link className="btn secondary small" href="/app/onboarding">
                Instrument agent
                <ArrowUpRight size={13} />
              </Link>
            </div>
          </header>
          <main id="main" className="sheet">
            <a href="#page-content" className="skip-link">
              Skip to content
            </a>
            <div className="breadcrumb">
              {project?.name ?? "Workspace"}
              <span>/</span>
              {items.find(([, href]) => href === path)?.[0] ??
                (path.includes("/runs/") ? "Run detail" : "Workspace settings")}
            </div>
            <div id="page-content">
              {me.isPending || (projects.isPending && !!workspaceId) ? (
                <Loading rows={6} />
              ) : projects.error ? (
                <ErrorState
                  error={projects.error}
                  retry={() => projects.refetch()}
                />
              ) : !projectId &&
                path !== "/app/onboarding" &&
                path !== "/app/team" ? (
                <Empty
                  title={
                    me.data?.workspaces.length
                      ? "Create your first project"
                      : "Create your workspace"
                  }
                >
                  Start by naming the workspace and project for your agent.
                  <Link href="/app/onboarding" className="btn primary">
                    Get started
                  </Link>
                </Empty>
              ) : (
                children
              )}
            </div>
          </main>
        </div>
        {toast && (
          <div className="toast" role="status">
            {toast}
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToast("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </ScopeContext.Provider>
  );
}
