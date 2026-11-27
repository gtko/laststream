# Abonnement de soutien (laststream.app)

Le code de Laststream est public : chacun peut l'installer sur son serveur, gratuitement et sans limite. Le service en
ligne (app.laststream.app) est financé par un **abonnement de soutien à 24 € par an** (2 € par mois), payé par Stripe.
L'abonnement paie le service (comptes, synchronisation, apps, serveurs). Laststream ne fournit ni n'installe aucune
extension Stremio : chaque compte ajoute lui-même ses sources.

Un abonnement qui donne accès à un service est une vente, pas un don : Stripe émet une facture, et la TVA se calcule
selon le pays du client (`STRIPE_AUTOMATIC_TAX=1` pour Stripe Tax). Des CGV sont à publier avant le passage en réel.

## Qui a accès

`accessReason()` (`src/billing/access.ts`) est la seule règle :

| Raison | Condition |
| --- | --- |
| `disabled` | Stripe non configuré (serveur auto-hébergé) : tout le monde a accès. |
| `owner` | Compte propriétaire du serveur. |
| `paid` | Abonnement Stripe `active`, `trialing` ou `past_due`, période en cours (plus 3 jours de grâce). |
| `comp` | Accès offert en cours (récompense de parrainage). |
| `free` | Avant `LASTADDON_BILLING_FREE_UNTIL` (période de lancement). |
| `null` | Pas d'accès : `402 subscription_required`. |

Le contrôle se fait dans `sessionOf()` (`src/user/session.ts`) : toute route qui ouvre une session est fermée sans
accès, sauf la connexion, le compte et `/user/billing*` (voir `isAccessExempt`). Les sessions verrouillées sur un profil
invité du foyer suivent l'abonnement du compte hôte. Limite connue : les routes `lt` et de flux s'authentifient par la
configuration chiffrée et non par la session ; un client qui garde une ancienne configuration en cache peut encore s'en
servir. L'app, elle, ne démarre pas sans accès.

## Deux tarifs

- **Soutenir** : le prix `STRIPE_PRICE_ID` (24 € par an).
- **Soutenir, J'adore** : la personne choisit son montant annuel, au moins le prix de base, sans autre plafond que la
  limite de Stripe (999 999,99 €). `POST /user/billing/checkout` reçoit `{ "amount": <centimes> }` ; Checkout crée alors
  un prix (`price_data`) sur le **produit** du prix de base, renouvelé chaque année au même montant. Un montant égal au
  prix de base revient au tarif « Soutenir ». La remise du filleul (moitié prix) ne vaut que pour le tarif de base. Le
  tarif choisi est noté dans `metadata.tier` (`standard` ou `jadore`). Pour changer de montant : résilier puis reprendre
  un abonnement à la fin de la période.

## Parcours

1. L'app reçoit `402` au chargement des profils et affiche « Activer ton accès » (`apps/web/src/ui/subscribe-ui.js`).
2. `POST /user/billing/checkout` ouvre une session Stripe Checkout (abonnement annuel, compte dans `client_reference_id`
   et `metadata.account_id`). Si le compte a déjà un accès offert ou la période de lancement, le premier prélèvement
   attend sa fin (`subscription_data.trial_end`).
3. Stripe appelle `POST /billing/stripe/webhook`. La signature est vérifiée, chaque événement n'est traité qu'une fois
   (`billing_events`), et l'abonnement est toujours relu chez Stripe avant d'être enregistré (table `billing`).
4. `POST /user/billing/portal` ouvre le portail client Stripe (carte, factures).

## Résiliation

- Dans l'app (Réglages, carte « Abonnement de soutien ») : « Résilier » puis « Confirmer la résiliation » appelle
  `POST /user/billing/cancel` (`cancel_at_period_end` chez Stripe). Plus rien n'est prélevé, l'accès reste ouvert jusqu'à
  la fin de la période payée, puis l'app affiche « Activer ton accès ». Les profils et la bibliothèque sont gardés.
- Jusqu'à cette date, « Reprendre mon abonnement » (`POST /user/billing/resume`) annule la résiliation.
- Le portail Stripe permet aussi de résilier (à activer dans ses réglages) ; le webhook garde l'état à jour.
- Supprimer son compte arrête l'abonnement tout de suite chez Stripe. Si Stripe ne répond pas, la suppression est
  refusée (`502`) plutôt que de laisser un abonnement payant sans compte.

## Service en ligne seulement

Tout ce qui touche à l'abonnement est inactif sur un serveur auto-hébergé, c'est-à-dire tant que `STRIPE_SECRET_KEY` et
`STRIPE_PRICE_ID` ne sont pas définis :

- aucun contrôle d'accès (`accessReason` répond `disabled`), aucune route Stripe (`/user/billing/*` répond
  `404 billing_disabled`, sauf `GET /user/billing` qui répond `enabled: false`) ;
- l'app n'affiche ni l'écran « Activer ton accès » ni la carte « Abonnement de soutien » ;
- le parrainage reste celui du serveur (quota de billets réglé dans /admin), sans remise ni mois offerts.

La règle « 2 billets par compte » du service en ligne se règle dans /admin (quota par défaut). La migration 36 ne touche
plus aux quotas ; les serveurs mis à jour en v1.0.77 ont pu passer de 4 à 2 billets et peuvent remonter le réglage dans
/admin.

Événements à cocher sur le webhook : `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`.

## Parrainage

- Chaque compte a **2 billets** sur le service en ligne (quota par défaut réglé dans /admin).
- Le **filleul** paie sa première année à moitié prix : coupon `STRIPE_REFERRAL_COUPON_ID` appliqué au Checkout tant
  qu'il n'a jamais payé. Créer ce coupon à **50 %, `duration=repeating`, `duration_in_months=12`** : un coupon `once`
  serait consommé par la facture à 0 € d'une période d'essai.
- Le **parrain** gagne 6 mois au **premier paiement non nul** de chaque filleul (`invoice.paid`), une seule fois par
  filleul (`referral_rewards`). Abonné en cours : sa prochaine échéance Stripe est repoussée de 6 mois (`trial_end`,
  sans prorata). Sinon : 6 mois d'accès offert (`comp_until`), et un abonnement pris ensuite ne prélève qu'à la fin.

## Mise en route (mode test d'abord)

1. Stripe (mode test) : produit « Laststream en ligne », prix récurrent annuel 24 EUR, coupon filleul (ci-dessus),
   portail client activé (mise à jour de carte et factures ; résiliation en fin de période si voulue).
2. Webhook vers `https://app.laststream.app/billing/stripe/webhook` avec les événements ci-dessus.
3. Secrets du Worker : `wrangler secret put STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` ; variables : `STRIPE_PRICE_ID`,
   `STRIPE_REFERRAL_COUPON_ID`, et si voulu `LASTADDON_BILLING_FREE_UNTIL` (période offerte aux comptes existants).
4. Tester avec la carte `4242 4242 4242 4242`, puis refaire les étapes 1 à 3 en mode réel.
