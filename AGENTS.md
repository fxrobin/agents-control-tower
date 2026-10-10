# AGENTS.md — Agents Control Tower

Guide pour les agents de code (Claude Code, OpenCode, Mistral Vibe…) qui interviennent sur ce dépôt.

## En bref

Dashboard web local, **lecture seule**, des sessions d'agents IA (Claude Code, OpenCode,
Mistral Vibe). Node.js ≥ 18, modules ES, **aucune dépendance npm**, frontend vanilla.
**Linux uniquement** (lecture de `/proc`).

## Structure

| Fichier | Rôle |
|---------|------|
| `server.js` | Serveur `http` natif sur `127.0.0.1:${PORT:-3417}` : fichiers statiques de `public/` + routes `/api/*` |
| `collector.js` | Sessions Claude Code : `~/.claude/sessions/*.json` (statut `idle`/`busy`/`waiting`, `waitingFor`, `bridgeSessionId`), PID vivant via `kill(pid, 0)`, transcripts `~/.claude/projects/**/*.jsonl` lus de façon incrémentale (offset mémorisé par fichier), RSS et cwd via `/proc` |
| `collector-opencode.js` | Sessions OpenCode via `opencode db "<SQL>" --format json`, processus vivants via `ps` |
| `collector-quota.js` | Quota claude.ai 5 h / 7 j (+ historique et prévision d'épuisement) et contexte exact de la dernière session rendue, relus dans le cache de la status line `claude-statusbar` (`${CLAUDE_STATUSBAR_CACHE:-~/.cache/claude-statusbar}`), renvoyé dans `/api/sessions` → `quota`. Jamais d'appel réseau ni de lecture d'identifiants |
| `collector-vibe.js` | Sessions Mistral Vibe : `${VIBE_HOME:-~/.vibe}/logs/session/**/meta.json` + `active/*.lock` |
| `public/` | `index.html`, `style.css`, `app.js` : onglets Claude / OpenCode / Vibe, composant `.card` commun |
| `run.sh` / `stop.sh` | Démarrage en arrière-plan (log dans `.run.log`) + ouverture navigateur / arrêt par port |

## Règles

- **Zéro dépendance** : n'ajoute pas de package npm (ni Express, ni framework front) sans accord explicite.
- **Lecture seule** : les collecteurs ne modifient jamais les fichiers des agents observés et
  n'envoient aucun signal aux processus (seul `kill(pid, 0)` est autorisé, pour tester la vie d'un PID).
- **Local uniquement** : le serveur reste bindé sur `127.0.0.1`. Les transcripts contiennent
  du code et des prompts privés : rien ne sort de la machine.
- Une source illisible (outil absent, format changé) doit dégrader proprement l'onglet concerné
  (réponse d'erreur JSON), jamais faire tomber le serveur.
- Garder le même contrat d'API (`/api/sessions`, `/api/opencode-sessions`, `/api/vibe-sessions`,
  `/api/health`) : le frontend en dépend.
- Code et commentaires dans le style existant ; documentation en français.
- Recherche dans le code : `rg` (ripgrep), pas `grep -r` / `find -name`.

## Vérifier un changement

```bash
npm start &                                         # ou ./run.sh --no-browser
curl -s localhost:3417/api/health
curl -s localhost:3417/api/sessions | python3 -m json.tool | head -n 60
curl -s 'localhost:3417/api/opencode-sessions?limit=5' | python3 -m json.tool | head
curl -s 'localhost:3417/api/vibe-sessions?limit=5' | python3 -m json.tool | head
./stop.sh
```

Pas de suite de tests automatisés pour l'instant : vérifier les endpoints et l'UI à la main.

## Projets liés

- `opencode-stat-viewer` (Electron + SQLite) a inspiré la vue OpenCode.
