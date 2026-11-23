export interface SettingField { key: string; name_ar: string; name_en: string; type: 'text' | 'url' | 'boolean' | 'textarea'; required?: boolean; secret?: boolean; hint_ar?: string; hint_en?: string }
export interface FieldMap { from: string; to: string; transform?: string }
export interface SourceEntity { key: string; name_ar: string; name_en: string; fields: { path: string; name_ar: string; name_en: string }[]; defaultBlock: string; defaultMap: FieldMap[] }
export interface ConnectorType { type: string; name_ar: string; name_en: string; description_ar: string; description_en: string; settings: SettingField[]; entities: SourceEntity[] }
export interface Target { entity: string; block: string; enabled: boolean; mode: 'overwrite' | 'fill_empty'; fields: FieldMap[] }
export interface Run { id: string; status: string; trigger: string; created: number; updated: number; unchanged: number; conflicts: number; started_at: string; finished_at: string | null; details?: Detail[]; started_by_name?: string | null }
export interface Detail { kind: 'conflict' | 'error'; name?: string; attribute?: string; repository?: unknown; source?: unknown; message?: string; external_id?: string; errors?: { key: string; message: string }[] }
export interface Connector {
  id: string; name: string; type: string; enabled: boolean; auto_approve: boolean; schedule_minutes: number | null; last_run_at: string | null; has_secret: boolean;
  config: { settings: Record<string, unknown>; targets: Target[] }; last_run: Run | null;
}
export const SCHEDULES = [null, 60, 360, 1440, 10080];
export const TRANSFORMS = ['none', 'mib_to_gb', 'bytes_to_gb', 'upper', 'lower'];
