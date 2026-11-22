# Consommation d'eau (arrosage et eau potable)

Tableau de bord des deux compteurs d'eau (Adeunis Pulse V2, NB-IoT). **Orange Live Objects envoie les messages directement** au Worker Cloudflare de ce projet (HTTPS push), qui les stocke dans une base D1. TagoIO n'est plus nécessaire.

```
Compteur ──NB-IoT──▶ Live Objects ──HTTPS push──▶ Worker Cloudflare (/ingest) ──▶ base D1
                                                       │
                                  navigateur ◀─────────┘  tableau de bord, connexion de l'ASL
```

- **Cartes par compteur** : consommation du jour, d'hier, des 7 derniers jours, du mois et de l'année (avec comparaison au mois précédent et à N−1), index actuel, mini-courbe des 30 jours.
- **Graphique** : 24 h, semaine, mois (au choix **calendaires** ou **glissants** jusqu'au dernier relevé), 90 jours, 12 mois, années. Côte à côte ou empilé, filtre par compteur, vue en tableau.
- **Profil horaire** : moyenne par jour de la semaine et par tranche de 2 h. Une fuite se voit en cases colorées la nuit.
- **Alertes** (calculées à l'affichage, réglables par compteur) : seuil journalier ou mensuel, débit moyen trop élevé, fuite (eau qui coule sans interruption depuis N heures), jour anormal (× la médiane), plus aucun relevé depuis N heures, index qui recule.

Les consommations viennent des différences d'index, réparties au prorata du temps : un relevé à 13 h 07 ne fausse donc pas les totaux d'un jour, d'un mois ou d'une année.

> Les alertes de ce tableau de bord s'affichent à l'écran. Il n'envoie pas d'e-mail ni de SMS : si vous les utilisiez dans TagoIO, il faudra une autre solution (dites-le, cela peut s'ajouter au Worker).

## Ce que le Worker reconnaît

Le décodage reprend celui de votre ancien parseur TagoIO : le message Live Objects contient `genericSensor`, et

| Dans le message | Variable stockée | Valeur |
|---|---|---|
| `genericSensor["0"].sensorValue` | `index_eau_1` (eau potable) | index en litres |
| `genericSensor["1"].sensorValue` | `index_eau_2` (arrosage) | index en litres |

Le message peut être l'objet Live Objects lui-même, ou sa version texte JSON dans un champ `value` (comme dans votre parseur). Le format TagoIO (`[{"variable":…,"value":…,"time":…}]`) et les messages dont l'objet `value` contient des champs numériques sont aussi acceptés. L'heure est celle du message (`timestamp`, `time` ou `created`), à défaut l'heure de réception. Les messages rejoués par Live Objects sont ignorés (pas de doublons).

Les variables associées à chaque compteur se changent dans Réglages.

## Connexion et rôles

Il n'y a plus de mot de passe propre à ce site : **on se connecte avec son compte de l'ASL**, et un coloti déjà connecté à l'ASL arrive ici sans rien saisir.

| | Colotis | Bureau |
|---|---|---|
| Voir les consommations, graphiques, alertes | oui | oui |
| Modifier les réglages (seuils, noms, variables) | non | oui |
| Ajouter, corriger, supprimer un relevé | non | oui |
| Diagnostic (messages bruts, variables reçues) | non | oui |

Les réglages sont **communs à tous** (enregistrés sur le serveur, modifiables par le bureau).

Fonctionnement : une visite sans session renvoie vers l'ASL (`/sso/eau`), qui renvoie ici avec un jeton signé de 60 secondes (identité et rôle, usage unique) ; le site ouvre alors une session de **12 heures**. Les comptes, les mots de passe et les désactivations restent gérés dans l'ASL : un compte désactivé perd l'accès à l'expiration de sa session ici, au plus tard 12 h après. Le bureau place le lien du site dans l'ASL (Paramètres → « Lien du suivi de la consommation d'eau »).

La signature utilise un secret `SSO_SECRET` **identique dans l'ASL et ici**. Sans lui, le site refuse tout (503).

## Mise en route (hébergement gratuit Cloudflare)

> **État actuel** : le Worker est déployé sur `https://eau.pierrotcolombine.workers.dev`, avec sa base D1 `eau` (identifiant déjà inscrit dans `wrangler.jsonc`) et ses deux secrets. Les étapes ci-dessous servent à le refaire à l'identique, ou à changer un secret (`npx wrangler secret put INGEST_KEY`).

Prérequis : Node.js et le compte Cloudflare gratuit déjà utilisé pour l'ASL. Dans le dossier du projet :

```bash
npm install
npx wrangler login
```

Créez la base en Europe, puis copiez le `database_id` affiché dans `wrangler.jsonc` (à la place de `REMPLACER-PAR-LID-AFFICHE-PAR-wrangler-d1-create`) :

```bash
npx wrangler d1 create eau --location weur
npm run db:remote
```

Générez une clé pour Live Objects et le secret de connexion unique, puis enregistrez-les (la commande demande de coller la valeur). Le secret `SSO_SECRET` doit être **le même** que celui enregistré dans l'ASL (`npx wrangler secret put SSO_SECRET` dans le dossier de l'ASL) :

```bash
openssl rand -hex 24                       # clé pour Live Objects ; notez-la
openssl rand -hex 32                       # secret de connexion unique, à mettre aussi dans l'ASL
npx wrangler secret put INGEST_KEY
npx wrangler secret put SSO_SECRET
npm run db:remote
npm run deploy
```

L'adresse est du type `https://eau.<votre-sous-domaine>.workers.dev` ; celle de l'ASL se règle dans `wrangler.jsonc` (`ASL_URL`). Sans ces deux secrets, le Worker refuse tout (503) : rien n'est jamais ouvert par oubli.

### Côté Live Objects

Dans la politique d'action HTTPS push que vous aviez pour TagoIO, ou dans une nouvelle :

- **URL** : `https://eau.<votre-sous-domaine>.workers.dev/ingest`
- **En-tête** : `Device-Token: <la clé INGEST_KEY>` (`Authorization: <clé>`, `Authorization: Bearer <clé>` et `X-Api-Key: <clé>` marchent aussi)
- **Corps** : laissez celui que vous envoyiez à TagoIO.

Pendant quelques jours, vous pouvez garder l'action TagoIO **et** ajouter la nouvelle : Live Objects envoie alors chaque message aux deux. Quand les chiffres concordent, supprimez l'ancienne.

Un message que le Worker ne comprend pas reçoit une réponse **422**, que Live Objects compte comme une erreur d'envoi : c'est le signe que le format est à ajuster. Ouvrez alors **Réglages → Variables et derniers messages reçus** : le dernier message brut reçu y est affiché tel quel.

### Reprendre l'historique de TagoIO (facultatif)

Pour garder vos courbes et les comparaisons avec l'an dernier, exportez les données de TagoIO (JSON ou CSV avec les colonnes `variable`, `value`, `time`), puis :

```bash
node scripts/import.mjs export.json https://eau.<votre-sous-domaine>.workers.dev <INGEST_KEY>
```

Cela peut être relancé sans risque : les relevés déjà présents sont ignorés. Vos variables TagoIO s'appelaient `index_eau_1` et `index_eau_2`, comme ici.

### Mise à jour automatique à chaque `git push` (facultatif)

Dans Cloudflare : Workers & Pages → Create → Import a repository → ce dépôt. Commande de déploiement : `npx wrangler deploy`. Les secrets se définissent dans Settings → Variables and Secrets du Worker.

## Sans Cloudflare : aperçu seul

Servez le dossier `public/` avec n'importe quel hébergement statique (`python3 -m http.server -d public`) : la page affiche des **données de démonstration**. Ajoutez `?demo` à l'adresse pour forcer la démonstration même avec le Worker.

## Développement

```bash
npm test                         # calculs et décodage des messages
printf 'SSO_SECRET=secret-de-test\nINGEST_KEY=cle\nASL_URL=http://localhost:8791\n' > .dev.vars   # + l'ASL en local pour se connecter
npm run db:local && npm run dev  # Worker et base locale sur http://localhost:8787
curl -X POST localhost:8787/ingest -H 'Device-Token: cle' \
  -d '{"timestamp":"2026-11-22T10:00:00Z","value":{"genericSensor":{"0":{"sensorValue":1000},"1":{"sensorValue":2000}}}}'
```

| Fichier | Rôle |
|---|---|
| `src/worker.js` | réception `/ingest`, API (lecture pour tous, écriture pour le bureau), session, service des fichiers de `public/` |
| `src/auth.js` | jetons signés de la connexion unique et session |
| `src/ingest.js` | extraction des mesures d'un message (Adeunis `genericSensor`, TagoIO, Live Objects) |
| `migrations/` | schéma de la base D1 |
| `public/lib.js` | calculs purs : intervalles, répartition par période, alertes, profil horaire |
| `public/app.js` | interface : cartes, graphiques, réglages |
| `public/demo.js` | données de démonstration |
| `public/vendor/chart.umd.js` | Chart.js 4.4.1 (copié, aucun CDN) |
| `scripts/build-assets.mjs` | intègre `public/` dans le Worker (`src/assets.js`, généré, lancé par `wrangler dev` et `wrangler deploy`) |
| `scripts/import.mjs` | reprise d'un historique JSON ou CSV |

Les jours, mois et années suivent l'heure locale du navigateur.
