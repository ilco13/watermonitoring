# Consommation d'eau (arrosage et eau potable)

Tableau de bord des deux compteurs d'eau (Adeunis Pulse V2, NB-IoT, Orange Live Objects) dont les index arrivent dans TagoIO toutes les 2 h.

- **Cartes par compteur** : consommation du jour, d'hier, des 7 derniers jours, du mois et de l'année (avec comparaison au mois précédent et à N−1), index actuel, mini-courbe des 30 jours.
- **Graphique** : 48 h (par tranche de 2 h), 30 jours, 90 jours, 12 mois, années. Côte à côte ou empilé, un compteur ou les deux, affichage en tableau.
- **Profil horaire** : moyenne par jour de la semaine et par tranche de 2 h. Une fuite se voit en cases colorées la nuit.
- **Alertes** (calculées à l'affichage, réglables par compteur) : seuil journalier ou mensuel, débit moyen trop élevé, fuite (eau qui coule sans interruption depuis N heures), jour anormal (× la médiane), plus aucun relevé depuis N heures, index qui recule.

Les consommations viennent des différences d'index, réparties au prorata du temps : un relevé à 13 h 07 ne fausse donc pas les totaux d'un jour, d'un mois ou d'une année.

> Les alertes de ce tableau de bord s'affichent à l'écran. Les alertes par e-mail ou SMS restent celles de TagoIO, que vous pouvez garder.

## Hébergement gratuit sur Cloudflare

Même principe que l'application de l'ASL : un Worker Cloudflare (offre gratuite) qui sert la page et relaie les lectures vers TagoIO. Le **token TagoIO reste un secret Cloudflare**, il n'est jamais envoyé au navigateur, et l'accès est protégé par un **mot de passe**. Sans mot de passe configuré, le Worker répond 503 à tout : rien n'est jamais public par oubli.

Prérequis : Node.js et le compte Cloudflare gratuit déjà utilisé pour l'ASL. Dans le dossier du projet :

```bash
npm install
npx wrangler login
```

Dans TagoIO, créez un **Device-Token en lecture seule** pour le device du compteur (Devices → votre device → Tokens), puis enregistrez les deux secrets (la commande demande de coller la valeur) :

```bash
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put TAGO_TOKEN
```

Publiez :

```bash
npm run deploy
```

L'adresse est du type `https://eau-maison.<votre-sous-domaine>.workers.dev` (le nom vient de `wrangler.jsonc`). Le navigateur demande un identifiant (au choix) et le mot de passe.

Première ouverture : **Réglages → Lister les variables reçues** affiche les variables présentes dans TagoIO. Indiquez celle de chaque compteur et le nombre de **litres par unité d'index** (1000 si l'index est en m³, 1 s'il est en litres, 10 si une impulsion vaut 10 L). Les réglages (variables, seuils) sont mémorisés dans le navigateur.

> Les variables par défaut (`index_1` pour l'arrosage, `index_2` pour l'eau potable) sont des suppositions. Corrigez-les dans les Réglages.

### Mise à jour automatique à chaque `git push` (facultatif)

Dans Cloudflare : Workers & Pages → Create → Import a repository → ce dépôt. Commande de build : aucune, commande de déploiement : `npx wrangler deploy`. Les secrets se définissent dans Settings → Variables and Secrets du Worker.

### Protection renforcée (facultatif)

Pour un vrai compte (code reçu par e-mail) plutôt qu'un mot de passe partagé, activez Cloudflare Access (gratuit jusqu'à 50 personnes) sur le Worker. Le mot de passe reste alors en seconde barrière.

## Sans Cloudflare : page seule

Servez le dossier `public/` avec n'importe quel hébergement statique (ou `python3 -m http.server -d public`). Sans Worker, la page affiche des **données de démonstration** tant qu'aucun token n'est saisi. Dans Réglages, vous pouvez alors saisir l'URL de l'API et un Device-Token : ils restent dans ce navigateur (stockage local). Ce mode appelle TagoIO directement depuis le navigateur, donc à réserver à un poste personnel. Ajoutez `?demo` à l'adresse pour forcer la démonstration.

## Développement

```bash
npm test            # calculs (public/lib.js), vérifiés dans plusieurs fuseaux horaires
npm run dev         # Worker en local ; créer .dev.vars avec DASHBOARD_PASSWORD et TAGO_TOKEN
```

| Fichier | Rôle |
|---|---|
| `src/worker.js` | mot de passe, relais `/api/data` vers TagoIO, fichiers statiques |
| `public/lib.js` | calculs purs : intervalles, répartition par période, alertes, profil horaire |
| `public/app.js` | interface : cartes, graphiques, réglages |
| `public/demo.js` | données de démonstration |
| `public/vendor/chart.umd.js` | Chart.js 4.4.1 (copié, aucun CDN) |

Calendrier et fuseau : les jours, mois et années suivent l'heure locale du navigateur.
