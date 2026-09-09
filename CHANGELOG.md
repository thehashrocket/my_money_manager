# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.27.0] - 2026-09-09

### Fixed
- **A saved change can no longer be reported as a failure.** After the app saves something, it refreshes the page behind it. That refresh can fail on its own, and when it did, the app either told you the save had failed or showed an error page saying nothing had been written — while the change was already in the ledger. Two pages had been protected against this; six had not, across forty-seven places. All of them now report a save that landed as a save that landed, with a note saying the page may be showing you the state from before it. Three cases were worse than a stale page and are worth naming. Reconciling a card balance reported failure, and re-doing it — the obvious response — overwrote the app's single record of the previous balance with the figure the "failed" attempt had already stored, so the Undo on that account no longer led anywhere real. Importing a CSV showed "Nothing was written — a preview is read-only" after several hundred rows had been imported. And categorizing a merchant threw away the 10-second Undo for a write that may have just deleted one of your trained rules, while telling you the whole thing had failed.
- **The one-click reclassify that repairs "Left to Budget cannot be computed" was refused every time it was needed.** When no income categories exist, the budget page offers a banner to fix it by reclassifying the category your paychecks actually land in. Since v0.26.0 that action required a confirmation, and the banner never sent one — so it worked only on categories with no transactions in them, which are exactly the categories your paychecks are not in. The banner is the confirmation, and it now says so.
- **A hand-entered card charge can be removed.** Adding a charge to a credit card by hand was the only thing in the app with no way back: no delete, no edit, no undo. A wrong amount, a wrong date or the wrong card was permanent. Charges you typed in now have a "Remove this charge" option on the transaction list, behind a confirmation, and only rows you typed — a transaction from your bank can never be removed this way.
- **You could not add a charge to a card whose balance comes from the bank.** The form to do it, and the form for a card's credit limit, were both hidden behind the balance control — so a card connected to your bank showed neither, and a mistyped credit limit could not be corrected without disconnecting the account first. Both are now available on any card. Where a charge genuinely cannot be dated yet — the day your bank's balance is from is today, and a charge has to come after it — the button stays hidden rather than appearing and refusing.
- **Creating a fund with a name that already exists no longer takes the Funds page down.** It now says the name is taken, in the form, with what you typed still in it. Creating one also no longer strands you on the form because some *other* page failed to refresh — only a problem with the page you are being sent back to keeps you there.
- **Three messages that were themselves wrong.** A budget allocation that was *refused* could later report itself as saved-but-not-refreshed. Removing a card payment told you to reload the transaction list, which had already reloaded itself. And a warning about a stale page named the wrong page.

### Changed
- **Adding your first hand-entered charge to a connected card now tells you what it costs.** Once a card holds any activity you entered yourself, the app stops reading that card's balance from your bank and hands it to you to keep up to date. That has always been true and was never said. The dialog now says it before you save, and says it is reversible — removing the charge hands the balance back to the bank.
- **Warnings look the same everywhere.** "Saved, but this page couldn't refresh" is one message in one style now, rather than four different renderings of the same sentence.

## [0.26.0] - 2026-09-09

### Fixed
- **Re-linking a bank account while a sync is running can no longer put transactions on the wrong account.** Syncing works in two stages: the app reads which bank account each of your accounts is connected to, then goes off to fetch the transactions, which takes a few seconds. If you changed a connection on the Sync page in a second tab during those seconds, the transactions that came back were still filed against the connection that existed when the run started — so one bank's transactions could land on an account you had just pointed somewhere else, and nothing said so. Neither of the app's two duplicate checks could catch them afterwards, because both are scoped to the connection the rows claim to have come from. Every account is now re-checked at the moment of writing, and any account whose connection moved is skipped with a message saying which one and what to do about it: re-link it, link it again, or sync again, depending on what actually happened to it. Nothing is written for a skipped account, so nothing is lost.
- **The same problem could silently rewrite an account's balance, and that half was worse.** A credit card or loan does not import transactions — the app just reads its balance from the bank. That balance is the account's entire figure, and the app keeps exactly one previous value so you can undo a bad update. If a connection moved mid-sync, the wrong bank's balance was written over it, the one undo slot was spent storing a value that was already stale, no warning appeared, and the run reported "up to date" — the message that specifically means nothing changed. The balance update is now re-checked the same way, reads the account's current figure rather than the one from the start of the run (so a balance you set by hand during those seconds is no longer quietly overwritten), and only reports an update that actually happened. Previously it announced "Balance updated" even when the account had been deleted out from under it.
- **A sync that could not safely import anything no longer takes your last undo with it.** When every account was skipped, the app still created an import record containing nothing. Because Undo always targets the most recent sync, that empty record became the target — and the undo for the last sync that had actually imported something quietly stopped being reachable. It also used up one of the ten backup slots on a copy of a database nothing had changed. Nothing is recorded now when nothing is written.
- **Messages about skipped transactions now survive closing the tab.** The warning naming an account whose import was withheld existed only on screen. Close the tab or navigate away and there was no record anywhere that a sync had quietly imported less than the bank offered. Those messages are now saved against the import itself, so they are still there when you come back.
- **Two syncs at once no longer fail the whole run.** Running a sync in two tabs at the same time could end with one of them stopping on a raw database error and importing nothing at all — including transactions for accounts that were perfectly fine. The rows the other run had already saved are now recognised as the duplicates they are and skipped, with a note saying so, and everything else still imports.
- **Changing a category to income now asks first.** Once a category has any activity, switching it to income rewrites how this month, every earlier month, and the spending chart are calculated, and the app has no way to change it back. The banner that offers this has always asked for confirmation; the same action in a category's `⋯` menu applied instantly on one click, and v0.24.0 made that menu item appear exactly when it would be accepted, so the unguarded route had become the easier one to find. It now shows the same warning, is styled as the destructive action it is, and starts with the keyboard on Cancel rather than on the button that cannot be undone. Categories with no activity yet still change instantly, because that is reversible and does not need a dialog.
- **...and it can no longer be done by accident from a page left open.** The menu decided whether to ask by looking at information from when the page was loaded. If the category picked up its first activity elsewhere in the meantime — a sync, another tab, one click of "Copy previous month" — the stale page offered the change with no warning at all, and it was accepted. The check now happens on the server at the moment of the change, so a page that never showed you the warning is refused and asked to reload.
- **A category kind change that succeeded can no longer look like a failure.** If the page failed to refresh after the change was saved, you either saw the dialog sitting open with its "cannot be undone" warning and a live button inviting a second click, or an error page saying nothing had been written — when in fact it had. A refresh problem is now reported as a note on a successful change, and a genuine failure says plainly that the change may or may not have been saved rather than guessing.

### Changed
- **A sync that imports nothing because accounts were skipped now reports "up to date" rather than "synced".** Both carry the explanation; the difference is that no import record is created, so there is nothing on the Import page that holds no rows.

## [0.25.0] - 2026-09-09

