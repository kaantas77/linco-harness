# Linco Harness

Linco Harness, Pi Agent döngüsünün üstündeki backend'dir. Model çağrısını ve araç yürütmesini Pi yapar. Oturum, worker havuzu, araç politikası, bellek, skill, otomasyon ve maliyet kaydı Linco'ya aittir.

Bu depo faz 1'dir. Hermes'in yerine geçecek çalışan çekirdek burada kurulur. DeepSeek Harness, Hermes ve NeMo kaynakları yan klasörlerde referans olarak durur; bu deponun içine kopyalanmadı.

## Çalıştırma

Node 22.19 veya üstü gerekir.

```bash
npm install
npm test
npm run build
DEEPSEEK_API_KEY=... node dist/cli.js serve
node dist/cli.js task --user ada "Çalışma alanına merhaba.txt yaz"
node dist/cli.js bench
```

`bench` ağa çıkmaz ve `reports/offline.json` ile `reports/offline.md` yazar. Gerçek DeepSeek karşılaştırması `node dist/cli.js bench --live`. Anahtar yoksa canlı rapor üretilmez; komut beklemede olduğunu yazar ve çıkış kodu 0'dır. Canlı rapor `reports/live.json` ve `reports/live.md` dosyalarıdır. Bu raporlar ölçüm tutar. Bir koşunun diğerinden hızlı veya ucuz olduğunu söylemez.

Varsayılan model `deepseek-flash`. Değiştirmek için `LINCO_MODEL=deepseek-v4-pro`.

## HTTP

Sunucu `127.0.0.1:8787` üzerinde açılır. Mesaj gönderince yeni bir process doğmaz. Görev kuyruğa yazılır, hazır worker onu alır.

- `POST /v1/users` `{ "name" }`
- `POST /v1/sessions` `{ "userId" }`
- `POST /v1/sessions/:id/messages` `{ "text", "waitMs" }`
- `GET /v1/tasks/:id`
- `POST /v1/tasks/:id/cancel`
- `POST /v1/tasks/:id/approve` `{ "approvalId", "decision": "approved" | "denied" }`
- `GET /v1/tasks/:id/observe`
- `GET|POST /v1/users/:id/memories`, `PATCH|DELETE /v1/memories/:id`
- `GET /v1/skills`
- `POST /v1/users/:id/automations`
- `POST /v1/webhooks/:token`
- `GET /health`

## Düzen

```text
src/agent/runtime.ts      warm worker pool and Pi Agent runs
src/llm/deepseek.ts       Pi DeepSeek provider
src/prompt/layout.ts      stable system prompt, volatile tail
src/tools/                files, shell, web, code mode, skills, memory, tasks
src/security/             workspace jail and command policy
src/db/database.ts        SQLite sessions, tasks, memory, traces
src/automation/cron.ts    cron and interval schedules
src/server/http.ts        backend API
src/bench/                offline scenarios, live Pi vs Linco comparison, JSON and Markdown reports
skills/                   skill catalog loaded into the stable prompt
```

Ayrıntı ve sıradaki faz: `HANDOFF.md`. Tasarım notu: `ARCHITECTURE.md`.
