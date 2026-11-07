import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  familyStore,
  getMode,
  isConnectionError,
  serverStore,
  tokenStore,
} from "../api/client";
import { resumeSync } from "../sync/engine";
import type { DeploymentInfo, Family, Role, User } from "../api/types";

interface MeResponse {
  user: User;
  families: Family[];
  current_family_id: string | null;
  role: Role | null;
  permissions: string[];
  deployment: DeploymentInfo;
}

interface AuthState {
  loading: boolean;
  user: User | null;
  families: Family[];
  family: Family | null;
  familyId: string | null;
  role: Role | null;
  permissions: string[];
  deployment: DeploymentInfo | null;
  /**
   * Set when the server could not be reached at all (as opposed to answering
   * "wrong password"). The shell renders the connect screen instead of a
   * dashboard full of zeroes.
   */
  connectionError: string | null;
  /** Re-run the boot request. Used by the connect screen's retry button. */
  retry: () => Promise<void>;
  can: (perm: string | string[]) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: Record<string, unknown>) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  switchFamily: (id: string) => Promise<void>;
  setDeployment: (d: DeploymentInfo) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [familyId, setFamilyId] = useState<string | null>(familyStore.get());
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Local-first mode has no login screen: the device itself is the identity.
    // The synthetic token keeps the rest of the app's guards unchanged.
    if (getMode() !== "remote" && !tokenStore.get()) tokenStore.set("local");

    if (getMode() === "remote") {
      // Before asking anyone for a password, find out whether there is
      // anything to ask. A packaged app that was switched to server mode and
      // then lost its address used to land on a login form whose every
      // request failed — which looks exactly like a broken app.
      if (!serverStore.get()) {
        setConnectionError("还没有填写服务器地址");
        setLoading(false);
        setUser(null);
        return;
      }
      if (!tokenStore.get()) {
        // Signed out but pointed at a server: prove it answers before showing
        // a login box, so "server is off" is distinguishable from "wrong
        // password" without typing anything.
        try {
          await api("/system/info", { timeoutMs: 6000 });
          setConnectionError(null);
        } catch (err) {
          if (isConnectionError(err)) {
            setConnectionError((err as Error).message || "连不上服务器");
            setLoading(false);
            setUser(null);
            return;
          }
          // A 4xx here still means the server is alive; carry on to login.
          setConnectionError(null);
        }
      }
    }

    if (!tokenStore.get()) {
      setLoading(false);
      setUser(null);
      return;
    }
    try {
      const me = await api<MeResponse>("/auth/me");
      setConnectionError(null);
      setUser(me.user);
      setFamilies(me.families);
      setRole(me.role);
      setPermissions(me.permissions || []);
      setDeployment(me.deployment);
      const saved = familyStore.get();
      const valid = me.families.find((f) => f.id === saved);
      const chosen = valid?.id || me.current_family_id || null;
      if (chosen) {
        familyStore.set(chosen);
        setFamilyId(chosen);
      }
      if (getMode() !== "remote") void resumeSync();
    } catch (err) {
      // A dead server is not a dead session. Clearing the token here would
      // sign the user out every time the NAS reboots, and the next screen
      // would ask for a password they have not forgotten.
      if (isConnectionError(err)) {
        setConnectionError((err as Error).message || "连不上服务器");
      } else {
        setConnectionError(null);
        tokenStore.clear();
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ token: string; current_family_id: string | null }>(
        "/auth/login",
        { method: "POST", body: { email, password } }
      );
      tokenStore.set(res.token);
      if (res.current_family_id) familyStore.set(res.current_family_id);
      setLoading(true);
      await load();
    },
    [load]
  );

  const register = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await api<{ token: string; current_family_id: string | null }>(
        "/auth/register",
        { method: "POST", body: payload }
      );
      tokenStore.set(res.token);
      if (res.current_family_id) familyStore.set(res.current_family_id);
      setLoading(true);
      await load();
    },
    [load]
  );

  const logout = useCallback(() => {
    // Signing out of a local library would be theatre — anyone holding the
    // device can reopen it. Only a server session can actually be revoked.
    if (getMode() === "remote") {
      tokenStore.clear();
      familyStore.clear();
      setConnectionError(null);
    }
    setUser(null);
    setFamilies([]);
    setRole(null);
    setPermissions([]);
  }, []);

  const switchFamily = useCallback(
    async (id: string) => {
      familyStore.set(id);
      setFamilyId(id);
      setLoading(true);
      await load();
    },
    [load]
  );

  const can = useCallback(
    (perm: string | string[]) => {
      if (!user) return false;
      const list = Array.isArray(perm) ? perm : [perm];
      return list.some((p) => permissions.includes(p));
    },
    [permissions, user]
  );

  const family = useMemo(
    () => families.find((f) => f.id === familyId) || families[0] || null,
    [families, familyId]
  );

  const value: AuthState = {
    loading,
    user,
    families,
    family,
    familyId: family?.id || null,
    role,
    permissions,
    deployment,
    connectionError,
    retry: load,
    can,
    login,
    register,
    logout,
    refresh: load,
    switchFamily,
    setDeployment,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "家庭所有者",
  admin: "家庭管理员",
  member: "普通成员",
  viewer: "只读成员",
  guest: "访客",
};
