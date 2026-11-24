import dns from 'node:dns/promises';
import { Client as LdapClient } from 'ldapts';
import { HttpOpts, blockedAddress, pick, requestJson } from './http.js';

/** One kind of object a connector reads (e.g. vCenter hosts, vCenter VMs). */
export interface SourceEntity {
  key: string;
  name_ar: string;
  name_en: string;
  fields: { path: string; name_ar: string; name_en: string }[];
  /** Default target block and field mapping — the entity admin can change both (FR-05-05). */
  defaultBlock: string;
  defaultMap: FieldMap[];
}

export interface FieldMap { from: string; to: string; transform?: Transform }
export type Transform = 'none' | 'mib_to_gb' | 'bytes_to_gb' | 'upper' | 'lower';

export interface SettingField { key: string; name_ar: string; name_en: string; type: 'text' | 'url' | 'boolean' | 'textarea'; required?: boolean; secret?: boolean; hint_ar?: string; hint_en?: string }

export interface ExternalItem { externalId: string; data: Record<string, unknown> }

export interface ConnectorType {
  type: string;
  name_ar: string;
  name_en: string;
  description_ar: string;
  description_en: string;
  settings: SettingField[];
  /** Entities are fixed (vCenter) or defined by the admin (generic JSON API). */
  entities: (config: Record<string, unknown>) => SourceEntity[];
  test(config: Record<string, unknown>, secret: Record<string, string>): Promise<string>;
  fetch(config: Record<string, unknown>, secret: Record<string, string>, entity: string): Promise<ExternalItem[]>;
}

export function applyTransform(v: unknown, t: Transform = 'none'): unknown {
  if (v === undefined || v === null) return v;
  switch (t) {
    case 'mib_to_gb': return Math.round((Number(v) / 1024) * 100) / 100;
    case 'bytes_to_gb': return Math.round((Number(v) / 1024 ** 3) * 100) / 100;
    case 'upper': return String(v).toUpperCase();
    case 'lower': return String(v).toLowerCase();
    default: return v;
  }
}

class SourceError extends Error {}

function tls(config: Record<string, unknown>): Pick<HttpOpts, 'allowSelfSigned' | 'ca'> {
  return { allowSelfSigned: config.allow_self_signed === true, ca: (config.ca_cert as string) || undefined };
}

// ───────────── VMware vCenter (vSphere Automation REST API, read-only) ─────────────
async function vcSession(config: Record<string, unknown>, secret: Record<string, string>) {
  const base = String(config.url).replace(/\/+$/, '');
  const auth = Buffer.from(`${secret.username}:${secret.password}`).toString('base64');
  const r = await requestJson<string>(`${base}/api/session`, { method: 'POST', headers: { authorization: `Basic ${auth}` }, ...tls(config) });
  if (r.status === 401) throw new SourceError('vCenter رفض بيانات الدخول');
  if (r.status >= 300 || typeof r.body !== 'string') throw new SourceError(`vCenter أعاد الحالة ${r.status}`);
  const token = r.body;
  const get = async <T>(path: string) => {
    const res = await requestJson<T>(`${base}${path}`, { headers: { 'vmware-api-session-id': token }, ...tls(config) });
    if (res.status >= 300) throw new SourceError(`vCenter ${path}: ${res.status}`);
    return res.body;
  };
  const close = () => requestJson(`${base}/api/session`, { method: 'DELETE', headers: { 'vmware-api-session-id': token }, ...tls(config) }).catch(() => undefined);
  return { get, close };
}

