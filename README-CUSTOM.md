# OpenList-Worker live customizations (luoqing94)

**Note:** https://github.com/luoqing94/OpenList is a fork of OpenListTeam/OpenList (Go main app),
**not** OpenList-Worker. Live EdgeOne deployment uses OpenList-Worker.

This pack is the Worker tree as deployed locally (EdgeOne), with `cron_secret` cleared in `edgeone.json`.
Never commit personal domains, passwords, or `cron_secret` values.

## EdgeOne Git auto-deploy

Associate the EdgeOne Pages / Cloud Functions Git integration with branch **`custom/live`** (not `main`).

Set secrets and personal hosts **only in the EdgeOne console** (environment / secrets / schedule payload). Do not put them in git. Required names (values stay in console):

| Name | Where | Notes |
| :--- | :--- | :--- |
| `JWT_SECRET` | EdgeOne env / Secret | JWT signing, data encryption, and cron task auth (`matchCronSecret`). |
| `DB_DRIVER` | EdgeOne env | Usually `auto` (EdgeOne → Blob). Use `kv` only with a KV proxy. |
| `DB_FORMAT` | EdgeOne env | Optional; default `map`. |
| `cron_secret` | EdgeOne schedule payload | Must match `JWT_SECRET` at runtime. Keep `""` in `edgeone.json`. |
| `ADMIN_PASS` | EdgeOne env / Secret | Optional; skip the install wizard. |
| `EO_KV_URLS` | EdgeOne env | Only if `DB_DRIVER=kv` on Node Functions. |

Suggested GitHub home: fork `OpenListTeam/OpenList-Worker` as `luoqing94/OpenList-Worker`.
