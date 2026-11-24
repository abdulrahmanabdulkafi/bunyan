# استخراج مكتبات ضوابط الهيئة الوطنية للأمن السيبراني

هذه الأدوات أنتجت ملفات `packages/seed/nca-*.json` من الوثائق الرسمية. تُستخدم عند صدور إصدار جديد.

| الإطار | المصدر | الطريقة |
|---|---|---|
| ECC-2:2024، CSCC-2:2026، OTCC-1:2022 | وثيقة PDF العربية | `cidpage.py` يقرأ الحروف ومواضعها، ويعيد الحروف المركّبة التي يُسقطها خط AdobeArabic (جدول `cidmap_adobe.json`)، ثم `tparse.py` يقرأ جداول الضوابط بأعمدة الرموز وحدود الصفوف |
| DCC-1:2022، TCC-1:2021 | أداة التقييم والالتزام (Excel) | `xparse.py` |
| CCC-2:2024 | الشكل (٢) في الوثيقة | الهيكل فقط؛ جداول الضوابط في الوثيقة صور |

```bash
python3 cidpage.py ECC.pdf ecc.pages.json cidmap_adobe.json
python3 -c "import json,tparse; json.dump(tparse.extract_controls(json.load(open('ecc.pages.json')), 14, 26), open('ecc.items.json','w'), ensure_ascii=False)"
python3 xparse.py DCC_Assessment_Tool.xlsx "حالة الالتزام بالضوابط" dcc.items.json
python3 build_seeds.py   # يكتب packages/seed/nca-*.json ويطبع الأعداد للمقارنة بما تذكره كل وثيقة
```

تحقّق دائماً من أن الأعداد المطبوعة تطابق ما تذكره الوثيقة في قسم «هيكلية الضوابط» قبل اعتماد الملفات.