const VCENTER: ConnectorType = {
  type: 'vcenter',
  name_ar: 'VMware vCenter',
  name_en: 'VMware vCenter',
  description_ar: 'يقرأ المضيفات المادية والخوادم الافتراضية من vCenter (قراءة فقط) ويحدّث المستودع.',
  description_en: 'Reads ESXi hosts and virtual machines from vCenter (read-only) and updates the repository.',
  settings: [
    { key: 'url', name_ar: 'عنوان vCenter', name_en: 'vCenter URL', type: 'url', required: true, hint_ar: 'مثال: https://vcenter.example.gov.sa', hint_en: 'e.g. https://vcenter.example.gov.sa' },
    { key: 'username', name_ar: 'اسم المستخدم (صلاحية قراءة فقط)', name_en: 'Username (read-only role)', type: 'text', required: true, secret: true },
    { key: 'password', name_ar: 'كلمة المرور', name_en: 'Password', type: 'text', required: true, secret: true },
    { key: 'allow_self_signed', name_ar: 'قبول شهادة موقعة ذاتياً', name_en: 'Accept self-signed certificate', type: 'boolean' },
    { key: 'ca_cert', name_ar: 'شهادة الجهة المصدِّرة (PEM)', name_en: 'CA certificate (PEM)', type: 'textarea' },
  ],
  entities: () => [
    {
      key: 'host', name_ar: 'المضيفات (ESXi)', name_en: 'Hosts (ESXi)', defaultBlock: 'physical_host',
      fields: [
        { path: 'name', name_ar: 'الاسم', name_en: 'Name' },
        { path: 'cluster', name_ar: 'الكتلة', name_en: 'Cluster' },
        { path: 'connection_state', name_ar: 'حالة الاتصال', name_en: 'Connection state' },
        { path: 'power_state', name_ar: 'حالة التشغيل', name_en: 'Power state' },
      ],
      defaultMap: [{ from: 'name', to: 'name' }, { from: 'cluster', to: 'cluster_id' }],
    },
    {
      key: 'vm', name_ar: 'الخوادم الافتراضية', name_en: 'Virtual machines', defaultBlock: 'server',
      fields: [
        { path: 'name', name_ar: 'الاسم', name_en: 'Name' },
        { path: 'guest_OS', name_ar: 'نظام التشغيل', name_en: 'Guest OS' },
        { path: 'cpu_count', name_ar: 'عدد المعالجات', name_en: 'CPU count' },
        { path: 'memory_size_MiB', name_ar: 'الذاكرة (MiB)', name_en: 'Memory (MiB)' },
        { path: 'disk_capacity_bytes', name_ar: 'سعة الأقراص (بايت)', name_en: 'Disk capacity (bytes)' },
        { path: 'power_state', name_ar: 'حالة التشغيل', name_en: 'Power state' },
        { path: 'cluster', name_ar: 'الكتلة', name_en: 'Cluster' },
        { path: 'host_name', name_ar: 'المضيف', name_en: 'Host' },
      ],
      defaultMap: [
        { from: 'name', to: 'server_name' },
        { from: 'guest_OS', to: 'operating_system_type' },
        { from: 'cpu_count', to: 'central_processing_units' },
        { from: 'memory_size_MiB', to: 'random_access_memory_ram', transform: 'mib_to_gb' },
        { from: 'disk_capacity_bytes', to: 'disc', transform: 'bytes_to_gb' },
        { from: 'power_state', to: 'status' },
        { from: 'cluster', to: 'cluster_id' },
      ],
    },
  ],
  async test(config, secret) {
    const s = await vcSession(config, secret);
    const hosts = await s.get<unknown[]>('/api/vcenter/host');
    await s.close();
    return `${hosts.length} host(s)`;
  },
  async fetch(config, secret, entity) {
    const s = await vcSession(config, secret);
    try {
      const clusters = await s.get<{ cluster: string; name: string }[]>('/api/vcenter/cluster');
      const hostCluster = new Map<string, string>();
      for (const c of clusters) {
        for (const h of await s.get<{ host: string }[]>(`/api/vcenter/host?clusters=${encodeURIComponent(c.cluster)}`)) hostCluster.set(h.host, c.name);
      }
      const hosts = await s.get<{ host: string; name: string; connection_state: string; power_state: string }[]>('/api/vcenter/host');
      if (entity === 'host') return hosts.map((h) => ({ externalId: h.host, data: { ...h, cluster: hostCluster.get(h.host) ?? null } }));
      const hostName = new Map(hosts.map((h) => [h.host, h.name]));
      const vms = await s.get<{ vm: string; name: string; power_state: string; cpu_count?: number; memory_size_MiB?: number }[]>('/api/vcenter/vm');
      const out: ExternalItem[] = [];
      for (const v of vms) {
        const d = await s.get<{ guest_OS?: string; cpu?: { count: number }; memory?: { size_MiB: number }; disks?: Record<string, { capacity?: number }>; placement?: { host?: string } }>(`/api/vcenter/vm/${encodeURIComponent(v.vm)}`);
        const host = d.placement?.host;
        out.push({
          externalId: v.vm,
          data: {
            name: v.name, power_state: v.power_state, guest_OS: d.guest_OS,
            cpu_count: d.cpu?.count ?? v.cpu_count, memory_size_MiB: d.memory?.size_MiB ?? v.memory_size_MiB,
            disk_capacity_bytes: Object.values(d.disks ?? {}).reduce((sum, x) => sum + (x.capacity ?? 0), 0) || undefined,
            host_name: host ? hostName.get(host) : undefined, cluster: host ? hostCluster.get(host) : undefined,
          },
        });
      }
      return out;
    } finally { await s.close(); }
  },
};

