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

## Parcours

1. L'app reçoit `402` au chargement des profils et affiche « Activer ton accès » (`apps/web/src/ui/subscribe-ui.js`).
2. `POST /user/billing/checkout` ouvre une session Stripe Checkout (abonnement annuel, compte dans `client_reference_id`
   et `metadata.account_id`). Si le compte a déjà un accès offert ou la période de lancement, le premier prélèvement
   attend sa fin (`subscription_data.trial_end`).
3. Stripe appelle `POST /billing/stripe/webhook`. La signature est vérifiée, chaque événement n'est traité qu'une fois
   (`billing_events`), et l'abonnement est toujours relu chez Stripe avant d'être enregistré (table `billing`).
4. `POST /user/billing/portal` ouvre le portail client Stripe (carte, factures, résiliation).

Événements à cocher sur le webhook : `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`.

## Parrainage

- Chaque compte a **2 billets** (migration 36 : les quotas restés à 4 passent à 2 sur un serveur existant ; réglable
  dans /admin).
- Le **filleul** paie sa première année à moitié prix : coupon `STRIPE_REFERRAL_COUPON_ID` appliqué au Checkout tant
  qu'il n'a jamais payé. Créer ce coupon à **50 %, `duration=repeating`, `duration_in_months=12`** : un coupon `once`
  serait consommé par la facture à 0 € d'une période d'essai.
- Le **parrain** gagne 6 mois au **premier paiement non nul** de chaque filleul (`invoice.paid`), une seule fois par
  filleul (`referral_rewards`). Abonné en cours : sa prochaine échéance Stripe est repoussée de 6 mois (`trial_end`,
  sans prorata). Sinon : 6 mois d'accès offert (`comp_until`), et un abonnement pris ensuite ne prélève qu'à la fin.

## Mise en route (mode test d'abord)

1. Stripe (mode test) : produit « Laststream en ligne », prix récurrent annuel 24 EUR, coupon filleul (ci-dessus),
   portail client activé (résiliation et mise à jour de carte autorisées).
2. Webhook vers `https://app.laststream.app/billing/stripe/webhook` avec les événements ci-dessus.
3. Secrets du Worker : `wrangler secret put STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` ; variables : `STRIPE_PRICE_ID`,
   `STRIPE_REFERRAL_COUPON_ID`, et si voulu `LASTADDON_BILLING_FREE_UNTIL` (période offerte aux comptes existants).
4. Tester avec la carte `4242 4242 4242 4242`, puis refaire les étapes 1 à 3 en mode réel.
