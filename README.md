# Agents Control Tower

Tour de contrôle locale, **en lecture seule**, pour visualiser en un coup d'œil les sessions
d'agents de code IA qui tournent sur ta machine :

- **Claude Code** — sessions actives (PID vivant), modèle, branche git, tokens, derniers messages ;
- **OpenCode** — sessions récentes, coût et tokens cumulés ;
- **Mistral Vibe** — sessions récentes et sessions en cours.

Une page web, un serveur Node.js natif, **zéro dépendance**.

> [!IMPORTANT]
> **Logiciel produit avec de la GenAI.** Le code et la documentation de ce projet ont été
> écrits avec l'assistance d'outils d'IA générative (Claude Code), sous la direction et la
> relecture d'un humain. Utilise-le en connaissance de cause.

> [!WARNING]
> **Linux uniquement pour le moment.** Le collecteur Claude Code lit `/proc/<pid>/status` et
> `/proc/<pid>/cwd`, et les scripts `run.sh` / `stop.sh` s'appuient sur des outils Linux
> (`xdg-open`, `ss`, `fuser`, `lsof`). macOS et Windows ne sont pas supportés.

## Prérequis

- Linux
- Node.js ≥ 18
- Optionnel : la CLI `opencode` dans le `PATH` (onglet OpenCode)
- Optionnel : un répertoire `~/.vibe` (onglet Mistral Vibe, surchargeable via `VIBE_HOME`)

## Lancer

```bash
./run.sh                 # démarre le serveur en arrière-plan et ouvre le navigateur
./run.sh --no-browser    # démarre sans ouvrir de navigateur
./stop.sh                # arrête le serveur

# ou au premier plan
npm start                # → http://localhost:3417
PORT=3418 npm start      # autre port
npm run dev              # node --watch
```

Le serveur n'écoute que sur `127.0.0.1`.

## Ce qui est affiché

Pour chaque session Claude Code active :

- projet (`cwd`), PID, nom, statut (`busy` / `idle`), version, entrypoint ;
- modèle (dernier `message.model` du transcript) et branche git ;
- âge de la session, inactivité, mémoire RSS ;
- nombre de messages user ⇄ assistant, `tool_use`, `thinking` ;
- tokens `input / output / cacheRead / cacheCreate` ;
- aperçu du dernier message user et assistant.

Plus des KPI globaux, un auto-refresh (2 s → 30 s ou désactivé), un filtre texte et l'option
« masquer observer-sessions » (sessions techniques de `claude-mem`).

## Sources de données

| Onglet | Source | Collecteur |
|--------|--------|------------|
| Claude Code | `~/.claude/sessions/*.json` (PID vivant) + `~/.claude/projects/<projet>/<sessionId>.jsonl` + `/proc` | `collector.js` |
| OpenCode | `opencode db` (SQLite `~/.local/share/opencode/opencode.db`) + `ps` | `collector-opencode.js` |
| Mistral Vibe | `~/.vibe/logs/session/**/meta.json` + `active/*.lock` | `collector-vibe.js` |

## Architecture

```
~/.claude/**  + /proc ──► collector.js          ─┐
opencode db   + ps    ──► collector-opencode.js ─┼─► server.js (http natif) ──► public/ (HTML/CSS/JS vanilla)
~/.vibe/logs/**       ──► collector-vibe.js     ─┘
```

API JSON :

- `GET /api/sessions` — sessions Claude Code actives
- `GET /api/opencode-sessions?limit=50` — sessions OpenCode (limit 1..200)
- `GET /api/vibe-sessions?limit=50` — sessions Mistral Vibe (limit 1..200)
- `GET /api/health` — `{ ok, version }`

## Limites connues

- **Visualisation seule** : aucune action sur les sessions (pas de kill, pas d'injection de message).
- Tokens Claude Code = somme brute des `usage` du transcript, sans coût en $.
- Transcript > 5 Mo : tokens estimés depuis les 300 derniers Ko (`isTailSampled`).
- Rafraîchissement par polling HTTP, pas de push temps réel.
- Les formats de stockage de Claude Code, OpenCode et Vibe ne sont pas des API publiques :
  une mise à jour de ces outils peut casser un collecteur.

## Pistes

- Statut busy/idle instantané (SSE) plutôt que polling.
- Graphe des tokens dans le temps, coût estimé par modèle.
- Vue détaillée d'une session (transcript paginé, timeline des outils).

## Licence

[MIT](LICENSE) © 2026 F.X. ROBIN — fourni « tel quel », sans aucune garantie.
