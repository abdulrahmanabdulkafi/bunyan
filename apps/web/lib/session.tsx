'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, Model, User } from './api';

interface Session { user: User | null; model: Model | null; tenant: { name_ar: string; name_en: string | null } | null; reloadModel: () => Promise<void>; queue: number; refreshQueue: () => void }
const Ctx = createContext<Session>({ user: null, model: null, tenant: null, reloadModel: async () => {}, queue: 0, refreshQueue: () => {} });
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [tenant, setTenant] = useState<Session['tenant']>(null);
  const [queue, setQueue] = useState(0);

  const reloadModel = useCallback(async () => { setModel(await api<Model>('/metamodel')); }, []);
  const refreshQueue = useCallback(() => { api<unknown[]>('/approvals/queue').then((q) => setQueue(q.length)).catch(() => undefined); }, []);

  useEffect(() => {
    if (!getToken()) { window.location.href = '/login'; return; }
    (async () => {
      const me = await api<User>('/auth/me');
      setUser(me);
      const tenants = await api<{ id: string; name_ar: string; name_en: string | null }[]>('/tenants');
      setTenant(tenants.find((t) => t.id === me.tenantId) ?? null);
      if (me.tenantId) await reloadModel();
      refreshQueue();
    })().catch(() => undefined);
  }, [reloadModel, refreshQueue]);

  return <Ctx.Provider value={{ user, model, tenant, reloadModel, queue, refreshQueue }}>{children}</Ctx.Provider>;
}
