# Uncbox Auction House

Uncbox's own take on the auction house addons guilds use for the open market: Auctionator's easy
scanning and shopping, and TradeSkillMaster's market values, posting rules, groups, crafting costs
and accounting. It is made for WoW Forever (Interface 16001) and also loads in Classic Era.

It has two halves that share files:

- **The UncboxAH addon** (`addon/UncboxAH/`) scans the auction house, reads your mail and bags, and
  gives you a tab on the auction house window to post, cancel and shop. It saves everything to
  `UncboxAHDB` (WoW writes it when you `/reload` or log out).
- **Uncbox** reads that file into a database (`data/wow-ah.db`), works out prices, and writes
  `UncboxAHData.lua` into the addon folder: prices, your rules (already worked out to copper per
  item), shopping lists and deal watches. The addon loads it on `/reload`.

WoW addons can't read files or go online while you play. That is why it works in rounds.

## The /reload rhythm

1. At the auction house, run a **full scan** (`/uah scan` or the Full scan button). Don't close the
   window until it says it finished.
2. `/reload` (or log out). WoW saves `UncboxAH.lua`; Uncbox notices within a few seconds, ingests
   it, and rewrites `UncboxAHData.lua`.
3. `/reload` again when you want the new prices in tooltips and posting. The first `/reload` after
   installing has no prices yet, so scan once, `/reload`, then `/reload` again.

Install the addon from the WoW preset (**Install addon** installs everything under `addon/`).
Updating? Install again. Uncbox puts the data file back within a minute.

## What the addon does

**Scanning.** A full scan uses the game's "get all" query, which the game allows every 15 minutes
(the Full scan button and `/uah status` count down). The listings are read a few hundred per frame,
so the game doesn't freeze, and boiled down per item: cheapest buyout, total quantity, number of
auctions and the cheapest price points, with your own auctions marked. Searches (for a shopping
list, "Check prices" or the cancel scan) ask for one item name at a time and keep the listings:
price, count, seller, time left. The file keeps the latest 3 full scans and per-item daily numbers;
Uncbox keeps all of them.

**Accounting.** Reads your auction mail using the game's own text (so it works in any language):
sales (price, the AH's cut, the deposit, the buyer), purchases, expired and cancelled auctions,
outbids. Every post and buy you make is noted too. Gold per character is saved over time. Open
your mailbox to have the mail read; each mail is counted once.

**Bags and professions.** Bags and bank, so "what can I sell" works. Every recipe when you open a
profession window (collapsed headers are opened and closed again). The price vendors charge for
items they always stock, so crafting costs use them.

**Tooltips.** Market Value, Min Buyout, Your Avg Sale, Sale Rate and Vendor on every item, with
the total for the stack under your cursor. `/uah tooltip` turns them off.

**The Uncbox tab** (next to Browse, Bids and Auctions):

- **Post.** Pick an item in your bags. Uncbox suggests a price from its posting rule: undercut the
  lowest other seller by the rule's amount, never below the minimum price (if undercutting would,
  it posts the normal price instead), never above the maximum, and matching your own lowest auction
  rather than undercutting yourself. "Check prices" looks the item up first. Stack size, number of
  stacks and duration come from the rule. **Post** posts one stack per click, because the game only
  lets a real click post.
- **Cancel.** "Scan my auctions" finds the ones someone has undercut (and that are worth reposting:
  not when matching would go below your minimum). **Cancel next** cancels one per click.
- **Shopping.** One button per shopping list, plus **Deals**. Results are listings under your max
  price, or under a share of market value, best first. Clicking a result buys it; if the window no
  longer shows that listing, it looks the page up again and asks for a second click.

**Slash commands**

| Command | Does |
| --- | --- |
| `/uah scan` | Full scan |
| `/uah post` | Open the Post tab |
| `/uah cancel` | Open the Cancel tab and look for undercut auctions |
| `/uah shop [n]` | Run shopping list *n*, or the deals search |
| `/uah status` | How old the scan and prices are |
| `/uah tooltip` | Tooltip prices on or off |
| `/uah layout auto\|new\|old` | If scans do nothing: how searches are sent to the game |

