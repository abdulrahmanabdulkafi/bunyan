/**
 * API messages are written in Arabic (the platform's primary language). When the client asks for English
 * (Accept-Language: en), the error filter translates them here. Add a line when you add a message.
 */
const EN: Record<string, string> = {
  'بيانات الدخول غير صحيحة': 'Incorrect email or password',
  'المستخدم غير مسجل في المنصة': 'This user is not registered on the platform',
  'خارج نطاق صلاحياتك': 'This is outside your permissions',
  'وحدة البناء غير موجودة': 'Building block not found',
  'وحدة البناء غير مفعّلة في جهتك': 'This building block is not active for your entity',
  'أخطاء في البيانات': 'Some values need fixing',
  'السجل مؤرشف': 'The record is archived',
  'عدّل مستخدم آخر هذا السجل؛ حدّث الصفحة': 'Someone else changed this record. Refresh the page and try again',
  'إجراء غير معروف': 'Unknown action',
  'لا يمكن اعتماد سجل قمت بتعديله (مبدأ الفصل بين المهام)': 'You cannot approve a record you edited (segregation of duties)',
  'سبب الرفض مطلوب': 'Enter a reason for rejecting',
  'العلاقة غير معرّفة': 'This relationship is not defined in the meta-model',
  'نوع السجلين لا يطابق تعريف العلاقة': 'These two records do not match the relationship definition',
  'حقل إلزامي': 'Required',
  'سمة غير معرّفة في هذه الوحدة': 'This attribute is not defined for the building block',
  'يجب أن تكون القيمة رقماً': 'Must be a number',
  'تاريخ غير صالح (YYYY-MM-DD)': 'Invalid date (YYYY-MM-DD)',
  'رابط غير صالح': 'Invalid link',
  'النص أطول من المسموح': 'Text is too long',
  'أرفق ملف Excel': 'Attach an Excel file',
  'الملف ليس من قوالب بُنيان؛ نزّل القالب من المنصة': 'This file is not a Bunyan template. Download the template from the platform',
  'المعرّف غير موجود': 'ID not found',
  'لم يُحفظ أي سجل بسبب الأخطاء': 'No records were saved because of errors',
  'وحدة بناء غير معروفة': 'Unknown building block',
  'لا توجد وحدات بناء متاحة': 'No building blocks available',
  'مدخلات غير صالحة': 'Invalid input',
  'القيمة موجودة مسبقاً': 'This value already exists',
  'مرجع غير موجود': 'Referenced item not found',
  'غير مصرح': 'Not allowed',
  'معرّف غير صالح': 'Invalid identifier',
  'خطأ داخلي': 'Something went wrong on the server',
  'نوع موصّل غير معروف': 'Unknown connector type',
  'حقول ناقصة': 'Some required fields are missing',
  'vCenter رفض بيانات الدخول': 'vCenter rejected the credentials',
  'معرّف مكرر أو فارغ في المصدر': 'Duplicate or empty id in the source',
  'الدليل النشط رفض بيانات الدخول': 'Active Directory rejected the credentials',
  'العنوان يجب أن يبدأ بـ ldaps://': 'The address must start with ldaps://',
  'لم يُعثر على قائمة في الاستجابة؛ راجع مسار القائمة': 'No list found in the response. Check the list path',
  'مدير المنصة يضيف مسؤول الجهة الأول أو مستعرضي اللوحات فقط': 'The platform admin only adds the first entity admin or dashboard viewers',
};

const AR: Record<string, string> = {
  Unauthorized: 'انتهت الجلسة أو لم تسجّل الدخول',
  Forbidden: 'غير مصرح',
  'Not Found': 'غير موجود',
  'not found': 'غير موجود',
};

const PATTERNS_EN: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^قيمة غير مسموحة؛ القيم المتاحة: (.*)$/, (m) => `Value not allowed. Allowed values: ${m[1].replace(/،/g, ',')}`],
  [/^لا يمكن تنفيذ "(.+)" على سجل حالته (.+)$/, (m) => `Cannot ${m[1]} a record in status ${m[2]}`],
  [/^vCenter أعاد الحالة (\d+)$/, (m) => `vCenter returned status ${m[1]}`],
  [/^المصدر أعاد الحالة (\d+)$/, (m) => `The source returned status ${m[1]}`],
  [/^وحدة البناء (.+) غير مفعّلة$/, (m) => `Building block ${m[1]} is not active`],
];

export type Lang = 'ar' | 'en';

export function langOf(header: string | undefined): Lang {
  return (header ?? '').toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export function tr(msg: string, lang: Lang): string {
  if (lang === 'ar') {
    if (AR[msg]) return AR[msg];
    const m = msg.match(/^missing permission (.+)$/);
    return m ? `لا تملك صلاحية ${m[1]}` : msg;
  }
  if (EN[msg]) return EN[msg];
  for (const [re, f] of PATTERNS_EN) { const m = msg.match(re); if (m) return f(m); }
  return msg;
}

/** Translate an error body: its message and every field error. */
export function trBody(body: unknown, lang: Lang): unknown {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? { message: tr(body, lang) } : body;
  const b = { ...(body as Record<string, unknown>) };
  if (typeof b.message === 'string') b.message = tr(b.message, lang);
  if (Array.isArray(b.errors)) b.errors = b.errors.map((e) => (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
    ? { ...e, message: tr((e as { message: string }).message, lang) } : e));
  return b;
}
