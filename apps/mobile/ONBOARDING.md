# Onboarding and first deposit

The goal of onboarding is one event: **a new user's first deposit**. A funded wallet is when
Honey becomes useful, and it is the best early sign that someone stays. Everything before the
wallet exists is kept as short as possible. Everything after it pushes towards funding, then
towards finishing setup.

Code: `lib/onboarding.ts` (state and copy), `app/(onboarding)/welcome.tsx`,
`app/(account)/get-started.tsx`, `components/home/ActivationCard.tsx`, `app/(account)/setup.tsx`.

## Where users drop off (benchmarks)

Honey has no analytics yet, so these figures are published benchmarks, not our own. Most crypto
figures come from the vendors themselves and none are audited.

| Finding | Number | Source |
| --- | --- | --- |
| Seed-phrase screens lose people | Ronin's old flow had T&Cs, disclaimers and 3–4 seed-phrase pages: about 80% got through the phrase step and 75% finished. Once social login was offered, more than 50% of new users chose it. | [Web3Auth × Ronin](https://blog.web3auth.io/the-story-of-web3auth-x-ronin-wallet-integration/) |
| Wallet onboarding overall | About 70% of users are lost during wallet onboarding, much of it at backup. Embedded login gives 30–40% higher completion (second-hand). | [925 Studios on Phantom](https://www.925studios.co/blog/phantom-wallet-design-breakdown) |
| Finance apps: install → activated | 21.4% of installs register and 12.9% activate. That's 15.9% on Android vs 6.5% on iOS. | [Liftoff 2022](https://content.liftoff.io/hubfs/2022/Reports/2022%20Mobile%20Finance%20Apps%20Report/2022%20Finance%20Apps%20Report%20-%20EN.pdf) |
| Long forms lose people | 68% have abandoned a financial sign-up: 21% over the time it took, 21% over the data asked for. | [Signicat 2022](https://www.signicat.com/press-releases/the-battle-to-onboard-2022) |
| Reward the deposit, not the sign-up | Robinhood moved its free stock from account approval to bank linking, and payback fell from about 13 months to under 5. | [Robinhood S-1](https://www.sec.gov/Archives/edgar/data/1783879/000162828021013318/robinhoods-1.htm) |
| A head start helps people finish | Loyalty cards with 2 of 10 stamps already filled were completed 34% of the time, vs 19% for blank cards of 8. | Nunes & Drèze 2006 |
| Checklists stay short | Average checklist completion is 19.2% (fintech 24.5%). Keep to 7 steps or fewer. | Userpilot 2024 |
| Apple Pay on-ramp | More than 25% higher on-ramp conversion and about 40% faster funding with Apple Pay and guest checkout. | [Coinbase × Moonshot](https://www.coinbase.com/fr/developer-platform/discover/case-studies/moonshot) |

Phantom, as the reference: the welcome screen offers Apple and Google up front, with "More
options" for creating or importing a recovery phrase or importing a private key. Social sign-up
asks for a PIN and a username, then Face ID and notifications are optional. The phrase stays
hidden and can be exported later. Funding happens on Home through Buy (card or Apple Pay) and
Receive.

## The flow

```
Opening animation → Welcome (honey looks around and blinks)
  ├─ Create a new wallet → Apple · Google · Email (code) → wallet, empty
  │                       └─ or: Create with a recovery phrase → write it down → wallet, empty
  └─ I already have a wallet → Apple · Google · Email → wallet, with its money
                              └─ or: Import a recovery phrase / private key → wallet, with its money

Home
  ├─ No money yet       → "Add money to get started": Apple Pay or card · Receive · From an exchange
  ├─ Money, setup open  → "Finish setting up, get $5 off network fees" (1/5 → 5/5)
  └─ Setup done         → nothing extra
```

What changed and why:

1. **One choice on the first screen.** The three-slide carousel is out of the flow; it's kept
   in `components/onboarding/WelcomeSlides.tsx`. Every screen before the wallet exists is a
   place to lose someone.
2. **Social and email first, the phrase second.** No password and no 12 words before there's
   anything to protect (Ronin, Phantom). The phrase is still one tap away for people who want
   full control.
3. **No name, photo or password at sign-up.** The password, name and avatar screens are kept but
   unlinked. The name comes from the email, and the photo moves into Finish setting up.
4. **An empty wallet's Home is about adding money.** No $0 chart, no change pill, no earn promo:
   just three ways to fund, with Apple Pay first.
5. **The reward comes once there's money.** The $5 network-fee credit is for finishing setup and
   only shows when the wallet holds money, so it can be spent straight away. The checklist opens
   with "Create your wallet" already ticked as a head start, and is 5 steps in all: create (done),
   back up, Face ID, notifications, name and photo. Apple and Google sign-ups, and phrase
   wallets, start with backup ticked too.

## What to measure

Once analytics exist, track each step as an event, split by iOS/Android and by sign-in method:

`welcome_viewed → path_chosen (create|restore) → method_chosen (apple|google|email|phrase|import)
→ wallet_created → home_empty_viewed → fund_method_tapped (buy|receive|exchange)
→ first_deposit (amount, method, minutes since wallet_created) → setup_step_done (step)
→ setup_completed → fee_credit_used`

Headline metrics:
- Share of `wallet_created` that reach `first_deposit` within 24 hours and within 7 days.
- Median time from `wallet_created` to `first_deposit`.

## Demo-only pieces (remove with real data)

- Apple and Google sign-in pause for about a second, then open the wallet. There's no real auth
  yet; that needs an embedded-wallet provider.
- On an empty wallet, opening Receive "receives" $25 after 6 seconds, and the first card purchase
  counts as the first deposit.
- A setup step counts as done as soon as it's opened.
- All state is in memory, so it resets on restart. A cold start goes to Welcome, and a deep link
  straight to `/home` shows the funded demo wallet.