// ───────────── Generic JSON API (ServiceNow table API, internal CMDBs, …) ─────────────
const JSON_API: ConnectorType = {
  type: 'json_api',
  name_ar: 'واجهة JSON عامة',
  name_en: 'Generic JSON API',
  description_ar: 'يقرأ قائمة عناصر من أي واجهة REST تعيد JSON، مثل جداول ServiceNow أو أنظمة CMDB الداخلية.',
  description_en: 'Reads a list of items from any REST endpoint returning JSON, such as ServiceNow tables or an internal CMDB.',
  settings: [
    { key: 'url', name_ar: 'عنوان الواجهة', name_en: 'Endpoint URL', type: 'url', required: true, hint_ar: 'مثال: https://instance.service-now.com/api/now/table/cmdb_ci_server', hint_en: 'e.g. https://instance.service-now.com/api/now/table/cmdb_ci_server' },
    { key: 'items_path', name_ar: 'مسار القائمة في الاستجابة', name_en: 'Path to the list in the response', type: 'text', hint_ar: 'مثال: result — اتركه فارغاً إن كانت الاستجابة قائمة', hint_en: 'e.g. result — empty if the response is the list' },
    { key: 'id_field', name_ar: 'حقل المعرّف الفريد', name_en: 'Unique id field', type: 'text', required: true, hint_ar: 'مثال: sys_id', hint_en: 'e.g. sys_id' },
    { key: 'source_fields', name_ar: 'الحقول المتاحة (مفصولة بفاصلة)', name_en: 'Available fields (comma separated)', type: 'text', required: true, hint_ar: 'مثال: name, os, cpu_count, ram', hint_en: 'e.g. name, os, cpu_count, ram' },
    { key: 'auth_header', name_ar: 'ترويسة المصادقة', name_en: 'Auth header name', type: 'text', hint_ar: 'مثال: Authorization', hint_en: 'e.g. Authorization' },
    { key: 'auth_value', name_ar: 'قيمة المصادقة', name_en: 'Auth header value', type: 'text', secret: true },
    { key: 'allow_self_signed', name_ar: 'قبول شهادة موقعة ذاتياً', name_en: 'Accept self-signed certificate', type: 'boolean' },
  ],
  entities: (config) => {
    const fields = String(config.source_fields ?? '').split(/[,،]/).map((f) => f.trim()).filter(Boolean);
    return [{
      key: 'items', name_ar: 'العناصر', name_en: 'Items', defaultBlock: 'server',
      fields: fields.map((f) => ({ path: f, name_ar: f, name_en: f })),
      defaultMap: fields.includes('name') ? [{ from: 'name', to: 'server_name' }] : [],
    }];
  },
  async test(config, secret) {
    return `${(await this.fetch(config, secret, 'items')).length} item(s)`;
  },
  async fetch(config, secret) {
    const headers: Record<string, string> = {};
    if (config.auth_header && secret.auth_value) headers[String(config.auth_header)] = secret.auth_value;
    const r = await requestJson(String(config.url), { headers, ...tls(config) });
    if (r.status >= 300) throw new SourceError(`المصدر أعاد الحالة ${r.status}`);
    const list = config.items_path ? pick(r.body, String(config.items_path)) : r.body;
    if (!Array.isArray(list)) throw new SourceError('لم يُعثر على قائمة في الاستجابة؛ راجع مسار القائمة');
    const idField = String(config.id_field);
    return list.map((x) => ({ externalId: String(pick(x, idField) ?? ''), data: x as Record<string, unknown> })).filter((x) => x.externalId);
  },
};

// ───────────── Active Directory (LDAP, read-only) ─────────────
async function ldapClient(config: Record<string, unknown>) {
  const url = new URL(String(config.url));
  if (url.protocol !== 'ldaps:' && url.protocol !== 'ldap:') throw new SourceError('العنوان يجب أن يبدأ بـ ldaps://');
  const { address } = await dns.lookup(url.hostname);
  if (blockedAddress(address)) throw new SourceError(`blocked address ${address}`);
  return new LdapClient({
    url: url.toString().replace(/\/$/, ''),
    timeout: 30_000, connectTimeout: 10_000,
    tlsOptions: url.protocol === 'ldaps:' ? { rejectUnauthorized: config.allow_self_signed !== true, ca: (config.ca_cert as string) || undefined } : undefined,
  });
}

const AD_ATTRS = ['cn', 'dNSHostName', 'operatingSystem', 'operatingSystemVersion', 'description', 'location', 'managedBy', 'whenCreated', 'objectGUID', 'distinguishedName'];

