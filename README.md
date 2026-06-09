# smoke-checks

Read-only smoke-tests voor WordPress-sites, automatisch na elke plugin-update.
Playwright doet de checks (pagina laadt, kernelementen aanwezig, screenshot),
GitHub Actions draait ze, Supabase bewaart de resultaten, en een afgeschermd
dashboard toont de status per site.

```
WP-site (plugin-update)  ──repository_dispatch──►  GitHub Actions (Playwright)
                                                          │
                                                          ▼
                                                      Supabase  ◄── dashboard (login)
                                                  (runs/checks + screenshots)
```

Geen test-mode, geen geprivilegieerde callbacks, geen IP-whitelisting nodig —
de checks zijn gewoon bezoekersverkeer naar de publieke site.

## Mappen

| Pad | Inhoud |
|---|---|
| `sites/*.json` | Eén bestand per site: URL + te checken pagina's/selectors |
| `src/` | Playwright-runner (TypeScript) |
| `supabase/schema.sql` | Database + Storage-bucket + RLS |
| `dashboard/` | Statisch dashboard (Supabase Auth), draait lokaal of via GitHub Pages |
| `.github/workflows/smoke.yml` | De CI-run (dispatch / handmatig / dagelijks) |
| `integrations/dp-toolbox-trigger.php` | WP-snippet die na een update de run start |

## Lokaal draaien

```bash
npm install
npx playwright install chromium
npm run smoke              # alle sites
npm run smoke -- tvrapid   # één site
```

Resultaten komen in `results/latest.json` + `results/screenshots/`.
Zonder Supabase-credentials draait het prima — dan alleen lokaal.

## Supabase koppelen

1. Maak een Supabase-project (of gebruik een bestaand).
2. SQL Editor → plak `supabase/schema.sql` → run.
3. Maak minstens één gebruiker aan (Authentication → Users) om in te loggen.
4. **GitHub** → repo → Settings → Secrets → Actions:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` (service-role key — geheim)
5. Dashboard: kopieer `dashboard/config.example.js` → `dashboard/config.js`
   en vul `supabaseUrl` + **anon** key in (publiek, beschermd door RLS).

## Auto-aanmelden + trigger (DP Toolbox)

Plaats `integrations/dp-toolbox-smoke-checks.php` als DP Toolbox code-snippet of
mu-plugin op de site. Die doet twee dingen:

1. **Auto-aanmelden** bij activatie → de site verschijnt **pending** in het
   dashboard en moet daar goedgekeurd worden (edge function `enroll-site`).
2. **Trigger** na elke plugin-update → start een run voor die site.

**Aanmelden werkt zero-config**: het enrollment-token zit als default in het
snippet (bewust publiek — aanmeldingen zijn approval-gated, dus het token is een
spam-filter, geen geheim). Zodra DP Toolbox draait meldt de site zich aan.

Optioneel in `wp-config.php`:

```php
define('SMOKE_GH_TOKEN', 'github_pat_...');  // ECHT geheim: PAT voor de update-trigger
// define('SMOKE_ENROLL_SECRET', '...');     // eigen enrollment-token i.p.v. de default
// define('SMOKE_SITE_SLUG', 'eigen-slug');  // standaard afgeleid van de host
```

De slug wordt standaard afgeleid van de host (`tvrapid.nl` → `tvrapid-nl`).

### Enroll-functie

Broncode in `supabase/functions/enroll-site/`. Deploy met `verify_jwt=false`
(eigen secret-auth). Het secret staat in de privé-tabel `app_config`
(`key = 'enroll_secret'`), alleen leesbaar met de service-role.

## Een site toevoegen

Nieuw bestand `sites/<slug>.json`:

```json
{
  "slug": "voorbeeld",
  "name": "Voorbeeld",
  "baseUrl": "https://voorbeeld.nl",
  "checks": [
    { "name": "Home", "path": "/", "requiredSelectors": ["header", "footer"] }
  ]
}
```

## Status

MVP: laden (HTTP-status) + verplichte selectors/tekst + screenshot.
Nog te doen: visuele diff t.o.v. baseline, e-mail/Slack-notificatie bij fail.
