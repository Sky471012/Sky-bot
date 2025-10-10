# Baileys Tag Bot — README

A lightweight WhatsApp group utility bot built on **@whiskeysockets/baileys**. It helps you tag everyone or specific subgroups, while safely avoiding self‑mentions and respecting multi‑device JID formats.

---

## Features

* **`!tagall`**: Tag everyone in the current group (excludes the bot automatically).
* **Subgroups**: Create named subgroups (e.g., `design`, `ops`) and tag just those members with `!tagdesign`.
* **Group‑local tagging**: Subgroup tags only ping members who are **present in the current group** (no cross‑group tagging).
* **Owner controls**: Only owners can create/edit subgroups; others can use tag commands in groups.
* **Safe & MD‑ready**: Handles `jid` vs `id` (`@lid`) differences for multi‑device accounts.
* **Rate‑limited mentions**: Sends in batches of 20 with a small delay to avoid throttling.

---

## Quick Start

### Prerequisites

* **Node.js 18+**
* A WhatsApp account to log in with

### Install

```bash
npm init -y
npm install @whiskeysockets/baileys @hapi/boom qrcode-terminal
```

> If you use ESM, ensure your `package.json` includes:

```json
{
  "type": "module"
}
```

### Run

```bash
node index.js
```

* Scan the QR shown in the console to authenticate.

### Config

* **Owner JIDs** (allowed to manage subgroups in DMs and groups):

  ```js
  const OWNER_JIDS = [
    "918929676776@s.whatsapp.net", // your number here
  ];
  ```
* **Prefix** (default `!`):

  ```js
  const PREFIX = "!";
  ```

---

## Command Reference

### 1) `!help`

Shows a summary of supported commands.

**Example:**

```
!help
```

### 2) `!tagall` (group only)

Tags every current member in the group, excluding the bot itself. Mentions are sent in chunks of 20 with a short delay.

**Example:**

```
!tagall
```

**Notes:**

* Self‑tag is prevented via JID normalization and `p.jid || p.id` handling.

### 3) `!tag<name>` (group only)

Tags members of a saved subgroup **who are present in the current group**. Members not in the group are ignored.

**Example:**

```
!tagdesign
```

**Behavior:**

* Looks for a subgroup named `design` in the current group’s DB namespace; falls back to global if not found.
* Intersects saved subgroup JIDs with the current group’s participant list (`p.jid || p.id`).
* Excludes the bot automatically.

### 4) `!group` (owner‑only management)

Manage subgroups via the following subcommands. Only owners (as per `OWNER_JIDS`) can use these.

#### a) `!group add <name> <members>`

Adds mentioned users (in a group) or phone numbers (in DM) to a subgroup.

**Examples:**

```
!group add design @919999999999 @918888888888
!group add ops 919111111111 919222222222
```

#### b) `!group remove <name> <members>`

Removes users from a subgroup.

**Example:**

```
!group remove design @919999999999
```

#### c) `!group show <name>`

Shows the raw saved members of a subgroup for the **current group namespace**.

**Example:**

```
!group show design
```

#### d) `!group list`

Lists all subgroup names with the count of saved members for the current group namespace.

**Example:**

```
!group list
```

#### e) `!group delete <name>`

Deletes the subgroup in the current group namespace.

**Example:**

```
!group delete design
```

---

## How Subgroups Work

* Subgroups are stored in `data/subgroups.json` as a map keyed by **group JID**. There’s also a `global` namespace used as a fallback when tagging.
* **Tagging is group‑local**: `!tag<name>` tags only members present in the current group.
* **Owner‑only edits**: Creating/removing members requires owner privileges.

**Data snapshot (conceptual):**

```json
{
  "1203630xxxxx@g.us": {
    "design": ["91999...@s.whatsapp.net", "91888...@s.whatsapp.net"]
  },
  "global": {
    "design": ["91977...@s.whatsapp.net"]
  }
}
```

---

## Permissions & Safety

* **DMs**: The bot ignores DMs from non‑owners.
* **Groups**: Anyone can use `!tagall` and `!tag<name>`; only owners can use `!group` management.
* **Self‑exclusion**: The bot never tags itself (handles `@lid`, device suffixes `:n`, etc.).
* **Rate limiting**: Mentions are chunked (20 per message) with ~400ms delay to be gentle on WhatsApp.

---

## Multi‑Device / JID Notes

* Participants from Baileys can expose both `p.id` (often `@lid`) and `p.jid` (real `@s.whatsapp.net`).
* The bot always prefers `p.jid || p.id` and normalizes digits for comparisons.

---

## Troubleshooting

* **Bot tags itself**: Ensure you’re mapping members via `p.jid || p.id` and normalize digits from `sock.user.id`/`jid`.
* **Subgroup tags hitting non‑present users**: Confirm the code intersects saved subgroup members with `groupMetadata(remoteJid)` participants.
* **Not receiving QR**: Delete the `auth_info` folder and restart to re‑authenticate.
* **Owners can’t manage**: Verify `OWNER_JIDS` contains the exact full JID (e.g., `919xxxxxxxxx@s.whatsapp.net`).

---

## Extending

* Add a `!whoami` debug command to log how Baileys sees your self JID and a sample of group participants.
* Persist created‑at timestamps per subgroup, or add `!group rename <old> <new>`.
* Add per‑subgroup description/help text for larger teams.

---

## License

MIT (or your preferred license).