const ACTIVE_DIRECTORY: ConnectorType = {
  type: 'active_directory',
  name_ar: 'Active Directory',
  name_en: 'Active Directory',
  description_ar: 'يقرأ حسابات أجهزة الخوادم من الدليل النشط عبر LDAP (قراءة فقط) ويحدّث سجلات الخوادم.',
  description_en: 'Reads server computer accounts from Active Directory over LDAP (read-only) and updates server records.',
  settings: [
    { key: 'url', name_ar: 'عنوان الخادم', name_en: 'Server URL', type: 'url', required: true, hint_ar: 'مثال: ldaps://dc01.example.gov.sa:636', hint_en: 'e.g. ldaps://dc01.example.gov.sa:636' },
    { key: 'base_dn', name_ar: 'نقطة البدء في الدليل (Base DN)', name_en: 'Base DN', type: 'text', required: true, hint_ar: 'مثال: OU=Servers,DC=example,DC=gov,DC=sa', hint_en: 'e.g. OU=Servers,DC=example,DC=gov,DC=sa' },
    { key: 'filter', name_ar: 'مرشّح البحث', name_en: 'Search filter', type: 'text', hint_ar: 'الافتراضي: أجهزة أنظمة الخوادم فقط', hint_en: 'Default: server operating systems only' },
    { key: 'bind_dn', name_ar: 'حساب الربط (قراءة فقط)', name_en: 'Bind account (read-only)', type: 'text', required: true, secret: true, hint_ar: 'مثال: svc-bunyan@example.gov.sa', hint_en: 'e.g. svc-bunyan@example.gov.sa' },
    { key: 'password', name_ar: 'كلمة المرور', name_en: 'Password', type: 'text', required: true, secret: true },
    { key: 'allow_self_signed', name_ar: 'قبول شهادة موقعة ذاتياً', name_en: 'Accept self-signed certificate', type: 'boolean' },
    { key: 'ca_cert', name_ar: 'شهادة الجهة المصدِّرة (PEM)', name_en: 'CA certificate (PEM)', type: 'textarea' },
  ],
  entities: () => [{
    key: 'computer', name_ar: 'أجهزة الخوادم', name_en: 'Server computers', defaultBlock: 'server',
    fields: [
      { path: 'cn', name_ar: 'الاسم', name_en: 'Name' },
      { path: 'dNSHostName', name_ar: 'اسم النطاق', name_en: 'DNS host name' },
      { path: 'operatingSystem', name_ar: 'نظام التشغيل', name_en: 'Operating system' },
      { path: 'operatingSystemVersion', name_ar: 'إصدار نظام التشغيل', name_en: 'OS version' },
      { path: 'description', name_ar: 'الوصف', name_en: 'Description' },
      { path: 'location', name_ar: 'الموقع', name_en: 'Location' },
      { path: 'managedBy', name_ar: 'المسؤول', name_en: 'Managed by' },
    ],
    defaultMap: [
      { from: 'cn', to: 'server_name', transform: 'upper' },
      { from: 'operatingSystem', to: 'operating_system_type' },
      { from: 'operatingSystemVersion', to: 'operating_system_version' },
    ],
  }],
  async test(config, secret) {
    const c = await ldapClient(config);
    try { await c.bind(secret.bind_dn, secret.password); return 'bind ok'; }
    catch { throw new SourceError('الدليل النشط رفض بيانات الدخول'); }
    finally { await c.unbind().catch(() => undefined); }
  },
  async fetch(config, secret) {
    const c = await ldapClient(config);
    try {
      try { await c.bind(secret.bind_dn, secret.password); } catch { throw new SourceError('الدليل النشط رفض بيانات الدخول'); }
      const filter = String(config.filter || '(&(objectCategory=computer)(operatingSystem=*Server*))');
      const { searchEntries } = await c.search(String(config.base_dn), {
        // Attribute names are case-insensitive in LDAP; requesting them in lower case works with every directory server.
        scope: 'sub', filter, attributes: AD_ATTRS.map((a) => a.toLowerCase()), paged: { pageSize: 500 }, explicitBufferAttributes: ['objectGUID', 'objectguid'],
      });
      return searchEntries.map((e) => {
        const data: Record<string, unknown> = {};
        // LDAP attribute names are case-insensitive; normalise to AD's canonical spelling so mappings always match.
        const canonical = new Map(AD_ATTRS.map((a) => [a.toLowerCase(), a]));
        for (const [k, v] of Object.entries(e)) data[canonical.get(k.toLowerCase()) ?? k] = Array.isArray(v) ? (v.length === 1 ? v[0] : v) : v;
        // objectGUID survives renames and OU moves, so it is the stable key; fall back to the DN.
        const guid = data.objectGUID;
        const id = (Buffer.isBuffer(guid) && guid.length ? guid.toString('hex') : typeof guid === 'string' ? guid : '') || String(e.dn);
        delete data.objectGUID;
        return { externalId: id, data };
      });
    } finally { await c.unbind().catch(() => undefined); }
  },
};

export const CONNECTOR_TYPES: Record<string, ConnectorType> = { vcenter: VCENTER, active_directory: ACTIVE_DIRECTORY, json_api: JSON_API };
export { SourceError };