### Changed
- **Removed a stored figure the app had stopped using.** Each budgeted month kept a saved copy of its "effective" amount — what you allocated plus anything carried over from the month before — so the app would not have to work it out again. The code that filled that copy in was deleted four releases ago and nothing replaced it, so for four releases the value was always empty while every single edit you made (categorizing a transaction, setting an amount, copying a month, changing a category's kind, undoing any of it) still paid to clear it. The stored copy is gone, along with the thirteen places that maintained it. The figure is worked out fresh on every read, which is what was already happening; a five-year run of months resolves in a fraction of a millisecond, so there was nothing for the saved copy to buy.

### Fixed
- **Nothing you can see changes.** This release is deliberately behaviour-preserving: the same month renders the same carried-over amounts before and after, verified against the real ledger. It is listed here because it moves a column out of the database, which is not reversible by switching back to an older version of the app — restoring an older version means restoring the automatic backup taken just before the change, which the app writes for exactly this reason. That backup lives in the same pool the app prunes to the most recent ten, so if you may want to go back, copy it somewhere else first.

## [0.24.0] - 2026-09-09

### Fixed
- **A category's `⋯` menu no longer offers to change its kind when the app will refuse.** Once a category has a transaction filed to it, or a month budgeted against it, its kind is fixed — but the menu went on listing "Set kind: expense / income / fund" anyway, and picking one just produced an error. That went from a rare annoyance to an everyday one when funds became budgetable in v0.23.0: typing anything into a fund's Planned cell, `$0` included, or one click of "Copy previous month", locks the kind from that moment on. The menu now lists only what will actually be accepted, and when there is nothing to change it says so and why — "Kind: fund · locked — a month is already budgeted here" — rather than quietly dropping the option and leaving you unable to tell a refusal from a missing feature. The rule now has one definition shared by the menu and the code that enforces it, so the two cannot drift apart again.
- **Money put into a fund can no longer appear from nowhere.** A fund set to roll over carries its unspent balance into the next month. Any money paid *into* a fund's category — bank interest, an unmatched savings deposit — was being counted as negative spending, which inflated that carried balance above everything ever actually budgeted. The rest of the app already refuses to treat money into a fund that way; the carried-balance calculation was the one place that had not heard. Both of the two calculations that carry a balance forward now share one rule, and a test pins them against each other — one of them had already been fixed and the other had not, which is exactly how the number came to be right when the page loaded and wrong the moment you typed into it.
- **"Planned to date" on the Funds page now stops at the current month.** The figure counted every allocation ever entered, including ones scheduled for future months — so budgeting December's contribution in September made September's page report that money as already put aside, and moved the headline progress figure toward a target that had not been funded yet. It now covers the fund's whole history up to and including this month, matching the column of the same name on the Budget page, which the two pages previously disagreed about. The month-by-month breakdown underneath is bounded the same way, so its rows add up to the total above them.
- **The Funds page no longer shows archived funds.** Every action it offered one was a dead end: the "Fund this month →" link usually landed on a month that does not show the fund, and setting an amount is refused on commit. Archived funds are still listed — and can be brought back — from Budget → Categories.
- **Editing a fund's target now refuses if the fund has been archived** in another tab, instead of silently changing a number on a fund the page can no longer show.
- **Creating a fund whose name is already taken now says so.** The Funds page's create form had no check at all, so a duplicate name produced an unexplained failure. It now names the conflict — and when the name belongs to an *archived* category, says that too and points at the page that can unarchive it, since an archived category is invisible everywhere else.
- **Copying a month now refreshes the Funds page.** "Copy previous month" copies fund allocations along with everything else, so the Funds totals it changes could sit visibly out of date.
- **Edits to one month now refresh the months after it.** A rollover category's carried balance is built from every earlier month, so changing what you budget in one month changes what later months show — but leaving the budget page only refreshed the month you were on.

## [0.23.0] - 2026-09-08

### Added
- **You can now put money into a fund from the month you are budgeting.** Funds were visible on `/budget` but read-only, and the page they pointed you at for "contributions" never had a contribution form — so a fund could be created and then never funded, by any route in the app. The Funds band is now editable exactly like Income and Expenses: type an amount in the Allocate column and it counts against Left to budget the same way an expense does, because that is what putting money aside actually costs you this month. Each fund row also shows what you have put in across every month so far and how far that is from its target, so the two questions a fund raises — "how much have I saved?" and "how much is left?" — are answered next to the field you type in rather than on another page.
- **Move every transaction for a merchant from one category to another, in one step.** Filing a merchant to the wrong category used to be repairable only one transaction at a time once the ten-second undo expired, and the page you filed it on stops listing the merchant the moment it is filed — so the mistake became invisible exactly where it was made. The repair now lives on the merchant's own transaction list (`/transactions`, reached from the "See all N transactions" link): pick the category the rows are wrongly under, pick where they should go, and move all of them at once. It has its own undo, and transactions you have since re-categorized by hand are left alone rather than dragged along.
- **Ticking "Remember" on that move can now retrain the merchant's rule instead of deleting it.** Moving a merchant's whole history to one category is the case where the app can be *most* confident about what the rule should say — so where a previous release could only refuse and remove a rule for a merchant filed two ways, this one recognises that the move itself has just made the merchant consistent, and updates the rule to match.

### Changed
- **Funds are called funds everywhere.** The sidebar, the page heading, the create form and the help text all said "goals" in some places and "funds" in others, for the same thing. They now all say Funds. The web address is still `/goals`, so any bookmark you have still works.
- **The Funds page headline is now what you have actually contributed**, with money taken back out shown on its own line beneath it rather than quietly folded into one number. It also links straight to the current month's Funds band, so seeing a fund is short and doing something about it are one click apart.
- **A fund's name now opens its transactions**, the same as a category name in the other two bands. Clicking a category name to see its rows is the learned habit on that page, and fund rows were the one exception to it.

### Fixed
- **Categorizing a transaction now refreshes the pages that depend on it.** Filing a transaction updated the transaction list and the budget, but left the Funds page and the dashboard showing figures computed before your change — so a fund's progress, or the dashboard's spending chart, could sit visibly out of date until something unrelated happened to refresh them. All the pages that read a transaction's category are now updated together.
- **A fund with no target no longer claims to be complete.** A fund created from the Budget page has no target until you set one, and the Funds page was showing that as "target $0.00" — which reads as a fund that is already finished — while the Budget page correctly showed a dash for the same fund. Opening "Edit target" on such a fund also pre-filled the box with `0.00`, and saving that value (which the app itself had put there) took the whole page down with an error. The Funds page now says "no target set", and the total line at the top no longer compares money across every fund against a target that covers only some of them.
- **"Planned to date" on a fund row now means what it says.** The figure counted allocations from *every* month, including months after the one you were looking at — so budgeting next month's contribution changed the number shown for last month, and a past month could be labelled "Funded" for a target you did not reach until later. It now covers the fund's whole history up to and including the month on screen.
- **A fund row's "Planned to date" and "Left to target" now update as you type.** They were computed when the page loaded while the Planned amount beside them was live, so tabbing down the Funds band left three numbers on one row that could not all be true at once.
- **The summary bar no longer breaks when you have a fund.** Adding the "Planned funding" figure made six statistics in a row sized for five, which pushed "Remaining" — the number the page is for — onto a line of its own with no separator above it, on wide screens only.
- **Errors from the merchant move now say what went wrong.** Messages like "no rows are filed here any more — reload to see the current counts" were being replaced by a generic failure notice in the packaged app, which is the only place most of them can happen.
- **Picking a category that disappears mid-edit no longer moves a different group.** If another tab (or an undo) emptied the category you had selected in the merchant move form, the form silently switched to the largest remaining group while leaving the button armed — so one click could move a much bigger set of transactions than the one you chose. It now says the choice is gone and refuses until you pick again.
- **A successful move is no longer reported as a failure.** If looking up a rule's name failed immediately after the move committed, the app reported "Move failed" for a move that had actually happened — and threw away the undo along with it.

## [0.22.0] - 2026-09-08

### Added
- **Every button on `/sync` that changes something now shows you it is working.** Linking a transfer, marking a pair as not a transfer, undoing a sync, connecting an account — each one used to sit there looking untouched while the work happened, and the only way to tell whether the click had registered was to wait for the card to disappear. On a page where the same click twice can mean two different things, that is the wrong thing to be guessing about. The button now says what it is doing ("Linking…", "Recording…", "Undoing…", "Saving…") and greys out until it is finished.
- **The two dropdowns that decide *which two transactions get paired* freeze while a pairing is in flight.** This matters more than the button does. Change a dropdown mid-flight and get a refusal back, and the error would appear underneath a selection that was never the one submitted — on the only screen in this app where you pair transactions by hand. They are now held still until the answer comes back.
- **On a review card with two buttons, only the one you actually pressed says it is busy.** "Link as reversal" and "Not a reversal" have opposite effects on your money, so both of them reading "Linking…" would have re-created the exact confusion the separate wording exists to prevent. The other button greys out but keeps its own name.

### Fixed
- **A same-account reversal could be *linked* when you had pressed "Not a reversal".** The form recorded which button you pressed, but treated a missing answer as "link" — so any submission that lost that one field would pair the two transactions instead of rejecting the pairing, remove both of them from every spending total, and report success. It would also have wiped out any "not a pair" decision you had recorded for them earlier. The reasoning for defaulting that way was that linking is the safer, more-checked, reversible option; on inspection none of that held — every check involved is already satisfied by any pair the screen can show you, and linking erases a previous rejection rather than being undoable. A missing answer is now refused outright, and both buttons state their answer explicitly, so pressing one and losing the field are no longer the same thing.
- **Confirmation messages on `/sync` now actually appear.** Every message telling you what a click did — that a pairing was recorded, that two rows went back into your spending, that a sync was undone — was being discarded a fraction of a second before it could be drawn, on every one of these buttons, and had been since the feature was written. Rejecting a reversal produced no confirmation anywhere at all. The message is now published before the card it belongs to disappears, and it shows up both next to the card and in the banner at the top of the page, so it is readable whether the card goes away or stays.
- **A refusal you are supposed to read is no longer wiped off the screen before you can read it.** Four cases where `/sync` declines to do something — undoing a sync that has already been undone, undoing one that is no longer safe to undo, unlinking a pair that is already unlinked, and syncing with no accounts connected — refreshed the page as part of declining, which could remove the very message explaining why. None of them had changed anything, so there was nothing to refresh for.
- **A saved change no longer reports itself as not having happened.** Recording a rejection refreshed the page inside the step that catches failures, so a hiccup during that refresh would report an already-saved decision as having failed. Moving the refresh out fixed that but replaced it with something worse: the hiccup then took out the whole page and replaced it with an error screen reading "Nothing was imported. Your ledger is unchanged" — an outright promise that nothing was saved, made after it had been. A refresh that fails now leaves the page up, keeps the confirmation, and adds a line telling you to reload; the write it followed is untouched either way.
- **Connecting an account to the feed it is already connected to no longer claims it changed something.** Pressing Save twice, or saving from a second tab, reported "Account linked — it will be included in the next sync" both times. It now says the connection was already there. The app already knew the difference and was throwing the answer away.
- **Linking a reversal now tells you when it erases a "not a reversal" you recorded earlier.** Linking a pair deletes any previous rejection of that pair, and there is no screen anywhere in the app to get it back. On a card offering several possible pairings, rejecting one leaves the card looking exactly as it did before — same two dropdowns, same selection — so the next click on "Link as reversal" would quietly reverse the answer you had just given, with a confirmation that mentioned only the link. It now says both things.
- **"Undo this sync" can no longer show you a message about the wrong sync.** If a refusal was on screen and another sync then completed, the message stayed put while the batch underneath it changed — leaving a warning that undo was unsafe sitting above a batch that was perfectly safe to undo, where it read as true.
- **The "Save" button for connecting an account was smaller than every other button on the page** — under the 44-pixel minimum the rest of the app follows, and the smallest tap target on the screen.
- **Screen readers are now told that something is in progress.** The busy state was purely visual: the label changes on a button that has just been disabled, and a disabled control announces nothing, so there was silence between the click and the result for however long the bank took to answer.

## [0.21.0] - 2026-09-08

**Upgrading:** this release changes how imported transactions are stored, so it carries a database migration. Under Docker, rebuild before starting: `docker compose build`, then `docker compose up` (the container applies the migration itself, taking a backup first). Take a manual backup with `pnpm db:export` beforehand if you want a verified one — this migration has no undo.

### Fixed
- **Re-pointing a bank connection to a different account could silently import every transaction a second time.** Connecting a feed, then later pointing it at a different account in the app, used to erase the record of where each already-imported row came from. Nothing looked wrong: the next sync simply could not tell those rows apart from new ones, so it imported the whole overlapping window again — every amount counted twice, no error, no warning, and the only sign would have been balances quietly drifting away from your bank. The fix records which feed produced each row and never erases it, so re-pointing a connection is now just a label change and your transactions survive it intact. This was the last known way for this app to duplicate money on its own.
- **A transaction with no record of its source is no longer invisible to duplicate detection.** There was one shape of row — carrying the bank's own transaction id but no note of which feed sent it — that fell through every duplicate check *and* the database's own uniqueness rule, which would have re-imported it on every single sync from then on. It could only arise from the migration in this release running while one of your accounts was disconnected, and there were none on your ledger when it ran. It is now caught by content instead, so the shape is harmless however it comes about.
- **Re-connecting an account now tells you when its transactions are stranded somewhere else.** If you connect a feed whose transactions are already filed under a different account, sync correctly refuses to import them again — but they stay where they are, leaving the new account's balance short by that amount with nothing to explain it. The app now says so at the moment you make the connection, and names the account holding them.
- **The warning about older un-tagged transactions no longer misses half of them, or overstates what happens next.** It was looking for the wrong marker, so one group of at-risk rows never triggered it at all. It also said a duplicate "may" not be recognised; for the case it describes, it definitely won't be, and it now says so.

### Changed
- **Duplicate detection for automatic sync is now scoped to the bank feed a transaction came from, rather than the account it happens to sit in.** A bank's transaction id is unique within its own feed, which is what the check was always trying to rely on; the account was only ever standing in for that, and stopped being a fair substitute the moment a connection moved. Nothing changes in day-to-day use — the same rows are recognised as duplicates as before — but reconnecting or re-pointing a feed no longer disturbs anything.
- **Re-connecting a feed no longer rewrites any of your transactions.** It updates the connection and nothing else.

### Notes
- One case is documented rather than fixed, deliberately: if you generate a completely new connection token (`pnpm simplefin:claim`) *and* wire the resulting feed to a different account than the one holding the old transactions, the overlap can still import twice. Widening the check to cover it would mean treating identical same-day transactions in two different accounts as duplicates, which they legitimately are not. Re-pointing the *same* account — the ordinary case — is covered, and the app now warns you in the situation where this could bite.

## [0.20.0] - 2026-09-08

### Changed
- **"Remember" now refuses to save a rule it knows would be wrong.** Ticking Remember on `/categorize` (or on a `/transactions` row) saves a rule that files every future transaction with that merchant name, without asking again — so a rule saved on the wrong kind of name is quiet from then on. Two kinds are now refused, and the checkbox greys itself out with the reason before you click rather than after — with that reason attached to the checkbox, so a screen reader announces it instead of reading out an unexplained disabled control. The first is a name that is not a merchant: your bank labels online and mobile transfers with nothing but the channel, so `ONLINE` appears on 39 unrelated payments across your whole ledger — a prescription, a Taco Bell reimbursement, money from a refinance — and one rule over that would file every future transfer the same way. The second is a real merchant you have already filed two ways: `AMAZON` and `COSTCO WHSE` are each split between two categories on your ledger, and no single rule can be right for both. It also catches the moment you create the split, not just afterwards — pick a second category for a merchant and the box greys out as you pick. Only the rule is withheld; the transactions are still categorized, because your decision about *those* rows is fine even when generalizing it is not. This affects 5 of your 180 merchant groups; the other 175 are untouched.
- **A refusal can also remove the rule the merchant already had — but only when you have contradicted it, and only from the two places where you picked the merchant yourself.** Refusing to *write* a rule is not enough on a merchant that already has one: a rule pointing `AMAZON` at the wrong category keeps filing every future import there, which means those rows are never uncategorized, which means `/categorize` never lists that merchant — and the one remaining way to retrain it, ticking Remember on a `/transactions` row, is exactly what the new guard refuses, because the rows that wrong rule filed are what make the merchant look split. There is no rules screen in the app, so the rule would have been permanent. So the refusal removes it, and afterwards that merchant's new transactions arrive uncategorized where you can see them, instead of being filed somewhere you have just said is wrong.
  Three limits on that, because removing a rule you wanted is its own kind of bad. If the category you picked is the one the rule *already* points at, you are confirming the rule, not contradicting it, and it stays. If the removal came from anywhere other than Remember on `/categorize` or on a `/transactions` row — "Categorize all" on `/subscriptions`, say — it does not happen at all. And when it does happen, the notification names the category the removed rule pointed at, and its Undo puts the rule back exactly as it was: category, priority, source and timestamps.

### Fixed
- **A merchant that comes back mid-session is no longer invisible for the rest of it.** `/categorize` hid each merchant as you finished it, and never un-hid it. If an import, a `/sync`, or an undo in another tab put new uncategorized transactions under a merchant you had already done, the page kept hiding it and kept counting it as done — work silently disappearing from the one page whose whole job is that it does not. The "N of M merchants done" counter is now honest on both halves of the fraction: a merchant that comes back is neither double-counted in the total nor still counted as finished.
- **`/subscriptions` no longer changes your rules without telling you.** Both of its Categorize buttons threw away everything the write reported, so a merchant whose rule could not be saved looked exactly like one whose rule was — and "Categorize all" could do that for many merchants in a single click. Each button now reports what it did, names the merchants it could not save a rule for, and keeps going past a merchant that fails instead of abandoning the rest of the list silently. Filing a subscription also refreshes `/categorize` and `/budget`, which it never did, so those pages stop showing rows it has already filed.
- **Transactions with a blank bank memo can be categorized again.** They group together under "(no merchant name)" on `/categorize` like any other merchant, but pressing Submit on that group failed with "Invalid bulk categorize input", and undoing anything for it failed with "Invalid undo snapshot". A blank memo is a real thing your bank sends; it is now handled as one everywhere. (Remember is still refused for that group, for the obvious reason.)
- **Moving a transaction to a different category no longer refuses to remember it because of the category it just left.** If a merchant's only filed transaction was the one you were moving, Remember was refused on the grounds that the merchant spanned two categories — counting the category the transaction was leaving, which no longer applied once the move went through. It is judged on where things land, not on where they were.
- **A categorize notification and its Undo are now one message, not two.** When something needed explaining — a rule withheld, a rule removed — you used to get a success notification and a separate warning. Stacked notifications collapse so that only the newest is fully readable *and* only its buttons are clickable, so the two were competing: whichever order they went in, either the explanation or the Undo that acts on it was the one you could not reach. They are now a single notification carrying both, and its Undo stays reachable for the whole ten seconds.
- **Undo can no longer fail with a raw database error.** If a rule for the same merchant was created between a refusal removing one and your clicking Undo — a second Remember, another tab — the restore hit a uniqueness constraint and the entire undo was rolled back, transactions included. It now puts the merchant back where it pointed instead of failing. Relatedly, "Reverted N rows." now also says what happened to the rule, so an undo that restored one and an undo that quietly found nothing to restore are no longer identical messages.

## [0.19.0] - 2026-09-08

### Added
- **`/sync` can now pair a charge with its own cancellation.** A reversed transfer, a disputed charge with a provisional credit, a returned payment — these put both halves on *one* account, and every matcher in the app required a pair to span two accounts, so nothing could see them and there was no way to fix one by hand. They sat in whatever spending category they were filed under, quietly. A new "Reversals needing review" queue on `/sync` lists them beside the existing transfer review, showing the two descriptions side by side. It **never links anything on its own**, and that is the point: on your ledger the same shape also turns up as pure coincidence — a $3.99 ATM fee refund sitting opposite a real $3.99 Apple charge on the same day, and a Zelle receipt opposite a genuine $200.00 ATM withdrawal. Auto-linking either would have deleted real spending with no error. Fourteen to review today; expect about two a month. Where a date and amount has several candidates, both dropdowns start on "Choose…" rather than an arbitrary row, so a wrong pairing is never one click away. Each item also has a **Not a reversal** button, so dismissing a coincidence no longer means linking it first and undoing it — that round trip briefly hid both rows from every spending screen. A dismissal sticks, so a plain merchandise refund only has to be answered once.

### Changed
- **"Spent" now means the same thing on every page.** A refund reduces that category's spend everywhere, which is what an envelope budget implies: return $20 of groceries and you have $20 of groceries to buy again. `/budget` already worked this way; the dashboard's 6-month trend chart counted only money going out, so the two disagreed. This was live, not theoretical — September 2026 showed **$10.00** of Misc on `/budget` and **$295.00** on the dashboard, the same category in the same month. The chart now uses the same signed sum `/budget` does, so the number that feeds Left to Budget is untouched. A month where refunds exceed spend reports as negative rather than being clamped to zero: clamping would be the same kind of lie this fixes.


_From the second review pass over the v0.16.0 liability work, below._

- **"Is this a credit card" had five different spellings in the codebase**, one of them not equivalent to the others. They agree only while there are exactly two liability types; a third would have split them silently, with nothing failing to compile. There is now one `isCreditCard`, exhaustive like its two siblings.
- **A request omitting a card's minimum payment no longer clears it.** Leaving the field empty still clears it, deliberately; not mentioning the field at all is a different statement.
- **A success message no longer invents a balance** when the account it refers to has been deleted mid-write — it reported "$0.00", which reads as a paid-off card.

### Fixed
_From the sign-convention change above._

_From a full review pass over this release, before it merges. The first two are
the same root cause and were both live on the real ledger._

- **The "Not a reversal" button could silently erase a "Not a transfer" you had already recorded** — and once erased, the automatic matcher re-linked the exact pair you had rejected, dropping both rows out of every spending total with no error. A rejection was stored as a single partner id on each row, so recording a new one overwrote the old. It is now a row per pair (`transfer_pair_rejections`), and existing rejections are carried across by the migration rather than lost.
- **A reversal bucket with two or more candidates on both sides could never be dismissed.** The queue only drops a bucket once every combination has been answered, but with one slot per row those answers overwrote each other — for a 2×2 or larger bucket the all-answered state was mathematically unreachable, so the bucket came back forever while the app said "this pairing won't be suggested again" every single time. Your ledger has exactly one such bucket, and it is the 2×4 cluster this whole feature was built for.
- **Nothing confirmed which button you pressed.** Resolving a review item removes it from the list, which unmounted the message explaining what had just happened — so on a one-candidate bucket "Link as reversal" and "Not a reversal" looked identical: the card simply vanished. Outcomes now surface in a status region that outlives the item.
- **"Not a transfer" reported success when it had done nothing.** Unlinking an already-unpaired pair (reachable from a stale tab after an undone sync) returned the ordinary confirmation while recording no rejection at all — claiming a durable correction that did not exist.
- **Recording a rejection skipped the validation that linking gets.** The durable, un-undoable half of the pair of operations was the *less* checked one: it verified only that both rows existed and neither was already paired. It now applies the same shape gate — opposite signs, equal magnitude, and same-day for a same-account pair.
- **The "also listed under" note promised something one of its two buttons doesn't do.** Linking a row that both queues claim does clear it from both; saying it is *not* a pair only answers one reading, and the other queue keeps showing it.
- **The transfer matcher's backtracking search is now bounded.** Its complexity argument rested on a rejection being a single column, and carried an explicit note to re-check if that ever changed — which this release changed. A dense set of rejections on one date could have taken the search factorial (measured at 3.5 seconds for eleven candidates, on a synchronous driver that blocks the page). It now falls back to "send this bucket to review" instead.

- **The trend chart was about to start counting your paychecks as spending.** The filter that dropped refunds was quietly doing a second job — excluding income, which is positive. Removing it alone would have pulled 43 paycheck and interest rows worth **+$52,131.17** into the last six months and drawn them as roughly $52k of negative spend. Spending is now decided by the category's kind, which is what the word actually means, rather than by which way the amount points.
- **Savings goals were deliberately left alone, and the reason is now written down.** Aligning the goals page to the same signed sum was tried during this change and reverted: goal progress is `allocated − withdrawn`, and a *net* withdrawn figure makes a deposit into a fund **increase** progress on top of the allocation that already counted the same intention. No fund category exists on any ledger yet, so nothing here has ever produced a number — which makes it the worst possible place to leave arithmetic nobody can observe. The query stays on outflows-only with the analysis recorded beside it.

- **A disputed charge on a credit card would have been reported as debt you paid off.** "Paid down this month" counts positive card rows that are paired, on the reasoning that the only way a card's positive row could be paired was a payment from checking. Letting reversals be paired broke that: a $200 provisional credit on the card, paired with the charge it cancels, satisfied the same test. Measured going from $0.00 to $200.00 on `/accounts` and the dashboard for money that never left checking. A payment now has to be paired **across** accounts, which is what a payment always was.
- **A refund-heavy month would have drawn in the wrong place on the chart.** The trend chart stacks its bars, and the stacking mode it was using does not separate positive from negative — a category below zero would have been painted back over its neighbour, above the axis, in the wrong colour, while the tooltip total stayed correct. Now negatives render below the axis, which is what the rest of this release promises.
- **The tooltip hid the very refunds this release surfaces.** It filtered to positive values only, so a category whose refunds outran its spend vanished from the hover panel *and* from its Total, leaving the number disagreeing with the bar above it.
- **A hand-entered transaction can no longer be paired as a reversal.** The review queue never offered one, but the check lived only in the query that built the list. Pairing a hand-entered row would have hidden it from every spending view with no ordinary way to undo it.

_A second review pass over the v0.16.0 liability work, before it merges. Nine
findings, all in code this release introduced._

- **The bank feed could silently invert a debt into an asset.** A balance arriving from SimpleFIN was checked for range and date but never for sign, on the only untrusted input in the app. A provider reporting a card as positive amount-owed would have added the debt to the wrong side of net worth — wrong by twice the balance, with a number that looks entirely plausible. A loan now refuses a positive balance outright; a card, which genuinely can hold a credit balance after an overpayment, accepts it with a notice.
- **Refreshing one account's balance ran a full transaction sync.** Clicking "Refresh" on the mortgage row imported up to 45 days of transactions for every linked account, wrote an import batch, ran auto-categorization and the transfer matcher — then reported one balance and discarded the rest, including a degraded-snapshot warning and a dead bank connection. It now refreshes that one account's balance and nothing else, and says so honestly when the bank reports a problem instead of claiming "the bank reports the same balance".
- **Saving a reconcile that changed nothing destroyed the ability to undo the previous one.** Only one prior balance is kept, and a no-op save spent it.
- **The reconcile and add-a-charge forms cleared what you typed when they rejected it.** The same React 19 behaviour that was fixed for two other forms in this release, missed on these two. The charge dialog was the worse case: it deliberately stays open on a refusal to offer "Reconcile instead", with your amount, date and merchant blanked behind the message.
- **A charge on one credit card could be marked as a payment to a different one**, minting money on the second card and dropping real spending out of the budget entirely. A payment now has to come from a checking or savings account.
- **A hand-entered charge could be filed under an income category, a heading, a savings goal, or an archived category.** Income categories were in the picker, so filing a charge under "Paycheck" — which quietly reduces that month's income — needed no trickery at all.
- **Un-marking a card payment failed when done from the card's own row**, refusing with a message that was untrue and that pointed at an operation which would have left the card balance wrong. Hand-marked payments also no longer appear on `/sync` beside a "Not a transfer" button that would corrupt them.
- **The test that guards the balance sign convention contained the very bug it was guarding**, so it would have passed if the fix were reverted. There is now a direct test of the one function that owns the sign.
- **The docs described a mortgage as having no Reconcile**, which would have reintroduced a fixed bug where an unlinked car loan had no way to correct its balance at all.

## [0.18.0] - 2026-09-07

_The merchant name on `/categorize` finally goes somewhere. `AMAZON` is a
deliberately lossy key — 59 charges can hide behind it — and the only way to
see what you were actually filing was to remember the merchant, walk to
`/transactions`, and search. Now the name opens, shows you three of the bank's
own memos, and links straight to those exact rows._

### Added
- **Every merchant on `/categorize` opens.** Click the name and it shows up to
  three of the bank's real memo lines for that group — the text that actually
  tells `AMZN MKTP US*2X4RT9KL3` apart from `AMAZON.COM*RT4YU8QQ3` — plus a
  link to every transaction behind the key, filed ones included. A group whose
  memos are all identical to the key shows no panel to open, because there
  would be nothing in it.
- **`/transactions` filters on an exact merchant.** Arriving from a drilldown,
  the page leads with the merchant as a removable chip and a line that answers
  the question you clicked to ask: `50 rows, 1 uncategorized · 49 filed as
  Gas`. The counts share one predicate builder with the list, so the header
  cannot describe a different row set than the one under it.
- **A "Categorize all N" shortcut** from that header back to bulk filing, and a
  progress counter on `/categorize` (`12 of 181 merchants done`).
- **Your half-finished pick survives the trip.** Choose a category, drill down
  to check what those charges were, come back — the pick is still there. It
  survives a hard reload too, and is discarded when the tab closes.

### Changed
- **Both transaction lists are ruled rows, not stacked cards**, with column
  headers that line up with the values under them. At 181 rows the card shells
  were most of the ink on the page.
- **Rows show the bank's own memo text**, wrapped to two lines on a phone where
  there is no tooltip to fall back on. Under a merchant filter the memo takes
  the headline slot, since repeating the same key 59 times says nothing.
- **A merchant link narrows what you are already looking at** rather than
  replacing it — a date range you set deliberately is not silently discarded.
  A row already matching the active merchant is plain text, not a link to the
  page you are standing on.
- **Filtering to a merchant no longer dims the rows already filed.** You asked
  to see them.
- The three remaining hand-rolled amber warning surfaces moved onto the shared
  accent token, leaving `import/preview` as the last one.

### Fixed
- **A merchant key containing `#`, `?`, `/` or `*` now survives the link.**
  17 of 363 real keys do. A bare `#` truncates a query string, so the old shape
  would have filtered on `GASCO` and shown the wrong merchant's rows with no
  sign anything went wrong.
- **A stale bookmark explains itself.** A merchant backfill can rewrite the
  keys these links are built from; a `?merchant=` matching nothing now names
  the key and offers a substring search as the way back, instead of an empty
  list.
- **The transactions rows had a tooltip showing the word `WITHDRAWAL`** on
  every row since it shipped — `raw_description` holds only that and `DEPOSIT`.
  Removed; the memo is on the row now.
- **A merchant with nothing to disclose lost its drilldown link too**, which
  was exactly backwards: those rows are the ones showing a bare key they cannot
  elaborate on.
- **`/transactions` still ships no validation library to the browser.** Pulling
  the URL schema into a testable module put zod one import away from the client
  bundle — measured at +376 KB before the constants were split back out into a
  dependency-free module. Caught in review, so nothing shipped; recorded because
  the split looks like indirection until you know what it costs to undo.
- **A picked category could not be re-selected in Safari private mode**, where
  session storage throws rather than failing quietly — the field stayed empty
  and Submit stayed disabled.
- A row with an empty merchant key could produce a link that promised one
  merchant and landed on all 1,540 rows.
- **A deliberate page size survived some links and not others.** `?pageSize=200`
  was dropped by six of the page's own links — the merchant chip's `×`, the
  transfers toggle, "Back to page 1", both empty-state recovery links, and a
  row's merchant link — snapping the list back to 50 rows with nothing saying
  so. `pageSize` is now a member of the filter set, so every link carries it and
  the round-trip guard covers it like any other field.
- **The zero-result state could misdiagnose a stale link and then offer two
  recoveries that both failed.** With a date range also active, "no transactions
  for X" blamed the merchant key for an empty list the date range had caused,
  and both escape hatches kept the date range — so the suggested fix landed on
  another empty page. It now says which case it is in and clears the rest.
- **The stale-link recovery 404'd for a merchant key over 200 characters**,
  because merchant keys are unbounded and `search` is capped. It truncates.
- **An empty trailing URL parameter 404'd the page.** `?merchant=AMAZON&ref=`
  — the shape a mail client or a link shortener leaves behind — was rejected
  by the strict schema even though every real filter parsed fine.
- **A row whose merchant key is empty rendered a link that did nothing**, styled
  exactly like a working one. It renders as text now, and a rejected URL is
  logged server-side rather than 404ing with no record of what was wrong.
- **The tests guarding the stale-link recovery asserted against a copy of the
  code rather than the code.** The suite documents two bugs that link has
  already had — keeping the other filters, and not truncating an over-long key
  — but the expression it checked lived inline in the empty state, and the test
  file had reimplemented it. Either bug could have come back with all four
  tests green. The builder is now a named function both sides use.
- **The session-storage test suite passed only because of the order it ran in.**
  The module keeps its cache at module scope, and the Safari-private-mode block
  read from whatever an earlier test had left there; shuffled, it failed 2 runs
  in 5. That block now takes a fresh module per test.
- **`191` appeared where the number is `181`** — the count of uncategorized
  merchant groups, in the README, the plan, `CLAUDE.md`'s rule 10 and two code
  comments. Re-measured against the live ledger: the page's own predicate
  returns 181, and `191` matches nothing under any predicate. The `11 of 181`
  substring-superset figure is exact.
- **The focus-ring constant's docstring made two claims that were not true of
  its own consumers** — a call-site count that was really a `grep` line count,
  and "every consumer is rounded", when 8 of the 14 are bare links and
  `<summary>` elements with no radius at all.
- **Three controls in the filter bar had no focus ring**, including "Apply
  filters" — the ones `DESIGN.md` names as the reason the shared constant
  exists.
- **Filing a merchant from `/categorize` left `/transactions` showing it as
  uncategorized.** The drilldown makes the two pages a round trip, but only one
  direction marked the other stale, so the page you returned to still listed
  the rows you had just filed, under a header breakdown that no longer matched
  the ledger. It cleared on a hard reload, which is not a thing anyone should
  have to know.
- **"Show transfers" could suppress the stale-link diagnosis.** On a merchant
  link that no longer matches anything, the empty state correctly blames the
  key. One click of the transfers toggle — which only ever ADDS rows — flipped
  the copy to "the merchant key itself may still be fine", on a page that had
  got emptier for no new reason. A widening toggle is no longer counted as a
  filter that could have emptied the list.
- **A transaction with no merchant name was invisible on `/categorize`.** One
  blank Memo cell in a CSV produces an empty merchant key, and while
  `/transactions` labelled that row, `/categorize` rendered a nameless row with
  a screen-reader label reading "Category for " and no way to drill into it.
  Both sides now name it the same way.
- **"Categorize all N →" could name a number the destination would not
  honour.** The header counts under every active filter; `/categorize` filters
  on nothing but "uncategorized and not transfer-paired". Select a month and
  the link read "Categorize all 4 →" while filing all 53 rows of that
  merchant, $2,647.30 across eight months — reproducible in all eight. It now
  drops the count and reads "Categorize this merchant →" whenever another
  filter is narrowing the list.
- **The zero-result state named a recovery it offered no button for.** With
  another filter also active it says the merchant key may be fine and that
  clearing the rest is the quickest way to tell — while the primary action did
  the opposite, dropping the merchant and keeping the rest, which landed on a
  second empty page whenever a date range was what emptied the first. That is
  the bug already fixed on the other link, on the one beside it.
- **A blocked browser lost every parked category pick without saying so.** The
  wrapper around the `sessionStorage` property access swallowed the error
  entirely, and it is the failure that short-circuits all five inner handlers
  — so in Chrome or Firefox with site data blocked, a dozen picks vanished on
  reload with both consoles clean. It is exactly the case the module's warning
  exists for.
- **The rejected-parameter log could not name the parameter.** A `.strict()`
  violation carries its offending key names on a field the log discarded,
  so an unknown param logged as `{path: [], code: "unrecognized_keys"}` —
  naming nothing, in precisely the in-app-link-builder case the log was added
  for. Both range guards now log too; a mistyped amount pair was a 404 with no
  record at all.
- **A filter could clear every contract gate and still never reach the WHERE
  clause.** The object handed to the query builder had no type annotation and
  every field on it is optional, so a filter that was accepted, serialized,
  typed and carried by the form could simply be missing there — rendering its
  chip, reporting it in the header, carrying it to page 2, and filtering
  nothing. It is now annotated, and dropping a field fails `tsc`.
- **Two docstrings promised more than the code delivers.** The merchant header
  was documented as unable to describe a row set the list is not showing; it
  shares the list's predicates, not its read instant, so it can lag by one
  commit. And the pending-pick pruner justified itself with a second-tab
  scenario it cannot cover, since session storage is per-tab.

## [0.17.0] - 2026-09-07

_Merchant names finally group. The ledger had 516 different merchant names for
1540 transactions — more than one name for every three rows — because a
reference number, a timestamp or a city on the end of a bank memo made every
purchase look like a new merchant. It now has 363, and one-off names dropped
from 354 to 222. The rules you have already trained come with it._

### Added
- **`pnpm db:backfill-merchants`** — brings the merchant names already in your ledger in line with the normalizer, and rewrites your trained categorization rules to match. Without it the two disagree silently: rules keep matching the old names while every new import writes the new ones. Measured on the real ledger, that gap would have dropped auto-categorization from 672 rows to 196. It runs a dry run by default, snapshots before it writes, does everything in one transaction, and refuses outright if two rules would merge while disagreeing about the category — the only part of it that moves money between envelopes.

### Changed
- **Google One and YouTube Premium are separate merchants again.** They shared a single "GOOGLE" name that spanned two different categories, so whichever one you categorized last silently decided where the other one filed. The same fix applies to any charge where Google bills for its own product.
- **Amazon Prime is separate from ordinary Amazon orders**, so a Prime subscription charge no longer disappears into the general Amazon pile — and the built-in "Amazon Prime" subscription rule keeps working.
- **A store's own name is no longer mistaken for a state code.** Names the bank truncates mid-word — `TAPPED APPLE LL`, `HOTEL SUTTER RE` — kept losing their last two letters. Only real state codes are stripped now.
- **Merchant names clean up completely in one pass.** Removing a city could expose a store number, removing that could expose something else, and the old cleanup stopped after one round: `SAVEMART #12 MA MANTECA` settled as `SAVEMART MA` and `AUTOZONE 3335 147 MANTECA` as `AUTOZONE 3335`. They now settle as `SAVEMART` and `AUTOZONE`.

### Fixed
- **A merchant name could come out starting with a `*`.** A memo that began with a timestamp left nothing in front of the reference marker, and the whole raw string became the name.
- **Normalizing an already-normalized name is now a no-op** for every merchant in the ledger but one, which is documented rather than hidden. The test that claimed this previously used a hand-picked list that happened to exclude every counterexample, so it could never fail while the claim was false for 22 names.
- **Dismissed subscriptions survive a merchant-name change.** They are stored under the merchant name, with no link back to the transactions, so a rename would have brought a dismissed subscription back as active while leaving the original permanently unreachable from the page — no way to dismiss it again.
- The docs described the normalizer as "12 rules"; it has been a four-phase pipeline for a while.

## [0.16.0] - 2026-09-07

_Credit cards and loans. The app has tracked what you have since day one; this
is the first release that tracks what you owe, and puts the two together into
a net worth figure. A mortgage is deliberately inert — it shows up in the
total and does nothing else, because it is a fact about your life rather than
a problem you are solving this month._

### Added
- **Credit cards and loans are real account types.** Add one from `/import` by entering what you owe as a positive number ("Balance owed") — you never type a minus sign anywhere in the app. Cards can carry a credit limit and a minimum payment; loans and mortgages carry neither, on purpose.
- **A new `/accounts` page**, second in the nav, where debt is managed. Assets and liabilities as ruled lists, a `Cash` subtotal, a `Debt` subtotal, and a net worth bottom line. Each card row shows how much of its limit is used, when the balance was last confirmed, and how much you paid down this month.
- **Reconcile** — set what a liability actually owes today. It is the one way the *anchor* moves by hand, and the only way at all for anything not linked to the feed, a car loan included. **Refresh** — pull a linked account's balance straight from the bank feed, offered only where it can work (a feed-linked account with no transactions of its own).
- **Undo a balance change.** Every reconcile records the balance it replaced, and the row offers to go back to it. Undoing is itself undoable.
- **Edit a card's credit limit and minimum payment** after the fact, so a mistyped limit is a fix rather than something you live with.
- **Add a charge or a refund to a card by hand**, categorized, so card spending counts toward its envelope in the month you spent it. A charge dated before your last reconcile is refused — it would count as spending without moving the balance — and the refusal hands you straight to Reconcile, which already includes it.
- **Mark a transaction as a card payment** from the row menu on `/transactions`, pairing the money leaving checking with the money landing on the card so it counts as neither spending nor income. Unmark it the same way.
- **"Closest to limit"** on the dashboard — the five categories nearest to spending their budget, worst first, so the ones about to go over are the ones you see.
- **A "show transfers" toggle** on `/transactions`. Transfers are hidden by default because they are not spending; the toggle survives paging and filtering.
- **The dashboard's balances are now a ruled list rather than a grid of cards**, with net worth closing it — and it renders whether or not you have any debt.

### Changed
- **`DESIGN.md`'s spacing cadence is now actually followed, app-wide.** It has specified a 4/8/12/16/20/28/40/56 scale since the design system was written while every page used the 24px shadcn cadence it tells you to avoid. 37 files, mechanical: page gutters to 20px, section rhythm to 28px.
- **Balances are computed once per page render instead of twice.** The nav's balance peek and the page body each ran the full query independently; on a synchronous SQLite driver that is two passes over the transactions table per page, and it was the one cost here that grew with transaction count.
- **The "Add an account" form keeps what you typed when validation fails.** It used to replace the whole page with a generic error card and clear every field, so the specific message about what was wrong never reached you.

### Fixed
- **A hand-entered charge could be saved with a date that is not a date.** `2026-13-40` (there is no month 13) and even plain text were stored as written, which silently mis-sorted that account's entire history against the balance anchor. CSV import was hardened against this in v0.12.4; the hand-entry path was not.
- **A card's balance could round to a different number depending on which screen you set it from** — creating the account and reconciling it disagreed by a cent on half-cent amounts.
- **Reconciling with the balance field left empty silently set the card to $0** instead of refusing.
- **A charge with no upper limit on its amount** could be submitted and permanently skew the card balance, net worth, and its envelope.
- **A loan created with a very large balance could never be corrected afterwards** — creation accepted a figure that the only repair path then rejected, leaving no way back.
- **Long-term debt was distinguished only by lighter grey text on the dashboard**, which a screen reader cannot perceive. It now carries a real "Long-term" heading, as `/accounts` already did.
- **The "show transfers" toggle announced nothing to a screen reader**, and the charge/refund switch showed no focus outline when tabbed to.
- **Several controls were below the 44px touch-target floor** the rest of this release uses, including the nav's balances link — whose comment claimed it was already compliant.
- **`pnpm db:seed-dev` ran database migrations against whatever `DATA_DIR` pointed at *before* checking whether that database was empty**, so its own promise that it "cannot clobber a real ledger by a mistyped DATA_DIR" was not true for the migration step. It now requires `DATA_DIR` to be set explicitly and refuses if any ledger table has rows.

## [0.15.0] - 2026-09-05

### Added
- **`/transactions` now has real search and filtering.** A filter bar above the list lets you search by description, merchant, or payee; narrow to one account or category; pick an arbitrary date range (replacing the old one-month-at-a-time picker) with a "This month" quick-select button; filter by amount range (matches a transaction's size regardless of whether it's a deposit or a withdrawal); and show posted-only, pending-only, or everything. Filters compose — search, account, category, date range, amount range, and status all apply together — and every combination stays intact across pagination.

### Fixed
- **`/budget`'s category drilldown links no longer silently widen to "every transaction ever"** now that the date-range change above retires the old month picker — the four links that jump from a budget row into that category's transactions for one month now carry the new date-range params instead.
- **A filter pointing at an account or category no longer in the picker's list** (an archived category, or a hand-edited URL) **used to silently revert to "All" the next time you changed a filter**, quietly dropping the constraint. The picker now shows the actual filtered value even when it isn't in the dropdown.
- **A bookmarked or hand-typed link still using the retired month-picker URL format now returns a clear "not found"** instead of silently showing every transaction ever filed under that category.
- **A non-default page size no longer resets to 50** when applying a filter, using the "This month" shortcut, or clearing filters.

## [0.14.0] - 2026-09-05

### Added
- **`/budget/[year]/[month]` now has an in-page "How this page works" reference.** A collapsible glossary — closed by default, matching the same native `<details>`/`<summary>` pattern already used on `/goals` — explains the envelope-budgeting model and what each of Left to Budget's five states means (before income is planned, looking ahead to a future month, still unassigned, over-budgeted, every dollar has a job), plus why Funds is read-only here and why Spent can look wrong when transactions aren't categorized yet. It's hidden on a genuine first-run month so it never stacks with the existing first-run onboarding card, and it's static, server-rendered reference content — it never reports which state currently applies, only what each one means in general.

## [0.13.0] - 2026-09-04

_Zero-based budgeting, EveryDollar-style: every dollar of expected income gets
assigned a job before the month starts, and the app tells you when the
assignment is complete. This is the first release where categories have a
`kind` — income, expense, or fund — rather than being an undifferentiated
list, which is what makes "Left to Budget" and rollover-aware envelopes
possible at all._

### Added
- **The `/budget/[year]/[month]` surface is now a real budget, not a read-only summary.** Every expense and income category shows planned vs. spent/received and rollover carried forward from prior months, grouped into their own income/expense bands; fund categories get their own band too, but stay read-only here — planned amount only, linking through to `/goals` for progress and contribution history.
- **Every planned-amount cell is editable in place.** Type a dollar amount, press Enter to commit and jump to the next field (wrapping across income/expense sections in document order), or Escape to revert — no separate save step, no page reload. A border-color state (saving/saved/failed, with inline retry) is the only feedback, matching the rest of the app's no-toast-for-routine-saves convention.
- **Copy last month's budget into this one** with one click — every category's planned amount carries forward, skipping anything already set or archived this month. Reflects immediately in the open editor without a page reload.
- **Categories can be created, renamed, archived, and reorganized without leaving the budget screen.** "+ Add a group" and "+ Add a line to {group}" create new structure inline; a category menu on each row handles renaming, setting its rollover policy (carry over / reset to zero), reordering within its group, and archiving. Archiving refuses a category that still has children, still has a nonzero planned amount in the current or a future month, or is the built-in "Uncategorized" bucket — each with a specific reason, not a generic error. An archived category is excluded from every picker and its auto-categorization rules stop firing, but it isn't unconditionally hidden from the budget view: a month it already has a planned or spent amount in keeps showing it, so archiving never erases that month's numbers. `/budget/categories` is the one place an archived category can be brought back with "Unarchive."
- **A category that was actually always income, but got named or categorized like an expense, can be reclassified** — with a confirmation dialog that states the exact transaction count, date range, and a same-signs check up front, not just a rejection after you try. Reclassifying a category that already has real activity is refused outright in every other direction; this is the one deliberate exception, since a mislabeled income category otherwise has no way back once "Left to Budget" depends on at least one income category existing.

## [0.12.4] - 2026-09-04

### Fixed
- **A still-pending deposit carrying the bank's shared placeholder transaction number could get coincidentally matched to an unrelated, already-posted transaction as a false transfer pair**, silently dropping both from spending totals with no way to tell it apart from a real match. Pending transactions can no longer be selected as a transfer-pair match while still pending.
- **A corrupted or hand-edited CSV row with a calendar-invalid date (like April 31st, or February 29th outside a leap year) was silently accepted into the ledger.** Every imported transaction's date is now validated the same way an account's starting-balance date already was, and a calendar-invalid row is rejected with a clear error instead of being imported.
- **Marking a transfer pair as "Not a transfer" could later be silently reversed** by an unrelated future import landing on the same date, quietly reopening the exact mismatch that was just corrected with no notification. That correction now sticks — while still allowing either of the two transactions to pair correctly with a *different*, genuinely matching transaction later, and without losing the app's other self-healing behavior that occasionally catches an unrelated missed transfer pair.

## [0.12.3] - 2026-09-04

### Fixed
- **A transfer whose pending leg posted via a narrow re-export (no new rows, just an existing pending row flipping to posted) could never get matched to its real counterpart on the other account.** Transfer-pair matching only re-checked rows carrying the current import's own batch id, and a posted-in-place row keeps its original batch id by design — so the real pairing opportunity was silently skipped every time. Re-checking now also covers rows that just posted, not just newly-inserted ones. The import success page's "transfer pairs linked" count is fixed to match: it previously recomputed from the current batch's rows only, which would show 0 in exactly this case even though the pairing succeeded.
- **A hand-edited or corrupted account starting-balance date like `2026-13-40` was silently accepted** and could drop an account's entire imported history out of its displayed balance. Calendar-invalid dates are now rejected wherever a starting-balance anchor is set — account creation, the manual anchor-edit form, and CSV-derived anchoring alike.
- **Running `pnpm db:migrate` from the wrong working directory (e.g. a second local checkout) could silently migrate an unrelated, empty database and report success**, leaving the real ledger's schema out of date with no warning. The migration script and Drizzle Studio config now respect the same `DATA_DIR` override the rest of the app already does.

## [0.12.2] - 2026-09-03

### Fixed
- **The dashboard's "Spending — Last 6 Months" chart tooltip could cover its own legend, and hovering a bar showed a stark white box behind it.** A month with many categories grew the tooltip tall enough to reach down into the legend below the chart; the tooltip now caps itself at 5 categories plus a "+N more" line and stays pinned near the top of the plot area. The hover-highlight rectangle behind the active bar also now uses the chart's own subtle border color instead of Recharts' default light-theme fill, which read as a jarring white box against this app's dark background.
- **A same-day transaction pair that nets to zero (a paycheck and a bill, say) could anchor an account's starting balance on the wrong figure**, decided only by which order Star One happened to write the two rows in its export — the two orders are mathematically indistinguishable, so the app is no longer forced to guess between them. Importing a file like this now leaves the existing anchor alone instead of silently picking one.
- **A CSV import moving an account's starting-balance anchor now does so atomically with the rest of the import**, so a failure partway through can't leave the anchor moved but the imported rows missing (or vice versa). The account's prior anchor value is also recorded on the batch, so a bad automatic move can be corrected from the import success page without having to guess what the old number was. A derived balance or date outside sane bounds (including an accidental future date) is now declined rather than written, and — when a real import problem does cause the anchor to be declined — that's now shown on the import success page instead of failing silently.

## [0.12.1] - 2026-09-03

### Fixed
- **The category picker's search box on `/transactions` and `/categorize` stopped matching anything you typed.** Typing "hotel" (in any case) wouldn't find the "Hotels" category, because the picker's label-lookup function was being handed the wrong shape of data during filtering and always came back empty — every keystroke matched against nothing. Search now works as typed.
- **The same picker could also lose track of which category was highlighted after searching, then clearing the search text.** A related mismatch meant the currently-selected category and the full category list weren't compared consistently, which could drop the keyboard highlight after backspacing out a search. Fixed alongside the search bug since both traced back to the same root cause.

## [0.12.0] - 2026-09-03

_A too-broad rule trained today already has 23 seeded siblings from migration 0006 (NETFLIX, SPOTIFY, HULU, and 20 others) — every one of them a candidate for mis-tagging an entire import with no way back short of restoring the whole database. This release closes that gap: import-time categorization gets its own undo, scoped to just the categorization, not the transactions it touched._

### Added
- **Auto-categorization at import can now be undone without discarding the whole import.** Every row a trained rule categorizes on the way in — from a CSV import or a SimpleFIN sync — is now recorded, and an "Undo auto-categorization" button on the import success page (and a link from `/sync` for synced batches) reverts just those rows back to uncategorized. A row you've since categorized yourself, by hand, is left alone even if it happens to land back on the same category a rule originally chose.

### Fixed
- CLAUDE.md's description of import-time categorization no longer claims it has no undo — corrected to match the behavior above.

## [0.11.0] - 2026-09-03

_The `/sync` balance check could only say one thing about a difference: "a row is missing or duplicated." That was wrong whenever the bank's own figure was simply out of date — measured once at +$893.84 of "drift" that was really just a day of activity the bank hadn't reported yet. This release teaches the check to tell the two apart, and gives you a way to fix the one thing that was making the ledger-side comparison untrustworthy in the first place._

### Added
- **The balance check on `/sync` now distinguishes a real discrepancy from a stale bank figure.** A difference is only reported as "a row is missing or duplicated" once the bank's own figure is dated *after* your newest ledger row — same-day or older figures are shown as unconfirmed instead, alongside the bank figure's as-of date, rather than accusing the ledger of corruption it doesn't have. A bank figure with no date at all is now called out separately, since that's a different reason to withhold judgment than simply being old.
- **A wrong starting-balance anchor no longer needs raw SQL to fix.** Each account on `/import` has an inline "start [balance] on [date] Save" form — the only way back once an anchor is set too late, since a CSV import can only ever move it forward. The date is capped at today and any future date is rejected outright, since an anchor dated ahead of every real transaction would exclude your entire imported history from the balance and permanently silence the drift check in the same stroke.

_Stabilization pass ahead of loading the real ledger — see `docs/plans/load-the-ledger.md`. Three defects, all of which only bite on real data, plus the doc drift that hid the first one; a pre-landing review then found six more, all silent-corruption paths reachable during the same migrate-then-backfill sequence this pass exists to make safe._

### Added
- **Imported transactions are now categorized automatically** from the rules you have already trained. `applyRuleAtImport` shipped in 0.3.0 with tests and a changelog entry saying it ran at import — and nothing ever called it, on either the CSV path or SimpleFIN sync. Every import landed 100% uncategorized no matter how many rules existed, which is why the backlog only ever grew. Both write paths now resolve each row through the rules table, and the import success page reports how many rows resolved and how many are left.
- **An import now sets the account's starting balance** from Star One's running-balance column, which the parser has always read and always discarded. Accounts created with a starting balance of 0 display net-change-since-signup rather than a balance, and `/sync`'s drift check compares that against the bank's real figure and reports a phantom missing row forever. The anchor is only written when the file's running balance forms a consistent chain — a gappy or hand-assembled export leaves it alone rather than guessing — and it only ever moves forward in time. The import success page now shows the anchor a batch actually wrote, rather than re-reading the account's current anchor (which could belong to a later import by the time you look).

### Fixed
- **A wider CSV re-export no longer imports history twice.** Star One exports an arbitrary date range, and the duplicate check keyed on a hash that includes each row's position in its file — so re-exporting a window that overlapped what you already had shifted every row and matched nothing, silently double-counting the overlap while the preview reported "0 duplicates". Import now also compares on content, the same way sync has since 0.8.0. Two genuinely identical same-day transactions still both import.
- **Transfers from a backfill can now be reviewed.** The transfer-review list on `/sync` looked back 120 days, which cut off the start of any catch-up import; those pairs stayed unlinked and kept counting as spending with nothing on screen to say so. Widened to 240 days.
- **A pending row's posted counterpart no longer vanishes into the ledger forever.** The content-dedup pass above had no pending/posted distinction, so a row CSV-imported while pending permanently suppressed its own posted re-export — stuck on Star One's `6098` placeholder, un-pairable by the transfer matcher, invisible to subscription detection. Content dedup now recognizes a pending row's posted arrival and updates it in place.
- **A migration that seeds the Subscriptions category and its rules was silently skipped** on any database with real history — a journal-timestamp ordering bug meant it could never apply once later migrations landed, though the migration runner reported success either way.
- **The account balance shown after a sync could read as a phantom missing transaction.** A pending row imported from CSV inflated the computed balance past the bank's own posted figure, which `/sync`'s drift check compares against.
- **Undoing a sync could delete a transaction with no other copy.** CSV content-dedup has no notion of which source a row came from, so a later CSV import could quietly rely on a sync batch's row already being there. Undo now refuses once a newer import of any kind exists, rather than deleting silently.
- **A same-day, same-amount coincidence between two CSV rows could get auto-linked as a transfer** instead of being sent to review — backwards from the intent, since both legs having already been examined and declined by the stronger ±1 matcher is the strongest evidence against a real transfer, not the weakest.

## [0.9.0] - 2026-09-03

_PR1 of the dockerize-postgres plan: the app now runs in Docker, still on SQLite. `pnpm dev` is unaffected — this is a second way to run the app, not a replacement._

### Added
- **`docker compose up` starts the app at `localhost:3000`**, serving your existing ledger. The port is bound to loopback only (this app has no auth), the ledger lives in a named Docker volume (SQLite's WAL mode doesn't tolerate bind-mount filesystems reliably), and pre-write/pre-migrate snapshots land on a separate `./backups` bind mount so `docker compose down -v` can't take the ledger and its rollback history out in one command.
- `pnpm db:seed-volume` — one-time host → volume copy for the first `docker compose up`, so a fresh container doesn't start with an empty ledger. Refuses to overwrite a volume that already has data.
- `pnpm db:export` / `pnpm db:import <file>` — snapshot the running container's ledger out to `./backups`, and restore a snapshot back in (stopping and restarting the container). `db:import` now also refuses to restore a file that isn't a real, openable database with an `accounts` table — a corrupt or empty snapshot used to "restore" silently as an empty ledger with no error.
- `/api/health` — a liveness probe the Compose healthcheck uses; doesn't run the full dashboard query set.
- A CI job builds the Docker image on every PR, seeds it, brings it up, and round-trips an export/import to catch regressions in the container path before merge.

### Fixed
- **The app could compute the wrong budget month for part of every day**, because it read the system clock through `.toISOString()` in a few places, which always renders the UTC calendar date regardless of the configured timezone. A shared `src/lib/now.ts` fixes this everywhere it mattered, including one site that fed the transfer-review window — under the old code an ambiguous transfer pair right at the edge of that window could silently drop out of review and keep inflating spending.
- **`/import` was frozen at build time** (a pre-existing bug, surfaced by containerizing): the page never opted into per-request rendering, so its starting-balance date default froze to whenever the app was last built rather than updating daily.
- Every container restart was writing a rollback snapshot into the same retention pool that CSV imports and syncs prune to the last 10 — so a crash loop or a routine host reboot could silently evict a real pre-import snapshot a user might actually need. Restart snapshots now use their own pool, matching the naming convention `pnpm db:migrate` already used for this on the host.
- On real Linux hosts (found via CI, which runs Ubuntu), `./backups` — a bind mount — got auto-created root-owned on first use, so the container's unprivileged user hit `EACCES` on its very first snapshot write and never became healthy. macOS Docker Desktop's more permissive bind-mount layer never surfaced this. Fixed with a permissions step before the first `docker compose up`, documented in the README quickstart.
- `db-import`/`db-seed-volume` hardcoded a Docker volume name that could silently diverge from the real one whenever `COMPOSE_PROJECT_NAME` was set, touching a different, empty, auto-created volume instead of the live ledger with no error. Now resolves the actual name from `docker compose config` at runtime.
- The container would boot with `TZ` set to an invalid value (e.g. a typo) and silently behave as UTC — reintroducing the exact bug this release fixes. `TZ` is now validated as a real IANA zone at boot, not just checked for non-empty.

_Re-pointing a SimpleFIN account link no longer crashes the next sync — and the database migration that made that possible was hardened after it turned out to crash on any real database, not just an empty dev one._

### Fixed
- **Re-linking a SimpleFIN account to a different feed no longer crashes the next sync.** Previously, un-linking or re-pointing an account's feed kept its old rows tagged with the feed's `external_id`, so the next sync collided with a unique-index constraint and aborted. `setAccountLink` now clears those tags when a link changes, and reports how many rows it touched.
  - This does **not** fully prevent double-counted transactions if a different account later claims the same feed — the app's duplicate-detection is scoped per account by design, so it can't see rows that moved to a different one. The warning now says so explicitly instead of promising protection it can't deliver; tracked as a follow-up in `TODOS.md`.
- **A batch's stored label no longer holds a fake filename.** Sync batches used to store a synthetic string like `"simplefin 2026-09-02 17:00Z"` in a field meant for real uploaded filenames. `import_batches.filename` is now a nullable `label` — CSV imports still record the real filename, and sync batches leave it blank, with the display computed from the batch's source and time instead.
- **Database migrations no longer risk failing on a real database.** The migration above needed a full table rebuild (SQLite can't relax a `NOT NULL` column any other way), which turned out to crash with a foreign-key error the moment the database had any real imported data — invisible in local dev because an empty database never hits the failure path. `pnpm db:migrate` now runs through a small custom script that disables foreign-key enforcement for the duration of the migration instead of relying on `drizzle-kit migrate`'s default connection handling, which can't do that safely.

## [0.8.2] - 2026-09-02

_Closes the known issue recorded in 0.8.1: CSV import now actually checks the snapshot it takes before trusting it as a rollback point._

### Fixed
- **CSV import no longer trusts an unverified database snapshot.** `commitImport` now checks the `consistent` flag `createSnapshot` returns, matching the check `/sync` already had. If the pre-import snapshot degrades to a plain file copy (which can produce a file that won't open at all if restored), the import still completes — it isn't blocked — but a warning is now recorded on the batch and shown on the import success page, so it's visible instead of silently assumed to be a working rollback.
- The warning is persisted on the batch row (`import_batches.snapshot_warning`), not just shown once right after import — it stays visible on that batch's success page on any later visit, and never touches the URL.
- `/sync` now persists its own degraded-snapshot warning the same way. It already checked `consistent`, but only ever surfaced the warning transiently through the sync page's action state — the batch row itself was left with `snapshot_warning` always `NULL`, which made the DB an unreliable record for any SimpleFIN-sourced batch.

## [0.8.1] - 2026-09-02

_Planning only — the app itself is unchanged and every one of the 402 tests still passes. This release adds the reviewed plan for running my_money_manager in a container and moving it to Postgres, staged as two separate PRs so the ledger is never protected by an undefined safety net. It also records a real bug the review turned up in code that already ships._

### Added
- **Dockerize + Postgres plan** (`docs/plans/dockerize-postgres.md`) — the full design for PR1 (containerize on SQLite) and PR2 (migrate to Postgres), with 20 implementation tasks, 23 required tests, and 24 tracked failure modes. Staged deliberately: PR1 leaves the app better off even if PR2 never happens, and the snapshot/rollback story is never undefined at the same time as the container story.
- **Two follow-ups recorded in `TODOS.md`** — reaching the app from a phone or a NAS (the reason Postgres is in the plan at all), and a `/budget` query rewrite that closes itself if a measurement comes in under 150ms.

### Known issues
- Nothing in shipped code changed this release, but one existing defect is now written down rather than unknown: **CSV import records a database snapshot it never verifies.** `createSnapshot` reports `consistent: false` when it falls back to a plain copy, which can produce a file that will not open at all. `/sync` checks that flag; CSV import does not, so an import can complete believing it has a rollback that would fail at the moment it is needed. Tracked as a P0 in `TODOS.md` and scheduled as the first task of PR1 (T6a).

## [0.8.0] - 2026-09-02

_Transactions now pull themselves in. Link your Star One accounts once and `/sync` fetches posted transactions straight from the bank behind a database snapshot you can undo — no weekly CSV download, no sign-in. Balances are checked against the bank's own figure on every visit, so a missing or duplicated row shows up as drift instead of hiding. CSV import is untouched and stays the only way to load history older than 45 days._

### Added
- **`/sync` page** — link each local account to a Star One account, pull posted transactions on demand, and see what landed. Writes straight to the ledger; no preview step.
- **Undo last sync** — removes the batch's transactions and the batch itself without stopping the dev server. The pre-write database snapshot stays as the escape hatch for anything undo can't reach.
- **Balance check** — the bank's own balance against the one this ledger computes, with the difference called out when they disagree. Available balance is shown separately, which is where pending card holds appear.
- **Transfers needing review** — when a same-day, same-amount transfer genuinely can't be resolved by counting, it asks instead of guessing. On real data this is roughly one day per quarter. Note the UI counts *buckets*, which are emitted per account-pair direction, so a single undecidable day can show as two entries.
- **Automatic transfer matching for feed rows** (`src/lib/simplefin/matchTransfers.ts`) — the CSV matcher keys on Star One's sequential transaction number, which the feed doesn't carry, so this replaces it with a counting argument over `(date, |amount|)` buckets, filtered within each bucket to opposite signs across different accounts. 56 of 58 pairs link themselves on a real 90-day pull; the one undecidable day admits two more. A pair spanning both sources only auto-links when the memo corroborates it — otherwise the CSV transaction-number matcher, which is a stronger signal and already declined that row, would be silently overridden by a same-day coincidence.
- **Pending rows from the feed are refused, not written** — sync never requests them and Star One returns none, but if one ever arrived it could not be updated when it posted, so the pre-authorisation amount would be frozen and the posted row added alongside it. They are now skipped and reported instead.
- **Unpair a transfer** — a "Linked transfers" list on `/sync` with a "Not a transfer" button. Auto-linking excludes both rows from every spending view, so this is the way back out when a same-day, same-amount coincidence gets paired by mistake.
- **Merchant names from the feed** (`drizzle/0008_naive_zeigeist.sql`) — the bank's cleaned payee ("Save Mart") is stored alongside the raw description. Categorization still matches on the raw form, so existing rules keep working.
- **`pnpm simplefin:claim`** — one-time exchange of a SimpleFIN setup token for an access URL, written to `.env.local` with owner-only permissions.
- **`pnpm simplefin:sample`** — dumps a live account payload to `.context/` for inspection.

### Changed
- **Duplicate detection now understands two sources** (`drizzle/0007_unique_lily_hollister.sql`) — feed rows dedupe on the bank's own transaction id, enforced by a database index. Because the feed re-sends days already imported from CSV, rows are also compared on content, counted rather than matched, so two genuinely identical same-day purchases both survive.
- **Sidebar** — added a Sync tab above Import.

### Fixed
- **Pre-import snapshots could be unreadable, not just incomplete.** The database runs in WAL mode, so committed writes can live in a side file that a plain copy missed. Folding the log in first with `PRAGMA wal_checkpoint` is not enough: it does not fail loudly when another connection holds a read — it reports "busy" in a return value the old code discarded — and the resulting copy could fail to open at all with "database disk image is malformed". Snapshots are now written with `VACUUM INTO`, which is consistent by construction, and a snapshot that has to fall back to a plain copy says so. This affects CSV import too, not just sync.
- **Old snapshots were deleted before the write they protect.** A failed import had already evicted the oldest snapshot to make room for a useless one, so repeated failures quietly ate the rollback history. Pruning now happens only after a write commits, and a failure to delete an old snapshot no longer aborts an import that already succeeded.
- **`.context/` was not ignored by the committed `.gitignore`** — it held real transaction data and was excluded only by a local, unshared git setting, so a fresh clone would have left it exposed to `git add`.

## [0.7.2] - 2026-04-21

_Subscriptions can now be categorized in one click. New auto-categorize actions on the subscriptions page tag detected recurring charges as Subscriptions and create a remember-this-merchant rule. Twenty-three category rules for common streaming and software services seed automatically so new imports land in the right bucket from day one._

### Added
- **"Categorize" button per subscription row** — tags all uncategorized transactions from that merchant as Subscriptions and saves an exact rule for future imports.
- **"Categorize all" button** — bulk-categorizes every active detected subscription at once.
- **Subscription service category rules** (`drizzle/0006_subscription_rules.sql`) — 23 `contains` rules at priority 30 for Netflix, Spotify, Hulu, Disney+, Amazon Prime, YouTube Premium, HBO Max, Peacock, Paramount+, Adobe, Dropbox, GitHub, Zoom, Crunchyroll, iCloud, Google One, Microsoft 365, Office 365, Apple One, ESPN+, and Audible. Priority 30 means user-created rules (priority 50) always win.

### Fixed
- **Test suite compatibility** — rule-count assertions now filter to `matchType = 'exact'` so the seeded `contains` rules from this migration don't inflate counts.

## [0.7.1] - 2026-04-21

_Integration checkpoint polish. Categorized items on `/categorize` and `/transactions` now fade to 50% opacity so the uncategorized work is obvious at a glance. A new Subscriptions category joins the spending list._

### Added
- **Subscriptions category** (`drizzle/0005_subscriptions_category.sql`): generic catch-all for subscription-based charges that don't fit the more specific Streaming/Software/News categories.

### Changed
- **`/categorize`** — merchant rows with an existing rule fade to 50% opacity (`opacity-50 hover:opacity-100`). The uncategorized work rises to the top visually.
- **`/transactions`** — already-categorized rows fade to 50% opacity, restoring on hover. Uncategorized rows stay full-brightness so the backlog is obvious.

## [0.7.0] - 2026-04-20

_Weekend 5 — Goals and trend chart ship. You can now create savings goals, track contributions month-by-month, and see a 6-month spending breakdown by category directly on the dashboard. Recharts enters the stack, client-side only, rendering a stacked bar chart from server-fetched data._

### Added
- **`/goals` page**: server-rendered savings goals list. Each goal card shows name, progress bar (contributed − withdrawn / target), percentage complete, remaining amount, and a native `<details>` monthly contribution breakdown. Empty state prompts creating the first goal.
- **Create goal form**: inline `<form action>` on `/goals` — name, target ($), carryover policy (none/rollover/reset). Validates via Zod (`validateGoalInput.ts`), inserts a category row with `is_savings_goal=true`.
- **Edit target**: inline `<details>` disclosure form on each goal card — updates `target_cents` in place, page rerenders. No redirect needed.
- **`loadGoals`** (`src/lib/goals/loadGoals.ts`): three synchronous queries — savings goal categories (LEFT JOIN budget_periods for contributions), withdrawal aggregation (negative transactions, transfer-excluded), monthly breakdown. Returns `GoalsView` with per-goal progress and totals strip.
- **`validateGoalInput`** (`src/lib/goals/validateGoalInput.ts`): Zod schemas for create and update-target, following the `safeParse` pattern used throughout the project.
- **`NotASavingsGoalError`** added to `src/lib/categoryErrors.ts`.
- **Goals nav link** in Spine enabled (`/goals`); "Coming Weekend 5" tooltip removed.
- **Spending trend chart** on dashboard (`/`): stacked bar chart showing last 6 months of categorized spending by top-level category group (excludes transfers, savings goals, income). Sits between MonthlySummary and the backlog tile.
- **`loadMonthlyTrends`** (`src/lib/trends/loadMonthlyTrends.ts`): server-side query — two SQL calls (category hierarchy map + spend aggregation with `strftime`), post-processed in TypeScript into a `TrendData` shape safe to cross the RSC→Client boundary.
- **`TrendChart`** (`src/components/ledger/trend-chart.tsx`): `"use client"` Recharts `BarChart` — stacked bars per month, CSS var chart colors, custom tooltip using `formatCents`, empty state when no data. `recharts@3.8.1` added to dependencies.

## [0.6.0] - 2026-04-20

_Weekend 4 — Subscriptions tracker ships. The app now automatically detects recurring charges from your transaction history using a simple, deliberate heuristic: 3+ transactions for the same merchant with consistent monthly (25–35 day) or quarterly (85–95 day) intervals and amounts within MAX($0.50, 2% of median). No manual entry, no separate subscription ledger — detection runs from the data you've already imported._

### Added
- **`/subscriptions` page**: server-rendered list of detected recurring charges with cadence (monthly/quarterly), median charge amount, first-seen date, and next expected charge date. Empty state prompts importing 3+ months of history.
- **Dismiss/Restore**: one toggle per merchant group — "Not a subscription" moves it to a dismissed section; Restore brings it back. Implemented via `dismissSubscriptionAction` and `restoreSubscriptionAction` (Zod-validated server actions).
- **`subscription_dismissals` table** (`drizzle/0004_chubby_the_spike.sql`): stores dismissed merchants with a unique index; applied via migration.
- **`detectSubscriptions`** (`src/lib/subscriptions/detectSubscriptions.ts`): pure detection function, 14 Vitest tests covering monthly, quarterly, irregular, amount tolerance, empty input, and the 2%-vs-$0.50 tolerance boundary.
- **`loadSubscriptions`** (`src/lib/subscriptions/loadSubscriptions.ts`): queries non-transfer, non-pending transactions (excluding `DEPOSIT` rows and `POS \d+` refund memos per CLAUDE.md exclusion rules), runs detection, splits results into active and dismissed.
- Spine nav Subscriptions link enabled; Goals remains "Coming Weekend 5".

### Fixed
- **Subscription detection exclusions**: `loadSubscriptions` now filters out `raw_description = 'DEPOSIT'` and `raw_memo LIKE 'POS %'` rows before detection, per CLAUDE.md exclusion rules (these are deposits and refunds, never recurring charges).

## [0.5.2] - 2026-04-20

### Fixed
- **Rule upsert race (TOCTOU)**: `createOrUpdateRule` previously did a select-then-insert that two concurrent writes could both win. Now a single `INSERT ... ON CONFLICT (match_type, match_value) DO UPDATE` backed by a new unique index on `category_rules(match_type, match_value)` closes the window entirely. Requires migration `0003_flimsy_micromacro.sql`.
- **Undo bulk-categorize deletes wrong rule**: when no prior rule existed, `undoBulkCategorize` deleted by `(match_type, match_value, category_id)`. A concurrent bulk-categorize could cause it to delete a rule it didn't create. Now deletes by the primary key (`insertedRuleId`) captured at bulk time.
- **ReDoS on regex rules**: `applyRuleAtImport` compiled user-authored regex patterns without a length guard. Patterns longer than 200 characters now short-circuit to non-matching before the regex engine sees them.

## [0.5.1] - 2026-04-20

### Added
- **43 spending categories** via `drizzle/0002_more_categories.sql`: Rent, Home Maintenance, Renter's Insurance, Car Insurance, Car Maintenance, Parking, Rideshare, Public Transit, Coffee, Fast Food, Alcohol, Internet, Phone, Electric, Water, Doctor, Dentist, Pharmacy, Health Insurance, Gym, Haircut, Clothing, Movies & Events, Hobbies, Streaming, Books & Music, Amazon, Electronics, Home Goods, Bank Fees, ATM, Gifts, Charity, Paycheck, Interest, Reimbursement, Hotels, Flights, Vacation, Childcare, School, Software, News & Magazines. Total category count: 49 (up from 6).

## [0.5.0] - 2026-04-20

_Weekend 3 — Ledger Paper design system lands. The app now has a full visual identity: warm paper-tone surfaces, Newsreader serif for headings, Geist Mono for money, a Spine navigation rail that stays on every page, and a dashboard command-center that shows account balances, monthly budget summary, and the uncategorized backlog at a glance. Light and dark themes switch without flash. The design tokens and nav prototype live in `design_handoff_nav_and_design_system/` as live HTML specimens._

### Added
- **Dashboard** (`src/app/page.tsx`): account balance tiles per account, total balance row, monthly summary strip (Allocated / Effective / Spent / Remaining), uncategorized backlog tile, quick links to `/budget` and `/transactions`. Empty state shows `∅` with a link to import.
- **Spine navigation rail** (`src/components/ledger/spine*.tsx`): fixed left rail with app branding, active-tab highlight, month picker (context-aware: follows current month on most pages, follows the URL on `/budget`), account balance peek with running total, and an amber count chip for the uncategorized backlog.
- **Ledger Paper design system** (`src/app/globals.css`, `design_handoff_nav_and_design_system/`): full token set — paper surfaces (`--paper-0/1/2/3/4`), ink text (`--ink-1/2/3/4`), semantic money colors (`--money-pos/neg/zero`), Terracotta primary, Amber backlog, Ledger green, Redbrown destructive. Radii, shadow, and spacing cadence locked. Tailwind utilities wired to all tokens.
- **Light / dark theme** (`src/components/ledger/theme-toggle.tsx`, `theme-init.tsx`): system-preference default, FOITD-free inline script in `<head>` so there is no flash on reload.
- **`EnvelopeCard`** (`src/components/ledger/envelope-card.tsx`): signature card component for budget envelope display — envelope name, allocated / spent / remaining cells with correct money coloring, over-budget destructive state.
- **`loadAccountBalances`** (`src/lib/accounts/loadAccountBalances.ts`): authoritative per-account balance using the formula from CLAUDE.md (`starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`).
- **Design handoff** (`design_handoff_nav_and_design_system/`): live HTML specimens for the design system and nav prototype, plus a `README.md` capturing all visual decisions.
- **Zod validation on all Server Actions** (`src/app/import/actions.ts`, `src/app/categorize/actions.ts`): `validateCreateAccountInput`, `validateUploadCsvInput`, `validateImportIdInput`, `validateBulkCategorizeSnapshot` replace ad-hoc checks. All validators ship with full test suites (124 new tests across 4 files).
- shadcn primitives: `src/components/ui/table.tsx`, `combobox.tsx`, `input-group.tsx`, `input.tsx`, `textarea.tsx`.
- Shared `CategoryCombobox` wrapper (`src/components/CategoryCombobox.tsx`) used by both categorize and transactions inline pickers.
- CSV fixture files for testing: `src/lib/__fixtures__/sample-checking.csv`, `sample-savings.csv`.
- Node 24 engine lock (`.nvmrc`, `engines` field in `package.json`, `.npmrc` with `engine-strict=true`).

### Changed
- **Layout** (`src/app/layout.tsx`): Newsreader + Geist + Geist Mono loaded via `next/font`, Spine rail wired into the shell, `ThemeInit` script in `<head>`.
- **`BacklogBanner`**: updated to use Amber design tokens; accepts `variant="budget"` prop.
- `/budget` page: raw `<table>` → shadcn `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` primitives.
- `/categorize` and `/transactions` inline pickers: native `<select>` → searchable `CategoryCombobox` (Base UI Combobox variant).
- **`findTransferPairs`** (`src/lib/transferPair.ts`): buckets candidates by `(date, |amount|)` — same-day scan drops from O(N²) to O(N).

### Fixed
- `parseCsv` test fixture aligned with actual Star One CSV format.

## [0.4.1] - 2026-04-19

_Weekend 2 polish — transfer-pair matcher now scales linearly on same-day imports. Previously, every unpaired row for a given date was compared against every other unpaired row for that date; with N rows sharing one date, that's O(N²) work on each import. Now candidates are bucketed by `(date, |amount|)` before the pairing scan, so two rows only enter the inner comparison if they already agree on both. Real-world same-day row counts stay in the single digits, but the ceiling is no longer O(N²)._

_Also: scope-guardrail cleanup — the "shadcn components locked" item in TODOS.md is now honored. `/budget` renders through the shadcn `Table` primitive (still server-rendered, still no TanStack). Both inline category pickers on `/categorize` and `/transactions` swap native `<select>` for a searchable shadcn/Base UI `Combobox` via a shared `CategoryCombobox` wrapper that still submits the selected id via the FormData path, so every existing Server Action is untouched._

### Changed
- **`findTransferPairs`** (`src/lib/transferPair.ts`): buckets candidates by `(date, |amount|)` instead of just `date`. Same-day scan drops from O(N²) to O(N) across buckets of size 2–3. Zero-amount filter moved to the bucketing step (same observable behavior — a zero-amount row cannot form a pair with an opposite-sign counterpart).
- Removed now-redundant in-loop checks: `Math.abs(a.amountCents) !== Math.abs(b.amountCents)` and `a.amountCents === 0` are invariants of the bucket, not the pair.
- `src/app/budget/[year]/[month]/page.tsx` — raw `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<th>` / `<td>` → shadcn `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell`. Track A's "no TanStack" decision preserved; this is the shadcn primitive, not DataTable. The `MobileCards` stacked-cards path (sm:hidden) is unchanged.
- `src/app/categorize/_merchant-row.tsx` — native `<select>` → `CategoryCombobox`. Same form, same action, same Sonner Undo toast.
- `src/app/transactions/_transaction-row.tsx` — same swap as above. iOS autozoom fix (`text-base sm:text-sm`) now inherited from the shared wrapper's ComboboxInput.
- `TODOS.md` — Weekend 2 scope-guardrails: "shadcn components locked" box is now `[x]` with a note recording that DataTable was intentionally ruled out in favor of the `Table` primitive; the mobile-cards + parens-for-negatives boxes marked `[x]` with anchor references.

### Added
- Scaling test: 500 unrelated same-day rows + 1 real pair → 1 pair found, no noise.
- Zero-amount test: two zero-amount rows across accounts produce no pairs.
- **shadcn primitives** (added via `shadcn add`, base-nova style, Base UI variant):
  - `src/components/ui/table.tsx` — used on `/budget/[year]/[month]`.
  - `src/components/ui/combobox.tsx` — used by the shared `CategoryCombobox` wrapper.
  - `src/components/ui/input-group.tsx`, `input.tsx`, `textarea.tsx` — pulled in as Combobox dependencies.
- **Shared picker** (`src/components/CategoryCombobox.tsx`):
  - Wraps Base UI's Combobox with the `{value: string, label: string}` shape that both inline categorize rows need. `value={value || null}` so a cleared selection round-trips, `itemToStringLabel` maps id → category name for the input display, `required` / `disabled` pass-through. Name-bearing hidden input keeps FormData submission working unchanged.

### Notes
- All 286 tests pass (27 files). No behavior change for any existing fixture. TODOS.md P2 closed.
- Shipped via `/ship`. Coverage scope unchanged from v0.4.0: pure functional + DB-query tier (284 tests across 27 files, identical to v0.4.0). UI components not tested; the three touched pages verified by live browser smoke test including an end-to-end category select → submit → DB write on a seeded row.
- One pre-landing review fix applied inline before commit: `CategoryCombobox` was passing the full `{value, label}` object as `ComboboxItem.value`, which made Base UI fire `onValueChange` with the object. The wrapper's `typeof next === "string" ? next : ""` guard silently reset selection to empty on every click, so Save stayed disabled. Caught during browser smoke test (not the PLAN source's claim that "browser smoke: all render without console errors"). Fixed by passing `item.value` (string id) as `ComboboxItem.value` and adding `itemToStringLabel` so Base UI resolves the id back to the display label in the input.

### Verified
- Vitest suite: **286 tests across 27 files** — all green on Node 24.
- `tsc --noEmit` clean.
- `pnpm lint` clean (only pre-existing `@typescript-eslint/no-unused-vars` warning in `loadMonthView.test.ts`, unrelated).
- Live browser smoke on seeded test transaction:
  - `/transactions`: open combobox → select "Groceries" → hidden `categoryId` input holds `"2"`, visible input displays `"Groceries"`, Save enables, click Save → Sonner toast "Categorized 1 row as Groceries." + 10s Undo → DB confirms `category_id=2` on the row.
  - `/categorize`: same flow with "Dining" → hidden value `"4"`, visible label `"Dining"`, Save enables.
  - `/budget/[year]/[month]`: table renders via shadcn primitive, no console errors at 390px (cards) or 1280px (table).

### Fixed (pre-landing review)
- `CategoryCombobox` was silently discarding every selection because `ComboboxItem` received the `{value, label}` item object while the wrapper only accepted string values through `onValueChange`. Base UI's `store.state.handleSelection(event, itemValue)` fires `onValueChange` with whatever `ComboboxItem.value` is set to (confirmed by reading `@base-ui/react` internals at `esm/combobox/root/AriaCombobox.js:533` and `esm/combobox/item/ComboboxItem.js:126`), so the wrapper's `typeof next === "string" ? next : ""` fallback always evaluated to `""` and the submit button stayed disabled on every click. Fixed by (a) passing `item.value` (string id) to `ComboboxItem`, and (b) adding `itemToStringLabel={(v) => labelFor(String(v))}` on the Combobox root so the input shows the category name instead of the raw id. Hidden-input serialization via `stringifyAsValue` still submits the id unchanged — the FormData contract with every Server Action is preserved.

### Project decisions (non-code, worth logging)
- **Shared `CategoryCombobox` over duplicating the Combobox boilerplate twice**: the `/categorize` and `/transactions` pickers share the exact same leaf-category set and the same FormData key (`categoryId`), so a single wrapper keeps the Base UI wiring (controlled `value`, `items`, `itemToStringLabel`, cleared-selection `null` coercion) in one file. Also makes the pre-landing fix a one-line change across both call sites.
- **Table primitive, not DataTable**: the plan called out "no TanStack" and Track A shipped its own server-rendered table. Swapping to shadcn `Table` keeps that decision while still giving us consistent borders, spacing, and hover tokens.

### Known follow-ups (tracked in TODOS.md)
- Carry-forwards from earlier ships (P2 TOCTOU on `createOrUpdateRule`, P3 ReDoS on user-authored regex rules, P3 undo-rule-delete edge case, P2 `linkTransferPairs` O(n²)-within-day) are unchanged by this ship.

## [0.4.0] - 2026-04-17

_Weekend 2 Track B complete — `/transactions` is live. You now have a filtered, paginated list of every non-transfer-paired transaction with an inline category picker, "Remember for all [merchant]" to silently upsert the exact rule, and "Apply to past [merchant]" to fan the chosen category out to every uncategorized sibling. Each Save fires a 10s Sonner Undo that atomically reverses the target row, the applyToPast hits, AND any rule change, all while preserving rows the user has re-touched since. `/budget` and `/categorize` now share the same rollover-invalidation story across the Track A/B/C + D surfaces._

### Notes
- Shipped via `/ship`. Coverage scope unchanged from v0.3.0: pure functional + DB-query tier (225 tests across 22 files, +41 over v0.3.0). UI components not tested; `/transactions` verified by live browser smoke test.
- Three pre-landing review fixes applied inline before commit: `undoCategorizeTransactionAction` is now Zod-gated against a new `categorizeTransactionSnapshotSchema` (CLAUDE.md rule: every Server Action must validate at the boundary); `categorizeTransaction`'s parent + savings-goal + category-exists preconditions now run inside the same `db.transaction(...)` as the writes (closes a narrow race window); `loadTransactions` wraps its `COUNT(*)` + paginated SELECT in a read transaction so pagination math cannot drift under a concurrent categorize write.
- Known cosmetic: after "Apply to past" fires, sibling rows on the same page keep their "Uncategorized" badge until reload — each row owns its own `useState` seeded at mount. The live backlog counter is correct. Tracked separately.

### Added
- **`/transactions` page** (`src/app/transactions/page.tsx`):
  - Server Component. `await connection()` + Zod `searchParamsSchema` gated by `notFound()` on tamper (matches `/budget/[year]/[month]`).
  - Filter params: `categoryId=<leafId>|none`, optional `year`+`month` (both-or-neither), `page`, `pageSize` (clamped 1–500).
  - Entry points: from a `/budget` row (drilldown) or standalone (no filter, newest first).
- **Transaction query layer** (`src/lib/categorize/loadTransactions.ts`):
  - Paginated read; transfer-paired rows excluded unconditionally via `isNull(transferPairId)`.
  - Sort: `date DESC, id DESC` (stable tiebreaker). Joins: `leftJoin(categories)` for display name, `innerJoin(accounts)` for account name.
- **Single-row categorize pipeline** (`src/lib/categorize/categorizeTransaction.ts`):
  - Server-trust: `normalizedMerchant` is read from the target row, NOT from FormData. A tampered applyToPast can't broadcast across merchants.
  - Dual-invalidation pattern: new category invalidated starting at `earliest(target.date, earliestApplyToPastDate)` month; old category invalidated at `target.date` month (only when the row had a prior category).
  - applyToPast scope: `categoryId IS NULL AND id != target.id AND transferPairId IS NULL`. Matches Track C semantics.
- **Undo** (`src/lib/categorize/undoCategorizeTransaction.ts`):
  - Snapshot-based reverse inside a single `db.transaction`. Re-touch guard: both target + applyToPast UPDATEs filter `WHERE categoryId = newCategoryId`, so rows the user has since re-categorized are preserved.
  - 3-case rule rollback (no prior rule → delete, prior → full restore). Mirrors Track C's rule rollback.
- **Zod validators**:
  - `src/lib/categorize/validateCategorizeTransactionInput.ts` — FormData coercion, strings → numbers/booleans.
  - `src/lib/categorize/validateCategorizeTransactionSnapshot.ts` — new this ship, guards `undoCategorizeTransactionAction` against client-supplied snapshot payloads.
- **Client islands**:
  - `src/app/transactions/_transactions-ui.tsx` — sticky `aria-live` backlog strip, empty state, pagination.
  - `src/app/transactions/_transaction-row.tsx` — inline select + Remember/Apply-to-past checkboxes + Sonner 10s Undo toast. iOS autozoom fix (`text-base sm:text-sm`) on the select.
- **Server Actions** (`src/app/transactions/actions.ts`):
  - `categorizeTransactionAction` — Zod-gates input, returns snapshot + updatedCount + categoryName.
  - `undoCategorizeTransactionAction` — Zod-gates the snapshot, idempotent reverse. Both revalidate `/transactions`, `/categorize`, and the `/budget` layout.
- **Mandatory regression guard** (`src/lib/categorize/categorizeTransaction.regression.test.ts`):
  - The Track B review's must-pass test: categorize flips `/budget` MTD on the new category, invalidates May's rollover cache, and Undo cleanly reverses both plus the target row.
- **Shared helper** (`src/lib/budget/monthOfIso.ts`):
  - Extracted `parseIsoMonth(dateIso)` out of `bulkCategorize` so `categorizeTransaction` uses the same primitive.

### Verified
- Vitest suite: **225 tests across 22 files**, all green on Node 24. (+41 over v0.3.0: core/undo/validator/loader/regression/action suites.)
- `tsc --noEmit` clean.
- Live browser: seeded 3 uncategorized SAFEWAY rows, categorized one with "Apply to past" ticked → 2 additional rows flipped, Sonner toast shown with Undo, Undo restored all three rows + cleared the rule.

### Fixed (pre-landing review)
- `undoCategorizeTransactionAction` was accepting the snapshot without validation. A crafted payload could have flipped any row matching a chosen category back to a caller-supplied prior, and forced `invalidateForwardRollover` on arbitrary (category, year, month) combos. Now Zod-validated against `categorizeTransactionSnapshotSchema` before the reverse fires.
- `categorizeTransaction`'s `CategoryNotFoundError` / `SavingsGoalCategoryError` / `ParentAllocationError` pre-flight checks were SELECTing outside the write transaction. Between those reads and the UPDATE, a concurrent write could have flipped the category shape. Moved both lookups inside the `db.transaction(...)`.
- `loadTransactions` was running `COUNT(*)` and the paginated SELECT in separate DB calls. A concurrent categorize between them could produce off-by-one `totalPages` / `firstRow` / `lastRow` relative to the returned rows. Both queries now share one read transaction.

### Project decisions (non-code, worth logging)
- **Server-trust on merchant**: the target row's stored `normalized_merchant` is the source of truth for Apply-to-past. Never read from FormData. Prevents cross-merchant fanout via a tampered form.
- **Transfer-paired rows stay hidden on `/transactions`**: they're owned by the transfer machinery. `loadTransactions` filters them out server-side and `categorizeTransaction` additionally refuses them as defense-in-depth.
- **Undo is idempotent by design**: a user who re-categorizes a row between Save and Undo keeps their new choice. Both target and applyToPast UPDATEs filter on the snapshot's `newCategoryId`.
- **Re-categorize support**: a row that already has a category can be flipped to a different leaf. Dual-invalidation fires on both the old and new category's month chains.

### Known follow-ups (tracked in TODOS.md)
- **P0** — `parseCsv.test.ts` fails at test-load time with ENOENT on a gitignored fixture path. Pre-existing, not caused by this ship. Either bundle a safe fixture or guard the test with `describe.skipIf`.
- **Cosmetic** — sibling rows hit by Apply-to-past keep their "Uncategorized" badge until reload (each row form owns its `useState` seeded at mount). Backlog counter is correct; server round-trip would fix it but cost an extra render. Deferred.

## [0.3.0] - 2026-04-17

_Weekend 2 complete — envelope budgeting is live. `/budget` shows per-category allocations with rollover math carried forward, `/categorize` flips every uncategorized row for a merchant onto a category in one click (with 10s Undo), and the rule engine silently auto-categorizes matching rows at import. All money still flows through signed integer `amount_cents`; the envelope math is lazy-persisted on first Allocate write and invalidated forward whenever a prior month changes._

### Notes
- Shipped via `/ship`. Coverage scope per CLAUDE.md: pure functional + DB-query tier (184 tests across 17 files). UI + Server Actions verified by live browser smoke test. No UI component tests.
- Three pre-landing review fixes applied inline: SQL-side rule filter on `loadMerchantGroups` (pushed `.filter()` into an `inArray` clause), dropped useless `journal_mode=WAL` pragma on the `:memory:` test helper, and `/categorize` actions now `revalidatePath('/budget', 'layout')` so month pages refresh after a bulk flip.

### Added
- **Envelope math** (`src/lib/budget.ts`):
  - `getEffectiveAllocation({ persist })` — reads `effective_allocation_cents` cache; recomputes from carryover if missing. `persist: false` for read paths, `persist: true` for writes.
  - `invalidateForwardRollover` — clears cached `effective_allocation_cents` on every `budget_periods` row at or after a given (category, year, month). Fires on allocation edits, transaction categorize/re-categorize, and `carryover_policy` changes.
  - `computeMtdSpent` — DB-backed signed-sum of `amount_cents` for a category within a month, refunds net against spend.
- **Rule engine** (`src/lib/rules.ts`): `applyRuleAtImport` + `createOrUpdateRule` (idempotent upsert). **Correction:** this entry originally described `applyRuleAtImport` as auto-categorizing during commit. It did not — the function was written and tested but never called from either write path, so every import landed uncategorized until that was wired up (see Unreleased).
- **Track A — `/budget`** (envelope cards):
  - `/budget/page.tsx` — `await connection()` + redirect to current month.
  - `/budget/[year]/[month]/page.tsx` — Zod-parse params, `notFound()` on invalid.
  - `src/lib/budget/loadMonthView.ts` — query layer for per-category rows (allocation, MTD spent, backlog count, parent grouping, synthetic 'Ungrouped' section).
  - `src/lib/budget/validateAllocateInput.ts` + `src/app/budget/actions.ts` — `upsertBudgetAllocationAction` (single-field Allocate, Zod-gated, `Number.isFinite` dollars guard, tx-wrapped with forward-invalidation).
  - Uncategorized backlog tile + "Categorize backlog" CTA linking to `/categorize`.
- **Track C — `/categorize`** (bulk-by-merchant):
  - `/categorize/page.tsx` — server component, `await connection()`, groups uncategorized non-transfer rows by `normalized_merchant`.
  - `src/lib/categorize/loadMerchantGroups.ts` — count + signed-sum per merchant, existing-rule badge lookup (SQL-filtered via `inArray`).
  - `src/lib/categorize/bulkCategorize.ts` — atomic transaction: flip every NULL-category row for the merchant, optionally upsert the exact rule, compute earliest-date-month invalidation, return snapshot for Undo.
  - `src/lib/categorize/undoBulkCategorize.ts` — reverse via the snapshot; stale-row-safe (only resets rows still pointing at the snapshot category); 3-case rule rollback (insert-then-delete, same-target bump, different-target full restore).
  - `src/lib/categorize/validateBulkCategorizeInput.ts` — Zod validation with parent / savings-goal / unknown-category rejects.
  - `src/app/categorize/actions.ts` — `bulkCategorizeMerchantAction`, `undoBulkCategorizeAction`. Both invalidate `/categorize` + the `/budget` layout.
  - `_categorize-ui.tsx` + `_merchant-row.tsx` — client islands: live backlog counter (`aria-live`), Sonner 10s Undo toast.
- **Shared primitives**:
  - `src/lib/categoryErrors.ts` — `ParentCategoryError`, `SavingsGoalCategoryError`, `UnknownCategoryError`.
  - `src/lib/categories.ts` — `listLeafCategories`, `classifyCategory`.
  - `src/app/_components/BacklogBanner.tsx` — shared banner, `variant: 'budget' | 'categorize'`.
- **Test helper** (`src/lib/test/db.ts`) — in-memory SQLite + full migration apply, used by every new test file.
- **Layout**: `<Toaster />` mounted in `src/app/layout.tsx` (Sonner).

### Verified
- Vitest suite: **184 tests across 17 files** — all green on Node 24.
- `tsc --noEmit` clean.
- `next build` emits `/categorize` and `/budget/[year]/[month]` as dynamic routes.
- Live browser smoke: bulk-flip a 30-row merchant group onto Groceries, Undo within 10s restores rows + rule, re-flip + let toast expire keeps rule.

### Fixed (pre-landing review)
- `loadMerchantGroups` was pulling every exact-match rule then filtering in JS. Moved the merchant filter into the SQL `WHERE` via `inArray`. Wins at scale; trivial at 30–60 groups but free to fix.
- `createTestDb` called `journal_mode=WAL` on `:memory:`, which is a silent no-op. Removed.
- `bulkCategorizeMerchantAction` + `undoBulkCategorizeAction` now `revalidatePath('/budget', 'layout')` so the current month page refreshes after a bulk flip. Previously only `/categorize` was invalidated.

### Project decisions (non-code, worth logging)
- Envelope cache (`effective_allocation_cents`) is **lazy-persisted**: `/budget` page reads without writing; the first `upsertBudgetAllocationAction` persists the chain up to the edited month. Keeps GETs side-effect-free.
- Forward-invalidation is **month-granular**, not day-granular — carryover math is monthly so invalidating at day precision would be noise.
- Bulk-categorize **excludes transfer-paired rows** from both the read (`loadMerchantGroups`) and the write (`bulkCategorize`) — the transfer machinery stays the single owner of those rows.
- Rule rollback on Undo covers all 3 cases so the history of what-was-there-before is fully restored; anything else is a foot-gun.

### Known follow-ups (tracked in TODOS.md)
- **P2** — `createOrUpdateRule` TOCTOU: select-then-insert without a unique index on `(match_type, match_value)`. Single-user local app so racing is unlikely, but a unique index + `ON CONFLICT DO UPDATE` is the correct fix (schema change, deferred).
- **P3** — `undoBulkCategorize` deletes *any* exact-match rule for the merchant; in the overlapping-undo edge case this could remove a rule inserted by a later action. Filter by inserted rule id when available.
- **P3** — ReDoS on user-authored `regex`-type rules. Single-user, low severity.

## [0.2.0] - 2026-04-16

_Weekend 1 complete — CSV import pipeline is live end-to-end. You can now upload a Star One CU CSV (checking or savings), preview what's new vs. duplicate vs. pending, and commit to a local SQLite database that's snapshotted before every write. Transfer pairs between accounts are detected automatically (memo-independent, so overdraft mislabels don't throw it off)._

### Notes
- Shipped via `/ship`. Coverage scope per CLAUDE.md: pure functional tier only; UI + Server Actions verified by live browser smoke test (543-row commit).
- Docs fix: `CLAUDE.md` rule 3 updated to include `raw_memo` in the `import_row_hash` formula to match the code.

### Added
- Project scaffold: Next.js 16.2.4 (App Router, Turbopack) + TypeScript + Tailwind v4 + ESLint
- shadcn/ui initialized (base-nova style, Base UI primitives, neutral base color)
- Runtime deps: `better-sqlite3`, `drizzle-orm`
- Dev tooling: `drizzle-kit`, `vitest`, `@vitest/ui`, `@types/better-sqlite3`
- `drizzle.config.ts` pointing at `./data/money.db`
- `vitest.config.ts` with `@` path alias
- `.nvmrc` pinning Node 24
- Scripts: `test`, `test:watch`, `test:ui`, `db:generate`, `db:migrate`, `db:push`, `db:studio`
- Skeleton dirs: `data/`, `src/db/`, `src/lib/`, `drizzle/`
- `pnpm.onlyBuiltDependencies` allowlist for `better-sqlite3` + `esbuild` native builds
- Design artifacts in `.context/`: design deltas (Updates 1-5), CSV format notes for checking + savings
- In-repo `PLAN.md`, `TODOS.md`, `CHANGELOG.md`
- App-specific `CLAUDE.md` — paths, scripts, and load-bearing data-model rules
- First Drizzle migration (`drizzle/0000_*.sql`) with all six tables: `accounts`, `transactions`, `categories`, `category_rules`, `budget_periods`, `import_batches`
- `src/db/schema.ts` — Drizzle schema for all tables; enum-typed text columns; integer-cents money; ISO-date text columns; Unix-seconds timestamp columns; `import_row_hash` uniqueness on `(account_id, import_batch_id, import_row_hash)`
- `src/db/index.ts` — HMR-safe better-sqlite3 client. `globalThis`-cached handle, reopens on stale cache via `Proxy` get-trap
- `src/lib/normalize.ts` — merchant normalizer, 12 rules (8 checking + 4 savings), pure function
- `src/lib/hash.ts` — `computeImportRowHash(date|amountCents|rawDescription|rawMemo|rowIndex)` → sha1 hex
- `src/lib/parseCsv.ts` — Star One CU CSV parser. Handles both checking and savings memo variants; preserves CSV signs (no `Math.abs`, no description-based flips); extracts pending flag and check-number
- `src/lib/transferPair.ts` — memo-independent transfer-pair matcher (|txn±1|, same date, equal |amount|, opposite signs, different accounts)
- `src/lib/snapshot.ts` — pre-import DB snapshotting. Copies `data/money.db` → `data/money.db.pre-import-{timestamp}` and prunes beyond 10-snapshot retention
- `src/lib/importBatch.ts` — import orchestrator. `transformRow` (normalize+hash+card4), `buildPreview` (dedup-checks against existing `import_row_hash` for the account), `commitImport` (snapshot → `db.transaction` insert of batch + rows → post-commit `linkTransferPairs`)
- `src/lib/pendingImport.ts` — file-based stash for uploaded CSVs awaiting user confirmation. JSON under `data/.pending-imports/{uuid}.json`; UUID regex gate on reads; 24h expiry
- `src/app/import/page.tsx` — server component. Account list, upload form (shown only when accounts exist), create-account form
- `src/app/import/preview/[id]/page.tsx` — preview page. Stat cards (parsed/new/duplicates/pending/errors), error list, first 200 rows, confirm/cancel server-action buttons
- `src/app/import/success/[batchId]/page.tsx` — post-commit summary. Imported count, transfer pairs linked, snapshot path
- `src/app/import/actions.ts` — Server Actions: `createAccountAction`, `uploadCsvAction`, `confirmImportAction`, `cancelImportAction`
- `src/app/page.tsx` — root redirects to `/import`
- `src/app/layout.tsx` — title "my money manager", description "Local-first personal budgeting"
- `conductor.json` — setup/run hooks apply Drizzle migrations and start the dev server via `nvm use 24`

### Verified
- HMR smoke test passes: 10 consecutive HMR reloads, DB singleton stays connected
- Vitest suite: 45 tests across 6 files (hash, normalize, parseCsv, transferPair, snapshot, importBatch)
- `tsc --noEmit` clean
- End-to-end browser verification of the confirm flow: `/import` → upload → `/import/preview/{id}` → "Confirm import" click → Server Action commits 543 rows + writes snapshot → redirects to `/import/success/{batchId}`

### Fixed
- Circular `--font-sans: var(--font-sans)` in `globals.css` introduced by `shadcn init` — replaced with literal Geist font-family names so Tailwind v4's `@theme inline` resolves correctly at parse time

### Project decisions (non-code, worth logging)
- Star One CU overdraft pairs match by sequential Transaction Number (`N` / `N+1`), not by Memo — receiving-side memo is unreliable 80% of the time
- CSV `Amount Debit` already negative, `Amount Credit` positive and mutually exclusive — parser reads the right column; no `Math.abs` or sign flip
- Uploaded CSVs stash to disk as pending imports rather than being re-uploaded at confirm time. Keeps the confirm click idempotent and avoids re-parsing on the preview→confirm round-trip

### Ignored
- `/data/*.db`, `/data/*.db-journal`, `/data/*.db-wal`, `/data/*.db-shm`
- `/data/money.db.pre-import-*` (import batch snapshots)
- `/data/.pending-imports/` (upload stash — never committed)