The game's `QueryAuctionItems` takes its arguments in different orders in different versions.
The addon guesses from the client (`auto`); `old` is the 11-argument form, `new` the 9-argument one.

## What Uncbox works out

- **Market value.** Per scan, the cheapest slice of what's listed (30% of a thin market, down to 15%
  of a deep one), stopping at the first price more than 1.5 times the one below it, averaged by
  quantity. Scans of the last 14 days are then blended, a day's weight halving every 3 days, so
  today counts most.
- **Min buyout** from the latest scan (an item that has dropped out of the newest full scan has
  none), **historical** (average daily min buyout over 60 days), **volatility** (standard deviation
  over the mean of the daily min buyouts), **sale rate** (sold ÷ sold + expired + cancelled) and
  **average sale** from your own accounting.
- **Rules**, like TSM operations. A posting operation has min, normal and max price formulas, undercut,
  stack size, stacks, duration (12, 24 or 48 hours) and quantity to keep. A shopping operation has a
  max price formula and a minimum sale rate. A group is a list of items with one of each.
  Items you carry that are in no group use the default operations. Formulas:

  ```
  max(vendorsell, 85% dbmarket)     first(dbmarket, dbminbuyout, 2g50s)     dbminbuyout - 1s
  ```

  Prices: `dbmarket`, `dbminbuyout`, `dbhistorical`, `avgsell`, `vendorsell`, `crafting`. Functions:
  `min`, `max`, `first` (the first price that exists), `avg`, `round`, `floor`, `ceil`, `abs`. Numbers,
  money like `1g50s`, percentages (`90% dbmarket` multiplies), `+ - * /` and brackets. A price with no
  data makes the formula invalid for that item (the addon then has nothing to post at), unless
  `first(...)` covers it. Formulas are parsed by Uncbox itself and never executed as code.
- **Analyses**: deals (listings under X% of market), flips (buy now, resell at market minus the AH's 5%
  cut, and the deposit), vendor flips, crafting profit per recipe, what to sell, undercut alerts,
  accounting totals and gold over time. At a neutral auction house (Booty Bay, Gadgetzan, Everlook,
  Ratchet) prices are kept apart and the cut is 15%.

## Where the files are

| File | What it is |
| --- | --- |
| `WTF\Account\<account>\SavedVariables\UncboxAH.lua` | What the addon saved (WoW writes it) |
| `Interface\AddOns\UncboxAH\UncboxAHData.lua` | Prices and rules Uncbox writes for the addon |
| `data\wow-ah.db` | Uncbox's database (needs a Node with `node:sqlite`, 22.5 or newer) |
| `data\wow-ah.json` | Your groups, operations, shopping lists and deal settings |

Uncbox prefers WoW Forever (`_classic_beta_`), then Classic Era, unless a different flavor is the one
that has saved data.

## Compared with the others

| | Auctionator | TradeSkillMaster | Uncbox Auction House |
| --- | --- | --- | --- |
| Full scan, shopping lists | yes | yes | yes |
| Market value from history | basic | yes | yes (TSM-style) |
| Posting rules with formulas, groups | no | yes | yes (same ideas, a smaller language) |
| Accounting, sale rate | no | yes | yes |
| Crafting costs and profit | no | yes | yes (recipes from your professions) |
| Desktop companion | no | yes (subscription) | yes (Uncbox itself, free) |
| Auction queue, one click per action | one at a time | one at a time | one at a time |
| Needs libraries, login | no | account | no |

It does not post or buy by itself (the game doesn't allow that), has no auto-mail, mass destroying,
or region-wide data, and it can't tell soulbound items in your bags from ones you can sell. Items in
the "what to sell" list are the ones with a price.

## For the dashboard widget

The widget talks to `/api/wow/ah/*` (local only; documented at the top of `server/wowah.mjs`),
and hears the `wowah` server event whenever new data was ingested. Money is copper everywhere;
`src/money.ts` has `formatMoney` / `parseMoney` for "12g 34s 56c".
