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
- Optionnel : la status line [`claude-statusbar`](https://pypi.org/project/claude-statusbar/) pour les jauges de quota

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

- **ce qui demande ton attention** : bord rouge « ⏳ t'attend » quand Claude Code signale
  lui-même un blocage (`status: waiting` + `waitingFor` : dialogue ou permission ouvert,
  réponse attendue, accès réseau sandbox…), bord violet « ❓ question pour toi » quand la
  session est idle et que la dernière réponse de l'IA se termine par une question. Ces
  sessions remontent en tête, et leur nombre s'affiche dans le titre de l'onglet : `(2) Agents…` ;
- badge **📡 remote control** quand la session est pilotable depuis claude.ai ;
- **jauge de contexte** : tokens du dernier appel au modèle rapportés à la fenêtre (200k ou 1M).
  La taille est exacte quand la status line l'a fournie pour la session, déduite sinon
  (préfixe `~`) ;
- projet (`cwd`), PID, nom, statut, version, entrypoint, modèle et branche git ;
- âge de la session, inactivité, mémoire RSS ;
- nombre de messages user ⇄ assistant, `tool_use`, `thinking`, et tokens cumulés ;
- fil de discussion : dernier message humain et dernière réponse de l'IA, avec avatars.

Au-dessus des cartes, des KPI globaux, dont le **quota claude.ai** sur les fenêtres de 5 h et de
7 jours :

- pourcentage utilisé, jauge verte / orange ≥ 70 % / rouge ≥ 90 %, heure de réinitialisation ;
- mini-courbe de la fenêtre en cours (diagonale pointillée = rythme régulier) ;
- **prévision** au rythme récent (30 min pour la fenêtre 5 h, 24 h pour la fenêtre 7 jours) :
  pourcentage atteint au reset, ou « ⚠ épuisé vers 16:55 » si le quota sera dépassé avant.

Auto-refresh (2 s → 30 s ou désactivé), filtre texte et option « masquer observer-sessions »
(sessions techniques de `claude-mem`).

Les transcripts sont lus une fois en entier, puis de façon incrémentale : chaque
rafraîchissement ne parse que les lignes ajoutées depuis le précédent.

## Sources de données

| Onglet | Source | Collecteur |
|--------|--------|------------|
| Claude Code | `~/.claude/sessions/*.json` (PID vivant) + `~/.claude/projects/<projet>/<sessionId>.jsonl` + `/proc` | `collector.js` |
| OpenCode | `opencode db` (SQLite `~/.local/share/opencode/opencode.db`) + `ps` | `collector-opencode.js` |
| Mistral Vibe | `~/.vibe/logs/session/**/meta.json` + `active/*.lock` | `collector-vibe.js` |
| Quota 5 h / 7 j | `~/.cache/claude-statusbar/last_stdin.json` (`rate_limits`), sinon `rate_latest.*.json` ; historique `rate_projection.*.json` | `collector-quota.js` |

Claude Code ne transmet `rate_limits` qu'au script de status line et ne l'écrit nulle part :
les jauges relisent donc le cache de `claude-statusbar` (chemin surchargeable via
`CLAUDE_STATUSBAR_CACHE`). Sans cette status line, les tuiles affichent « — ». Les valeurs
datent du dernier rafraîchissement de la status line d'une session ouverte : au-delà de 10 min,
la tuile indique l'âge du relevé.

## Architecture

```
~/.claude/**  + /proc ──► collector.js          ─┐
opencode db   + ps    ──► collector-opencode.js ─┼─► server.js (http natif) ──► public/ (HTML/CSS/JS vanilla)
~/.vibe/logs/**       ──► collector-vibe.js     ─┘
```

API JSON :

- `GET /api/sessions` — sessions Claude Code actives + `quota` (fenêtres 5 h / 7 j)
- `GET /api/opencode-sessions?limit=50` — sessions OpenCode (limit 1..200)
- `GET /api/vibe-sessions?limit=50` — sessions Mistral Vibe (limit 1..200)
- `GET /api/health` — `{ ok, version }`

## Limites connues

- **Visualisation seule** : aucune action sur les sessions (pas de kill, pas d'injection de message).
- Tokens Claude Code = somme brute des `usage` du transcript, sans coût en $.
- Rafraîchissement par polling HTTP, pas de push temps réel.
- Les formats de stockage de Claude Code, OpenCode et Vibe ne sont pas des API publiques :
  une mise à jour de ces outils peut casser un collecteur.

## Pistes

- Statut busy/idle instantané (SSE) plutôt que polling.
- Graphe des tokens dans le temps, coût estimé par modèle.
- Vue détaillée d'une session (transcript paginé, timeline des outils).

## Licence

[MIT](LICENSE) © 2026 François-Xavier Robin — fourni « tel quel », sans aucune garantie.
